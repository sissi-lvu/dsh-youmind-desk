// youmind-desk / deck.mjs
// 输出层：把「带引用的 brief」渲染成可编辑 PPTX + 单文件 HTML 放映 + JSON 工程。
//
// 纪律（与用户的 PPT 偏好一致）：
//   - 16:9、白底、主色 #1D6FE0、正文 #121A2B、字体 Hiragino Sans GB
//   - 每页一个观点；要点 ≤ 6 条；引用落到「素材 + 位置」
//   - 示意图与原生图表各至少一页；示意必须标注
//   - 没有出处的数字不编：图表数据来自 brief.chart，由调用方负责真实

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOKENS = {
  primary: '1D6FE0',
  ink: '121A2B',
  muted: '55637A',
  faint: '8B98AD',
  line: 'E2E8F0',
  teal: '0EA582',
  orange: 'E07B0A',
  bg: 'FFFFFF',
  soft: 'F7F9FC',
  softBlue: 'EEF4FE',
  font: 'Hiragino Sans GB',
}

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

const W = 10
const H = 5.625
const MARGIN = 0.62
let LAYOUT = 'default'
const M = () => (LAYOUT === 'academic' ? 0.92 : MARGIN)


const DEFAULT_TOKENS = { ...TOKENS }
const STYLE_MAP = { bg: 'bg', ink: 'ink', accent: 'primary', muted: 'muted', faint: 'faint', line: 'line', soft: 'soft', font: 'font' }

function applyStyle(style) {
  for (const key of Object.keys(STYLE_MAP)) {
    if (style && style[key]) TOKENS[STYLE_MAP[key]] = String(style[key])
    else TOKENS[STYLE_MAP[key]] = DEFAULT_TOKENS[STYLE_MAP[key]]
  }
}

function loadPptxGenJS() {
  const errors = []
  // 1) 随包携带（最稳：不依赖宿主的 node_modules 布局）
  try {
    return createRequire(join(PKG_DIR, 'vendor', 'node_modules', '__resolve__.js'))('pptxgenjs')
  } catch (error) {
    errors.push(`包内 vendor: ${error instanceof Error ? error.message : String(error)}`)
  }
  // 2) 安装时装的依赖（兼容 pnpm / npm 提升）
  try {
    return createRequire(import.meta.url)('pptxgenjs')
  } catch (error) {
    errors.push(`安装依赖: ${error instanceof Error ? error.message : String(error)}`)
  }
  // 3) 宿主 profile（DSH_PROFILE_DIR 可能是相对路径，按 DSH_HOME 解析）
  const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
  const rawProfile = process.env.DSH_PROFILE_DIR
  const profileDirs = [
    rawProfile ? (isAbsolute(rawProfile) ? rawProfile : resolve(home, rawProfile)) : null,
    join(home, 'profiles', 'web'),
    join(home, 'profiles', 'desktop'),
    join(PKG_DIR, 'node_modules'),
  ].filter(Boolean)
  for (const dir of profileDirs) {
    try {
      return createRequire(join(dir, '__resolve__.js'))('pptxgenjs')
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    '未找到 pptxgenjs（生成 PPTX 需要）。插件包内应自带 vendor，若被删了请重装 0.3.3+；'
    + '也可以执行 `npm i pptxgenjs`。查找过：\n' + errors.join('\n'),
  )
}

const pad = (n) => (n < 10 ? `0${n}` : String(n))
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const MARKS = '①②③④⑤⑥⑦⑧⑨⑩'

/** 一页内：cites → ①…⑩，并把用到的来源排成脚注。 */
function decorate(bullets, brief) {
  const order = []
  for (const b of bullets || []) for (const id of b.cites || []) if (!order.includes(id)) order.push(id)
  const store = new Map(order.map((id, i) => [id, MARKS[i] || `(${i + 1})`]))
  const picks = new Map((brief.pickIndex || []).map((p) => [p.id, p]))
  const decorated = (bullets || []).map((b) => ({
    ...b,
    marks: (b.cites || []).map((id) => store.get(id)).filter(Boolean).join(''),
  }))
  const refs = order.map((id, i) => {
    const p = picks.get(id)
    const label = p ? `${p.materialTitle}${p.locationLabel ? ` · ${p.locationLabel}` : ''}` : id
    return `${MARKS[i] || ''} ${label}`.trim()
  })
  return { bullets: decorated, refs }
}

function chrome(slide, { page, total, source, footer }) {
  if (LAYOUT === 'academic') {
    slide.addShape('line', { x: M(), y: 0.44, w: W - 2 * M(), h: 0, line: { color: TOKENS.primary, width: 0.75 } })
    const note = source ? `来源：${source}` : footer || ''
    if (note) {
      slide.addText(note, {
        x: M(), y: H - 0.44, w: W - 2 * M() - 0.5, h: 0.2,
        fontSize: 7, color: TOKENS.faint, fontFace: TOKENS.font,
      })
    }
    slide.addText(String(page), {
      x: W - M() - 0.5, y: H - 0.44, w: 0.5, h: 0.2,
      fontSize: 7, color: TOKENS.faint, align: 'right', fontFace: TOKENS.font,
    })
    return
  }
  slide.addShape('rect', { x: 0, y: 0, w: W * 0.38, h: 0.055, fill: { color: TOKENS.teal }, line: { color: TOKENS.teal } })
  slide.addShape('rect', { x: W * 0.38, y: 0, w: W * 0.62, h: 0.055, fill: { color: TOKENS.primary }, line: { color: TOKENS.primary } })
  const text = source ? `来源：${source}` : footer || ''
  if (text) {
    slide.addText(text, {
      x: MARGIN, y: H - 0.4, w: W - 2 * MARGIN - 0.75, h: 0.22,
      fontSize: 7.5, color: TOKENS.faint, fontFace: TOKENS.font, valign: 'middle',
    })
  }
  slide.addText(`${page} / ${total}`, {
    x: W - MARGIN - 0.7, y: H - 0.4, w: 0.7, h: 0.22,
    fontSize: 7.5, color: TOKENS.faint, align: 'right', fontFace: TOKENS.font, valign: 'middle',
  })
}

function head(slide, { kicker, title, kickerColor }) {
  if (LAYOUT === 'academic') {
    if (kicker) {
      slide.addText(kicker, {
        x: M(), y: 0.62, w: W - 2 * M(), h: 0.26,
        fontSize: 10, color: kickerColor || TOKENS.primary, charSpacing: 2.2, fontFace: TOKENS.font,
      })
    }
    slide.addText(title, {
      x: M(), y: 0.94, w: W - 2 * M(), h: 0.95,
      fontSize: 29, bold: true, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 38,
    })
    return
  }
  if (kicker) {
    slide.addText(kicker, {
      x: MARGIN, y: 0.46, w: W - 2 * MARGIN, h: 0.26,
      fontSize: 10, color: kickerColor || TOKENS.primary, bold: true, charSpacing: 1.4, fontFace: TOKENS.font,
    })
  }
  slide.addText(title, {
    x: MARGIN, y: 0.76, w: W - 2 * MARGIN, h: 0.6,
    fontSize: 23, bold: true, color: TOKENS.ink, fontFace: TOKENS.font,
  })
}

// ── 各类版式 ──────────────────────────────────────────────────────────────
function coverSlide(pptx, brief, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  if (LAYOUT === 'academic') {
    const m = 0.92
    slide.addText(brief.kicker || '一份可核对的材料', {
      x: m, y: 1.45, w: W - 2 * m, h: 0.3,
      fontSize: 11, color: TOKENS.primary, charSpacing: 3.2, fontFace: TOKENS.font,
    })
    slide.addText(brief.title, {
      x: m, y: 1.85, w: W - 2 * m, h: 2.0,
      fontSize: 40, bold: true, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 52,
    })
    slide.addShape('line', { x: m, y: 4.02, w: 1.4, h: 0, line: { color: TOKENS.primary, width: 0.9 } })
    if (brief.subtitle) {
      slide.addText(brief.subtitle, {
        x: m, y: 4.14, w: W - 2 * m, h: 0.4,
        fontSize: 14, color: TOKENS.muted, fontFace: TOKENS.font,
      })
    }
    const meta = [brief.audience ? `对象：${brief.audience}` : '', brief.date || todayIso()].filter(Boolean).join('   ·   ')
    slide.addText(meta, {
      x: m, y: H - 0.95, w: W - 2 * m, h: 0.3,
      fontSize: 9.5, color: TOKENS.faint, fontFace: TOKENS.font,
    })
    slide.addNotes(`开场：${brief.goal || '用可核对的素材讲清一个判断'}。`)
    return slide
  }
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.09, fill: { color: TOKENS.teal }, line: { color: TOKENS.teal } })
  slide.addShape('rect', { x: 0, y: 0.09, w: W * 0.55, h: 0.09, fill: { color: TOKENS.primary }, line: { color: TOKENS.primary } })
  slide.addText(brief.kicker || '素材驱动 · 引用可回溯', {
    x: MARGIN, y: 1.2, w: W - 2 * MARGIN, h: 0.3,
    fontSize: 12, color: TOKENS.primary, bold: true, charSpacing: 1.5, fontFace: TOKENS.font,
  })
  slide.addText(brief.title, {
    x: MARGIN, y: 1.58, w: W - 2 * MARGIN, h: 1.2,
    fontSize: 34, bold: true, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 42,
  })
  if (brief.subtitle) {
    slide.addText(brief.subtitle, {
      x: MARGIN, y: 2.86, w: W - 2 * MARGIN, h: 0.5,
      fontSize: 15, color: TOKENS.muted, fontFace: TOKENS.font,
    })
  }
  slide.addShape('line', { x: MARGIN, y: 3.6, w: 1.1, h: 0, line: { color: TOKENS.primary, width: 2.5 } })
  slide.addText(brief.audience ? `对象：${brief.audience}` : '', {
    x: MARGIN, y: 3.76, w: 5, h: 0.3,
    fontSize: 10.5, color: TOKENS.muted, fontFace: TOKENS.font,
  })
  slide.addText(brief.date || todayIso(), {
    x: W - MARGIN - 2.2, y: H - 0.62, w: 2.2, h: 0.3,
    fontSize: 10, color: TOKENS.faint, align: 'right', fontFace: TOKENS.font,
  })
  slide.addShape('rect', { x: 0, y: H - 0.14, w: W, h: 0.14, fill: { color: TOKENS.softBlue }, line: { color: TOKENS.softBlue } })
  slide.addNotes(`开场：${brief.goal || '用可核对的素材讲清一个判断'}。\n引用编号可回到原文位置；素材出处见各页页脚。`)
  return slide
}

function summarySlide(pptx, brief, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  const { bullets, refs } = decorate(brief.summary || [], brief)
  chrome(slide, { page: ctx.page, total: ctx.total, source: refs.join('；') || ctx.footer })
  head(slide, { kicker: '结论先行', title: brief.summaryTitle || '三句话讲完这份材料' })
  bullets.slice(0, 4).forEach((bullet, i) => {
    const y = 1.66 + i * 0.88
    slide.addShape('rect', { x: MARGIN, y, w: 0.055, h: 0.62, fill: { color: i === 0 ? TOKENS.primary : TOKENS.teal }, line: { color: i === 0 ? TOKENS.primary : TOKENS.teal } })
    slide.addText(`${bullet.text} ${bullet.marks}`.trim(), {
      x: MARGIN + 0.2, y, w: W - 2 * MARGIN - 0.28, h: 0.62,
      fontSize: 15, color: TOKENS.ink, fontFace: TOKENS.font, valign: 'middle',
    })
  })
  slide.addNotes(`口径：三条结论均来自本 Board 素材。${refs.length ? `引用：${refs.join('；')}` : ''}`)
  return slide
}

/** 大字引言：一句原文 + 出处 */
function quoteSlide(pptx, brief, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  chrome(slide, { page: ctx.page, total: ctx.total, source: '', footer: ctx.footer })
  if (brief.quote.kicker) {
    slide.addText(brief.quote.kicker, {
      x: MARGIN, y: 0.9, w: W - 2 * MARGIN, h: 0.3,
      fontSize: 10.5, color: TOKENS.teal, bold: true, charSpacing: 1.4, fontFace: TOKENS.font,
    })
  }
  slide.addText('“', {
    x: MARGIN - 0.02, y: 1.1, w: 1.2, h: 1.0,
    fontSize: 72, bold: true, color: TOKENS.primary, fontFace: TOKENS.font,
  })
  slide.addText(brief.quote.text, {
    x: MARGIN + 0.8, y: 1.3, w: W - 2 * MARGIN - 1.0, h: 2.7,
    fontSize: 28, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 44, valign: 'middle',
  })
  slide.addShape('line', {
    x: MARGIN + 0.8, y: 3.95, w: 1.0, h: 0,
    line: { color: TOKENS.primary, width: 2.5 },
  })
  slide.addText(brief.quote.attribution || '', {
    x: MARGIN + 0.8, y: 4.08, w: W - 2 * MARGIN - 1.0, h: 0.32,
    fontSize: 11, color: TOKENS.muted, fontFace: TOKENS.font,
  })
  slide.addNotes(`这一页只用原文，不加解释。出处：${brief.quote.attribution || '见页脚'}。`)
  return slide
}

/** 卡片：2–6 张并列观点 */
function cardsSlide(pptx, brief, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  const cards = brief.cards
  const items = (cards.items || []).slice(0, 6)
  chrome(slide, { page: ctx.page, total: ctx.total, source: cards.note || '', footer: ctx.footer })
  head(slide, { kicker: cards.kicker, title: cards.title })
  const cols = items.length <= 4 ? 2 : 3
  const rows = Math.ceil(items.length / cols)
  const gapX = 0.24
  const gapY = 0.2
  const w = (W - 2 * MARGIN - gapX * (cols - 1)) / cols
  const h = 1.12
  const top = 1.55
  items.forEach((item, i) => {
    const r = Math.floor(i / cols)
    const c = i % cols
    const x = MARGIN + c * (w + gapX)
    const y = top + r * (h + gapY)
    slide.addShape('roundRect', {
      x, y, w, h, rectRadius: 0.06,
      fill: { color: TOKENS.soft }, line: { color: TOKENS.line },
    })
    slide.addShape('rect', {
      x, y, w: 0.055, h,
      fill: { color: i % 2 === 0 ? TOKENS.primary : TOKENS.teal },
      line: { color: i % 2 === 0 ? TOKENS.primary : TOKENS.teal },
    })
    slide.addText(item.title || '', {
      x: x + 0.22, y: y + 0.14, w: w - 0.4, h: 0.32,
      fontSize: 13.5, bold: true, color: TOKENS.ink, fontFace: TOKENS.font,
    })
    slide.addText(item.desc || '', {
      x: x + 0.22, y: y + 0.5, w: w - 0.4, h: h - 0.62,
      fontSize: 9.5, color: TOKENS.muted, fontFace: TOKENS.font, lineSpacing: 14,
    })
  })
  slide.addNotes(cards.note || `并列 ${items.length} 项，每项一句判断。`)
  return slide
}

/** 四层流程示意图：Input → Process → Agent → Output */
function flowSlide(pptx, brief, ctx) {
  const flow = brief.flow
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  chrome(slide, { page: ctx.page, total: ctx.total, source: flow.caption || '', footer: ctx.footer })
  head(slide, { kicker: flow.kicker || '全景', title: flow.title })
  const steps = (flow.steps || []).slice(0, 4)
  const gap = 0.42
  const boxW = (W - 2 * MARGIN - gap * (steps.length - 1)) / Math.max(1, steps.length)
  const top = 1.7
  const boxH = 1.9
  const colors = [TOKENS.teal, TOKENS.primary, '6B46D6', TOKENS.orange]
  steps.forEach((step, i) => {
    const x = MARGIN + i * (boxW + gap)
    slide.addShape('roundRect', {
      x, y: top, w: boxW, h: boxH, rectRadius: 0.06,
      fill: { color: TOKENS.soft }, line: { color: TOKENS.line },
    })
    slide.addShape('rect', { x, y: top, w: boxW, h: 0.06, fill: { color: colors[i % colors.length] }, line: { color: colors[i % colors.length] } })
    slide.addText(step.label, {
      x: x + 0.16, y: top + 0.22, w: boxW - 0.32, h: 0.4,
      fontSize: 14.5, bold: true, color: TOKENS.ink, fontFace: TOKENS.font,
    })
    slide.addText(step.sub || '', {
      x: x + 0.16, y: top + 0.72, w: boxW - 0.32, h: boxH - 0.9,
      fontSize: 9.5, color: TOKENS.muted, fontFace: TOKENS.font, lineSpacing: 14,
    })
    if (i < steps.length - 1) {
      slide.addText('→', {
        x: x + boxW + 0.02, y: top + boxH / 2 - 0.2, w: gap - 0.04, h: 0.4,
        fontSize: 15, color: TOKENS.faint, align: 'center', fontFace: TOKENS.font,
      })
    }
  })
  if (flow.note) {
    slide.addText(flow.note, {
      x: MARGIN, y: top + boxH + 0.16, w: W - 2 * MARGIN, h: 0.3,
      fontSize: 10.5, color: TOKENS.primary, fontFace: TOKENS.font,
    })
  }
  slide.addNotes(`示意图：${(flow.steps || []).map((s) => s.label).join(' → ')}。${flow.caption ? `\n出处：${flow.caption}` : ''}`)
  return slide
}

function sectionSlide(pptx, brief, section, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  const { bullets, refs } = decorate(section.bullets || [], brief)
  if (LAYOUT === 'academic') {
    const m = 0.92
    chrome(slide, { page: ctx.page, total: ctx.total, source: refs.join('；') || ctx.footer })
    head(slide, { kicker: section.kicker, title: section.title })
    let y = 2.15
    bullets.slice(0, 6).forEach((bullet) => {
      slide.addText('—', {
        x: m, y, w: 0.24, h: 0.3,
        fontSize: 13, color: TOKENS.primary, fontFace: TOKENS.font,
      })
      slide.addText(`${bullet.text} ${bullet.marks}`.trim(), {
        x: m + 0.34, y, w: W - 2 * m - 0.34, h: 0.62,
        fontSize: 13.5, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 22,
      })
      y += 0.92
    })
    if (section.callout) {
      slide.addText(section.callout, {
        x: m + 0.34, y: H - 1.25, w: W - 2 * m - 0.34, h: 0.5,
        fontSize: 11.5, italic: true, color: TOKENS.primary, fontFace: TOKENS.font,
      })
    }
    slide.addNotes(`要点口径：${section.title}。${refs.length ? `出处：${refs.join('；')}` : '本页无直接引用，为综合判断。'}`)
    return slide
  }
  chrome(slide, { page: ctx.page, total: ctx.total, source: refs.join('；') || ctx.footer })
  head(slide, { kicker: section.kicker, title: section.title, kickerColor: TOKENS.teal })
  const size = bullets.length >= 4 ? 14 : 15.5
  const lineH = bullets.length >= 4 ? 0.62 : 0.7
  let y = 1.62
  bullets.slice(0, 6).forEach((bullet) => {
    slide.addText('▪', {
      x: MARGIN, y: y + 0.01, w: 0.2, h: 0.3,
      fontSize: size, color: TOKENS.primary, bold: true, fontFace: TOKENS.font,
    })
    slide.addText(`${bullet.text} ${bullet.marks}`.trim(), {
      x: MARGIN + 0.24, y, w: W - 2 * MARGIN - 0.24, h: lineH,
      fontSize: size, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: Math.round(size * 1.5),
    })
    y += lineH + 0.22
  })
  if (section.callout) {
    const callY = Math.max(y + 0.12, H - 1.15)
    slide.addShape('roundRect', {
      x: MARGIN, y: callY, w: W - 2 * MARGIN, h: 0.58, rectRadius: 0.06,
      fill: { color: TOKENS.softBlue }, line: { color: TOKENS.softBlue },
    })
    slide.addText(section.callout, {
      x: MARGIN + 0.18, y: callY, w: W - 2 * MARGIN - 0.36, h: 0.58,
      fontSize: 11.5, color: TOKENS.primary, fontFace: TOKENS.font, valign: 'middle',
    })
  }
  slide.addNotes(`要点口径：${section.title}。${refs.length ? `出处：${refs.join('；')}` : '本页无直接引用，为综合判断。'}`)
  return slide
}

/** 原生图表：横向条形，数据由 brief.chart 提供 */
function chartSlide(pptx, brief, ctx) {
  const chart = brief.chart
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  chrome(slide, { page: ctx.page, total: ctx.total, source: chart.caption || '', footer: ctx.footer })
  head(slide, { kicker: chart.kicker || '数据', title: chart.title })
  const series = (chart.series && chart.series[0]) || { name: '数值', values: [] }
  slide.addChart('bar', [{
    name: series.name,
    labels: chart.categories || [],
    values: series.values || [],
  }], {
    x: MARGIN + 0.1, y: 1.55, w: W - 2 * MARGIN - 0.6, h: 2.75,
    barDir: 'bar',
    chartColors: [TOKENS.primary],
    showLegend: false,
    showValue: true,
    dataLabelPosition: 'outEnd',
    dataLabelColor: TOKENS.ink,
    dataLabelFontSize: 10,
    dataLabelFontFace: TOKENS.font,
    catAxisLabelColor: TOKENS.muted,
    catAxisLabelFontSize: 10,
    catAxisLabelFontFace: TOKENS.font,
    valAxisLabelColor: TOKENS.faint,
    valAxisLabelFontSize: 9,
    valAxisLabelFontFace: TOKENS.font,
    valGridLine: { style: 'dash', color: TOKENS.line, size: 0.5 },
    catGridLine: { style: 'none' },
    valAxisMaxVal: chart.max || undefined,
    valAxisTitle: chart.unit || '',
    showValAxisTitle: Boolean(chart.unit),
    valAxisTitleColor: TOKENS.faint,
    valAxisTitleFontSize: 9,
    barGapWidthPct: 55,
  })
  if (chart.insight) {
    slide.addText(chart.insight, {
      x: MARGIN, y: 4.42, w: W - 2 * MARGIN, h: 0.34,
      fontSize: 11, color: TOKENS.primary, fontFace: TOKENS.font,
    })
  }
  slide.addNotes(`图表数据：${(chart.categories || []).map((c, i) => `${c} ${series.values[i]}`).join('，')}${chart.unit ? `（${chart.unit}）` : ''}。${chart.caption ? `出处：${chart.caption}` : ''}`)
  return slide
}

function evidenceSlide(pptx, brief, ctx) {
  const items = (brief.evidence || []).slice(0, 5)
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  chrome(slide, { page: ctx.page, total: ctx.total, source: '逐条摘录，位置可回原文核对', footer: ctx.footer })
  head(slide, { kicker: '证据台账', title: '每个结论都能回到原文', kickerColor: TOKENS.teal })
  const header = ['#', '原文摘录', '素材', '位置'].map((t) => ({
    text: t,
    options: { bold: true, color: 'FFFFFF', fill: { color: TOKENS.primary }, fontSize: 10.5, fontFace: TOKENS.font },
  }))
  const rows = [header]
  items.forEach((item, i) => {
    const zebra = i % 2 === 1 ? { fill: { color: TOKENS.soft } } : {}
    rows.push([
      { text: String(i + 1), options: { ...zebra, color: TOKENS.muted, fontSize: 10, fontFace: TOKENS.font } },
      { text: item.quote, options: { ...zebra, color: TOKENS.ink, fontSize: 9.5, fontFace: TOKENS.font } },
      { text: item.materialTitle, options: { ...zebra, color: TOKENS.muted, fontSize: 9, fontFace: TOKENS.font } },
      { text: item.locationLabel || '—', options: { ...zebra, color: TOKENS.faint, fontSize: 8.5, fontFace: TOKENS.font } },
    ])
  })
  slide.addTable(rows, {
    x: MARGIN, y: 1.58, w: W - 2 * MARGIN,
    colW: [0.4, 4.9, 2.1, 1.35],
    rowH: 0.44,
    border: { type: 'solid', color: TOKENS.line, pt: 0.6 },
    valign: 'middle',
    autoPage: false,
  })
  slide.addNotes(`证据口径：逐条摘录，可对照原文核对；共 ${items.length} 条。`)
  return slide
}

function closingSlide(pptx, brief, ctx) {
  const slide = pptx.addSlide()
  slide.background = { color: TOKENS.bg }
  chrome(slide, { page: ctx.page, total: ctx.total, source: '', footer: ctx.footer })
  slide.addText(brief.closingTitle || '下一步', {
    x: MARGIN, y: 0.86, w: W - 2 * MARGIN, h: 0.6,
    fontSize: 25, bold: true, color: TOKENS.ink, fontFace: TOKENS.font,
  })
  const steps = (brief.next || []).slice(0, 3)
  const gap = 0.18
  const w = (W - 2 * MARGIN - gap * (steps.length - 1)) / Math.max(1, steps.length)
  steps.forEach((step, i) => {
    const x = MARGIN + i * (w + gap)
    slide.addShape('roundRect', { x, y: 1.7, w, h: 2.2, rectRadius: 0.06, fill: { color: TOKENS.soft }, line: { color: TOKENS.line } })
    slide.addShape('rect', { x, y: 1.7, w, h: 0.06, fill: { color: i === 0 ? TOKENS.primary : TOKENS.teal }, line: { color: i === 0 ? TOKENS.primary : TOKENS.teal } })
    slide.addText(`0${i + 1}`, {
      x: x + 0.2, y: 1.92, w: 1, h: 0.4,
      fontSize: 18, bold: true, color: TOKENS.faint, fontFace: TOKENS.font,
    })
    slide.addText(step, {
      x: x + 0.2, y: 2.32, w: w - 0.4, h: 1.4,
      fontSize: 12, color: TOKENS.ink, fontFace: TOKENS.font, lineSpacing: 19,
    })
  })
  slide.addText(brief.closingLine || '先把「有出处的事实」摆上桌，再谈判断。', {
    x: MARGIN, y: 4.12, w: W - 2 * MARGIN, h: 0.34,
    fontSize: 11.5, italic: true, color: TOKENS.muted, fontFace: TOKENS.font,
  })
  slide.addNotes(brief.closingNote || '收尾：先对齐事实，再确认下一步责任人。')
  return slide
}

// ── HTML 放映 ─────────────────────────────────────────────────────────────
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function htmlSlide(item, index, total) {
  const body = (inner) => `<section class="slide" data-i="${index}"><div class="bar"></div>${inner}<footer><span>${esc(item.source || (item.refs || []).join('；'))}</span><span>${index + 1} / ${total}</span></footer></section>`
  const title = `<h2>${esc(item.title)}</h2>`

  if (item.type === 'cover') {
    return `<section class="slide cover" data-i="0"><div class="bar"></div>
      <p class="kicker">${esc(item.kicker || '素材驱动 · 引用可回溯')}</p>
      <h2>${esc(item.title)}</h2>
      ${item.note ? `<p class="sub">${esc(item.note)}</p>` : ''}
      <p class="meta">${esc(item.source || '')}${item.date ? ` · ${esc(item.date)}` : ''}</p>
      <footer><span>youmind-desk</span><span>1 / ${total}</span></footer></section>`
  }
  if (item.type === 'summary' || item.type === 'section') {
    const list = item.bullets.map((b) => `<li>${esc(b.text)}${b.marks ? `<sup>${b.marks}</sup>` : ''}</li>`).join('')
    return body(`${item.kicker ? `<p class="kicker${item.type === 'section' ? ' teal' : ''}">${esc(item.kicker)}</p>` : ''}
      ${title}<ul class="tight">${list}</ul>
      ${item.note ? `<p class="callout">${esc(item.note)}</p>` : ''}`)
  }
  if (item.type === 'quote') {
    return `<section class="slide quote" data-i="${index}"><div class="bar"></div>
      ${item.kicker ? `<p class="kicker teal">${esc(item.kicker)}</p>` : ''}
      <blockquote>“${esc(item.text)}”</blockquote>
      <p class="attrib">${esc(item.attribution || '')}</p>
      <footer><span></span><span>${index + 1} / ${total}</span></footer>
    </section>`
  }
  if (item.type === 'cards') {
    const items = item.items || []
    const cols = items.length <= 4 ? 2 : 3
    const cards = items.map((c) => `<div class="cbox"><h3>${esc(c.title)}</h3><p>${esc(c.desc || '')}</p></div>`).join('')
    return body(`<p class="kicker">${esc(item.kicker || '')}</p>${title}<div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${cards}</div>${item.note ? `<p class="callout">${esc(item.note)}</p>` : ''}`)
  }
  if (item.type === 'flow') {
    const steps = (item.steps || []).map((s, i) => `<div class="box"><span class="tag c${i}"></span><h3>${esc(s.label)}</h3><p>${esc(s.sub || '')}</p></div>${i < item.steps.length - 1 ? '<span class="arrow">→</span>' : ''}`).join('')
    return body(`<p class="kicker">${esc(item.kicker || '全景')}</p>${title}<div class="flow">${steps}</div>${item.note ? `<p class="callout">${esc(item.note)}</p>` : ''}`)
  }
  if (item.type === 'chart') {
    const max = Math.max(...(item.values || [1]))
    const bars = (item.categories || []).map((c, i) => `<div class="row"><span class="cat">${esc(c)}</span><div class="track"><div class="fill" style="width:${(item.values[i] / max) * 100}%"></div></div><span class="val">${item.values[i]}${esc(item.unit || '')}</span></div>`).join('')
    return body(`<p class="kicker">${esc(item.kicker || '数据')}</p>${title}<div class="chart">${bars}</div>${item.insight ? `<p class="callout">${esc(item.insight)}</p>` : ''}`)
  }
  if (item.type === 'evidence') {
    const rows = (item.rows || []).map((r, i) => `<tr>${r.map((cell, j) => `<td${j === 1 ? ' class="quote"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('')
    return body(`<p class="kicker teal">证据台账</p>${title}<table><thead><tr><th>#</th><th>原文摘录</th><th>素材</th><th>位置</th></tr></thead><tbody>${rows}</tbody></table>`)
  }
  if (item.type === 'closing') {
    const cards = (item.steps || []).map((s, i) => `<div class="card"><span class="num">0${i + 1}</span><p>${esc(s)}</p></div>`).join('')
    return body(`${title}<div class="cards">${cards}</div>${item.note ? `<p class="callout">${esc(item.note)}</p>` : ''}`)
  }
  return body(title)
}

function renderHtml(brief, meta) {
  const data = JSON.stringify(brief).replace(/</g, '\\u003c')
  const total = meta.length
  const slides = meta.map((item, i) => htmlSlide(item, i, total)).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brief.title)}</title>
<style>
:root{--font:"${TOKENS.font}";--paper:#${TOKENS.bg};--primary:#${TOKENS.primary};--ink:#${TOKENS.ink};--muted:#${TOKENS.muted};--faint:#${TOKENS.faint};--line:#${TOKENS.line};--teal:#${TOKENS.teal};--soft:#${TOKENS.soft};--softblue:#${TOKENS.softBlue}}
*{box-sizing:border-box}
body{margin:0;background:#EDF1F7;font-family:var(--font),"PingFang SC",sans-serif;color:var(--ink)}
.deck{position:relative;width:min(100vw,1280px);aspect-ratio:16/9;margin:24px auto;background:var(--paper);box-shadow:0 12px 40px rgba(15,23,42,.12);overflow:hidden}
.slide{position:absolute;inset:0;padding:50px 62px 42px;display:none;flex-direction:column}
.slide.active{display:flex}
.bar{position:absolute;top:0;left:0;right:0;height:6px;background:linear-gradient(90deg,var(--teal) 0 38%,var(--primary) 38%)}
.academic .bar{top:26px;left:62px;right:62px;height:0;border-top:1px solid var(--primary);background:none}
.academic .kicker,.academic .kicker.teal{color:var(--primary);letter-spacing:2.6px;font-weight:600}
.academic ul.tight li{padding-left:30px;font-size:24px;line-height:1.6}
.academic ul.tight li:before{content:"—";background:none;width:auto;height:auto;top:0;left:0;color:var(--primary);font-size:19px}
.academic .callout{background:none;padding:0;margin-top:26px;font-style:italic;color:var(--primary);font-size:15px}
.academic .attrib{border-left:1px solid var(--primary)}
.academic .meta{border-left:none;padding-left:0}
.academic .meta:before{content:"";display:inline-block;width:14px;height:1px;background:var(--primary);vertical-align:middle;margin-right:10px}
.kicker{margin:0 0 8px;font-size:13.5px;letter-spacing:1.6px;color:var(--primary);font-weight:700}
.kicker.teal{color:var(--teal)}
h2{margin:0 0 24px;font-size:38px;line-height:1.26;max-width:1120px}
ul{padding:0;list-style:none;margin:0;display:flex;flex-direction:column;justify-content:flex-start;flex:1}
ul.tight li{position:relative;padding-left:26px;margin-bottom:22px;font-size:25px;line-height:1.55}
ul.tight li:before{content:"";position:absolute;left:0;top:.58em;width:8px;height:8px;background:var(--primary);border-radius:2px}
sup{font-size:11px;color:var(--primary);margin-left:4px}
.callout{margin:22px 0 0;background:var(--softblue);color:var(--primary);padding:13px 18px;border-radius:8px;font-size:17px}
footer{position:absolute;left:62px;right:62px;bottom:16px;display:flex;justify-content:space-between;gap:24px;font-size:10.5px;color:var(--faint)}
footer span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cover{justify-content:center}
.cover h2{font-size:54px;max-width:960px;margin-bottom:18px}
.cover .kicker{margin-bottom:12px}
.sub{margin:0 0 20px;font-size:23px;color:var(--muted);max-width:780px}
.meta{margin:0;font-size:15px;color:var(--faint);border-left:4px solid var(--primary);padding-left:14px}
.flow{display:flex;align-items:center;margin-top:6px;flex:1;max-height:260px}
.flow .box{flex:1;min-width:0;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:22px 16px 16px;position:relative;min-height:215px}
.flow .tag{position:absolute;top:0;left:0;right:0;height:5px;border-radius:8px 8px 0 0;background:var(--teal)}
.flow .tag.c1{background:var(--primary)}.flow .tag.c2{background:#6B46D6}.flow .tag.c3{background:#E07B0A}
.flow h3{margin:8px 0 12px;font-size:21px}
.flow p{margin:0;font-size:15px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}
.flow .arrow{align-self:center;color:var(--faint);font-size:20px;padding:0 8px}
.chart{margin:6px 0 0;flex:1;display:flex;flex-direction:column;justify-content:flex-start}
.chart .row{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.chart .cat{width:150px;text-align:right;font-size:19px;color:var(--muted)}
.chart .track{flex:1;height:34px;background:var(--soft);border-radius:4px;overflow:hidden}
.chart .fill{height:100%;background:var(--primary);border-radius:4px}
.chart .val{width:64px;font-size:19px;color:var(--ink);font-weight:700}
table{width:100%;border-collapse:collapse;font-size:15px;margin-top:4px;table-layout:fixed}
th{background:var(--primary);color:#fff;text-align:left;padding:10px 12px;font-weight:600}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th:nth-child(1),td:nth-child(1){width:6%}
th:nth-child(2),td:nth-child(2){width:56%}
th:nth-child(3),td:nth-child(3){width:24%}
th:nth-child(4),td:nth-child(4){width:14%}
tr:nth-child(even) td{background:var(--soft)}
.cards{display:flex;gap:16px;margin-top:8px;flex:1;max-height:230px;align-items:stretch}
.cards .card{flex:1;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:18px;min-height:175px}
.cards .num{font-size:22px;font-weight:700;color:var(--faint)}
.cards p{margin:10px 0 0;font-size:17px;line-height:1.6}
.slide.quote{justify-content:center}
blockquote{margin:8px 0 0;font-size:36px;line-height:1.55;color:var(--ink);max-width:1060px}
.attrib{margin:20px 0 0;color:var(--muted);font-size:14px;border-left:3px solid var(--primary);padding-left:12px}
.grid{display:grid;gap:16px;margin-top:10px;grid-auto-rows:min-content}
.cbox{background:var(--soft);border:1px solid var(--line);border-left:4px solid var(--primary);border-radius:8px;padding:16px 18px}
.cbox h3{margin:0 0 8px;font-size:17px}
.cbox p{margin:0;font-size:13.5px;color:var(--muted);line-height:1.6}
.hint{text-align:center;color:var(--faint);font-size:12px}
</style></head><body class="${brief.style && brief.style.layout === 'academic' ? 'academic' : ''}">
<main class="deck">${slides}</main>
<p class="hint">← / → 翻页 · 共 ${total} 页</p>
<script id="brief" type="application/json">${data}</script>
<script>
const slides=[...document.querySelectorAll('.slide')];let i=0;
function show(n){i=(n+slides.length)%slides.length;slides.forEach((s,k)=>s.classList.toggle('active',k===i))}
show(0);
addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1)});
</script>
</body></html>`
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'youmind-deck'
}

/**
 * 渲染三件套。
 * @returns {{pptxPath:string, htmlPath:string, jsonPath:string, slideCount:number}}
 */
export async function buildDeck({ brief, outDir, fileName }) {
  // 风格令牌：brief.style 覆盖默认白蓝风（底色/文字/强调/字体）。
  // 只改参数，不改版式；版式差异仍是后续工作。
  applyStyle(brief.style)
  LAYOUT = brief.style && brief.style.layout === 'academic' ? 'academic' : 'default'
  const PptxGenJS = loadPptxGenJS()
  mkdirSync(outDir, { recursive: true })
  const base = safeName(fileName || brief.title || 'youmind-deck')
  const pptxPath = join(outDir, `${base}.pptx`)
  const htmlPath = join(outDir, `${base}.html`)
  const jsonPath = join(outDir, `${base}.json`)

  const sections = brief.sections || []
  const hasSummary = (brief.summary || []).length > 0
  const hasQuote = Boolean(brief.quote && brief.quote.text)
  const hasFlow = Boolean(brief.flow && (brief.flow.steps || []).length)
  const hasCards = Boolean(brief.cards && (brief.cards.items || []).length)
  const hasChart = Boolean(brief.chart && (brief.chart.categories || []).length)
  const hasEvidence = (brief.evidence || []).length >= 2
  const total = 1 + (hasSummary ? 1 : 0) + (hasQuote ? 1 : 0) + (hasFlow ? 1 : 0) + sections.length + (hasCards ? 1 : 0) + (hasChart ? 1 : 0) + (hasEvidence ? 1 : 0) + 1

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.author = 'youmind-desk'
  pptx.company = 'DeepSeek Harness'
  pptx.title = brief.title

  const meta = []
  let page = 1
  const footer = brief.footer || 'youmind-desk · 素材可回溯'

  coverSlide(pptx, brief, {})
  meta.push({
    type: 'cover', kicker: brief.kicker, title: brief.title, note: brief.subtitle,
    source: brief.audience ? `对象：${brief.audience}` : '', date: brief.date || todayIso(),
  })

  if (hasSummary) {
    page += 1
    summarySlide(pptx, brief, { page, total, footer })
    const summaryDeco = decorate(brief.summary || [], brief)
    meta.push({
      type: 'summary', kicker: '结论先行', title: brief.summaryTitle || '三句话讲完这份材料',
      bullets: summaryDeco.bullets, refs: summaryDeco.refs,
    })
  }

  if (hasQuote) {
    page += 1
    quoteSlide(pptx, brief, { page, total, footer })
    meta.push({
      type: 'quote', kicker: brief.quote.kicker || '', text: brief.quote.text,
      attribution: brief.quote.attribution || '',
    })
  }

  if (hasFlow) {
    page += 1
    flowSlide(pptx, brief, { page, total, footer })
    meta.push({
      type: 'flow', kicker: brief.flow.kicker, title: brief.flow.title,
      steps: brief.flow.steps, note: brief.flow.note, source: brief.flow.caption || '',
    })
  }

  for (const section of sections) {
    page += 1
    sectionSlide(pptx, brief, section, { page, total, footer })
    const deco = decorate(section.bullets || [], brief)
    meta.push({
      type: 'section', kicker: section.kicker, title: section.title,
      bullets: deco.bullets, note: section.callout, refs: deco.refs,
    })
  }

  if (hasCards) {
    page += 1
    cardsSlide(pptx, brief, { page, total, footer })
    meta.push({
      type: 'cards', kicker: brief.cards.kicker || '', title: brief.cards.title || '并列结论',
      items: (brief.cards.items || []).slice(0, 6), note: brief.cards.note || '',
    })
  }

  if (hasChart) {
    page += 1
    chartSlide(pptx, brief, { page, total, footer })
    const series = (brief.chart.series && brief.chart.series[0]) || { values: [] }
    meta.push({
      type: 'chart', kicker: brief.chart.kicker, title: brief.chart.title,
      categories: brief.chart.categories, values: series.values, unit: brief.chart.unit || '',
      insight: brief.chart.insight, source: brief.chart.caption || '',
    })
  }

  if (hasEvidence) {
    page += 1
    evidenceSlide(pptx, brief, { page, total, footer })
    meta.push({
      type: 'evidence', title: '每个结论都能回到原文',
      rows: (brief.evidence || []).slice(0, 5).map((item, i) => [String(i + 1), item.quote, item.materialTitle, item.locationLabel || '—']),
    })
  }

  page += 1
  closingSlide(pptx, brief, { page, total, footer })
  meta.push({
    type: 'closing', title: brief.closingTitle || '下一步',
    steps: brief.next || [], note: brief.closingLine,
  })

  await pptx.writeFile({ fileName: pptxPath })
  writeFileSync(htmlPath, renderHtml(brief, meta), 'utf8')
  writeFileSync(jsonPath, `${JSON.stringify({ brief, meta }, null, 2)}\n`, 'utf8')

  return { pptxPath, htmlPath, jsonPath, slideCount: total }
}
