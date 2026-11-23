// youmind-desk / domain.mjs
// YouMind 式创作工作台的领域层：
//   Input   —— URL / 文本 / 本地文件 / 带时间戳的转写稿 → 归一化文本 + 切块索引
//   Process —— Board 持久化上下文 + BM25 检索 + 「找亮点」候选 + 引用校验
//   Output  —— brief（带引用的提纲）→ PPTX + HTML + JSON
//
// 设计约束：
//   - 不编造：亮点只是候选，引用必须能在原文里定位；找不到就明确返回 verified:false
//   - 不假装：音频/视频本身不做 ASR，只接收已有转写稿并保留时间戳对齐
//   - 可核验：每个 chunk 都带原文行号/字符偏移，转写稿还带秒级时间点

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDeck } from './deck.mjs'
import { briefToSlides, dshPptOptions } from './slides.mjs'
import { resolveStyle, listPresets } from './styles.mjs'

const MAX_CHUNK = 900
const MIN_CHUNK = 260
const SNIPPET = 220

// ── 小工具 ────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString()

function collapse(text) {
  return String(text || '').replace(/[ \t\u3000]+/g, ' ').replace(/\s+\n/g, '\n').trim()
}

function countLines(text, offset) {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

function secondsToClock(sec) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${m}:${String(rest).padStart(2, '0')}`
}

function parseClock(value) {
  const parts = String(value).split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

function tokenize(text) {
  const out = []
  const lower = String(text).toLowerCase()
  const latin = lower.match(/[a-z0-9][a-z0-9_+.#-]*/g)
  if (latin) out.push(...latin)
  const cjk = String(text).match(/[\u3400-\u9fff]+/g)
  if (cjk) {
    for (const run of cjk) {
      for (let i = 0; i < run.length; i += 1) {
        out.push(run[i])
        if (i + 1 < run.length) out.push(run.slice(i, i + 2))
      }
    }
  }
  return out
}

function trimSnippet(text, query) {
  const plain = text.replace(/\s+/g, ' ').trim()
  if (plain.length <= SNIPPET) return plain
  const terms = tokenize(query).filter((t) => t.length > 1)
  let at = -1
  for (const term of terms) {
    at = plain.toLowerCase().indexOf(term.toLowerCase())
    if (at >= 0) break
  }
  if (at < 0) return `${plain.slice(0, SNIPPET)}…`
  const start = Math.max(0, at - Math.floor(SNIPPET / 3))
  const end = Math.min(plain.length, start + SNIPPET)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}

function bestSentence(text, query, max = 170) {
  const plain = text.replace(/\s+/g, ' ').trim()
  const terms = tokenize(query).filter((t) => t.length > 1)
  if (!terms.length) return trimSnippet(text, query)
  const parts = plain.split(/(?<=[。！？；!?;])\s*/).filter((p) => p.trim().length > 3)
  let best = null
  for (const part of parts) {
    let hits = 0
    for (const term of terms) if (part.toLowerCase().includes(term.toLowerCase())) hits += 1
    const score = hits / terms.length
    if (!best || score > best.score) best = { part, score }
  }
  if (!best || best.score === 0) return trimSnippet(text, query)
  return best.part.length > max ? `${best.part.slice(0, max)}…` : best.part
}

// ── 文档解析（docx / pdf）─────────────────────────────────────────────────
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

function loadDependency(name) {
  // 1) 先按 Node 自身规则从插件文件往上找（兼容 pnpm / npm 的依赖提升）
  try {
    return createRequire(import.meta.url)(name)
  } catch {
    // 继续显式查找
  }
  const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
  const rawProfile = process.env.DSH_PROFILE_DIR
  const dirs = [
    join(PKG_DIR, 'vendor', 'node_modules'),
    join(PKG_DIR, 'node_modules'),
    rawProfile ? join(isAbsolute(rawProfile) ? rawProfile : resolve(home, rawProfile), 'node_modules') : null,
    join(home, 'profiles', 'web', 'node_modules'),
    join(home, 'profiles', 'desktop', 'node_modules'),
  ].filter(Boolean)
  for (const dir of dirs) {
    try {
      return createRequire(join(dir, '__resolve__.js'))(name)
    } catch {
      // 继续试下一个目录
    }
  }
  throw new Error(`缺少依赖 ${name}：docx 需要 jszip，pdf 需要 pdf-parse（vendor/ 下）`)
}

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

async function extractDocx(file) {
  const JSZip = loadDependency('jszip')
  const zip = await JSZip.loadAsync(readFileSync(file))
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('docx 里找不到 word/document.xml（可能是旧版 .doc，请另存为 .docx）')
  let xml = await entry.async('string')
  xml = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n\n')
  xml = xml.replace(/<[^>]+>/g, '')
  return decodeXml(xml)
}

async function extractPdf(file) {
  const { PDFParse } = loadDependency('pdf-parse')
  const parser = new PDFParse({ data: readFileSync(file) })
  try {
    const result = await parser.getText()
    return { text: result.text || '', pages: result.total || 0 }
  } finally {
    if (typeof parser.destroy === 'function') await parser.destroy()
  }
}

// ── 网页正文抽取（无依赖启发式）────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all)
}

function htmlToText(html) {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, '\n\n## ')
  s = s.replace(/<\/(h[1-6])>/gi, '\n\n')
  s = s.replace(/<(p|div|section|article|li|tr|blockquote)\b[^>]*>/gi, '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/\r\n?/g, '\n')
  s = s.split('\n').map((line) => collapse(line)).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function extractTitle(html, fallback) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og) return decodeEntities(og[1]).trim()
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title) return decodeEntities(title[1]).replace(/\s+/g, ' ').trim()
  return fallback
}

// ── 切块 ──────────────────────────────────────────────────────────────────
function chunkText(materialId, text, { segments } = {}) {
  const chunks = []
  const blocks = text.split(/\n{2,}/)
  let cursor = 0
  let heading = ''
  let current = { text: '', start: 0, heading: '', tStart: null, tEnd: null }

  const flush = () => {
    if (!current.text.trim()) return
    const body = current.text.trim()
    if (body.length < 20 && chunks.length > 0) return
    chunks.push({
      id: `${materialId}.c${chunks.length + 1}`,
      n: chunks.length + 1,
      heading: current.heading,
      text: body,
      charStart: current.start,
      charEnd: current.start + body.length,
      line: countLines(text, current.start),
      tStart: current.tStart,
      tEnd: current.tEnd,
    })
    current = { text: '', start: 0, heading: current.heading, tStart: null, tEnd: null }
  }

  for (const block of blocks) {
    const at = text.indexOf(block, cursor)
    const start = at >= 0 ? at : cursor
    cursor = start + block.length
    const trimmed = block.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('## ')) {
      heading = trimmed.replace(/^##\s+/, '').trim()
      flush()
      current.heading = heading
      continue
    }
    const seg = segments ? segmentAt(segments, start) : null
    if (current.text && current.text.length + trimmed.length > MAX_CHUNK) flush()
    if (!current.text) {
      current.start = start
      current.heading = heading
      current.tStart = seg ? seg.start : null
    }
    current.text += `${current.text ? '\n\n' : ''}${trimmed}`
    if (seg) current.tEnd = seg.end
  }
  flush()

  // 极长单块兜底：按字符窗口再切，最后统一重排 id
  const final = []
  for (const chunk of chunks) {
    if (chunk.text.length <= MAX_CHUNK * 1.6) {
      final.push(chunk)
      continue
    }
    const size = MAX_CHUNK
    for (let i = 0; i < chunk.text.length; i += size) {
      const charStart = chunk.charStart + i
      final.push({
        ...chunk,
        text: chunk.text.slice(i, i + size),
        charStart,
        charEnd: chunk.charStart + Math.min(i + size, chunk.text.length),
        line: countLines(text, charStart),
      })
    }
  }
  return final.map((chunk, i) => ({ ...chunk, id: `${materialId}.c${i + 1}`, n: i + 1 }))
}

function segmentAt(segments, offset) {
  let found = null
  for (const seg of segments) {
    if (seg.charStart <= offset) found = seg
    else break
  }
  return found
}

// ── 转写稿：保留时间戳对齐 ─────────────────────────────────────────────────
function parseTranscript(text) {
  const lines = String(text).split(/\r?\n/)
  const segments = []
  const plain = []
  let cursor = 0
  const stamp = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?)\]?\s*[-–—,，:：]?\s*(.+)$/
  for (const line of lines) {
    const match = stamp.exec(line)
    if (match) {
      const sec = parseClock(match[1])
      const body = match[2].trim()
      if (sec !== null && body) {
        segments.push({ start: sec, end: null, charStart: cursor, text: body })
        plain.push(body)
        cursor += body.length + 1
        continue
      }
    }
    plain.push(line)
    cursor += line.length + 1
  }
  for (let i = 0; i < segments.length; i += 1) segments[i].end = segments[i + 1] ? segments[i + 1].start : segments[i].start + 30
  return { text: plain.join('\n'), segments, hadStamps: segments.length > 0 }
}

// ── 存储 ──────────────────────────────────────────────────────────────────
function createStore(api) {
  const indexPath = api.dataFile('boards.json')
  const materialPath = (id) => api.dataFile(join('materials', `${id}.json`))

  function load() {
    const state = api.readJson(indexPath, null)
    if (!state || !Array.isArray(state.boards)) return { boards: [], seq: { board: 0, material: 0, pick: 0, brief: 0 } }
    state.seq = state.seq || { board: 0, material: 0, pick: 0, brief: 0 }
    return state
  }

  function save(state) {
    api.writeJson(indexPath, state)
  }

  function nextId(state, kind, prefix) {
    state.seq[kind] = (state.seq[kind] || 0) + 1
    return `${prefix}${state.seq[kind]}`
  }

  return {
    load,
    save,
    nextId,
    readMaterial: (id) => api.readJson(materialPath(id), null),
    writeMaterial: (material) => api.writeJson(materialPath(material.id), material),
    materialPath,
  }
}

function findBoard(state, ref) {
  if (!ref) throw new Error('需要 board 参数（Board 名称或 id）。先调用 ym_board(action="list")。')
  const exact = state.boards.find((b) => b.id === ref || b.name === ref)
  if (exact) return exact
  const loose = state.boards.filter((b) => b.name.includes(ref) || ref.includes(b.name))
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) throw new Error(`「${ref}」匹配到多个 Board：${loose.map((b) => `${b.id}/${b.name}`).join('、')}，请用 id。`)
  throw new Error(`没有找到 Board「${ref}」。现有：${state.boards.map((b) => `${b.id}/${b.name}`).join('、') || '（无）'}`)
}

// ── 检索（BM25）───────────────────────────────────────────────────────────
function buildCorpus(state, store, board) {
  const docs = []
  for (const ref of board.materialRefs) {
    const material = store.readMaterial(ref.id)
    if (!material) continue
    for (const chunk of material.chunks) {
      docs.push({
        materialId: material.id,
        materialTitle: material.title,
        kind: material.kind,
        chunk,
        tokens: tokenize(`${chunk.heading} ${chunk.text}`),
      })
    }
  }
  return docs
}

function bm25(docs, query, topK) {
  const q = tokenize(query)
  if (!q.length) return []
  const df = new Map()
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) || 0) + 1)
  }
  const avg = docs.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(1, docs.length)
  const k1 = 1.4
  const b = 0.75
  const scored = docs.map((doc) => {
    const tf = new Map()
    for (const term of doc.tokens) tf.set(term, (tf.get(term) || 0) + 1)
    let score = 0
    for (const term of q) {
      const f = tf.get(term)
      if (!f) continue
      const n = df.get(term) || 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.tokens.length) / Math.max(1, avg))))
    }
    return { doc, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
}

function locationOf(chunk) {
  if (chunk.tStart !== null && chunk.tStart !== undefined) {
    return chunk.tEnd !== null && chunk.tEnd !== undefined
      ? `${secondsToClock(chunk.tStart)}–${secondsToClock(chunk.tEnd)}`
      : secondsToClock(chunk.tStart)
  }
  return `第 ${chunk.line} 行`
}

// ── 引用校验 ──────────────────────────────────────────────────────────────
function findQuote(material, quote) {
  const raw = material.text
  const needle = collapse(quote)
  if (!needle) return null
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(escaped, 'g')
  const hit = re.exec(raw)
  if (!hit) return { found: false }
  const start = hit.index
  const end = start + hit[0].length
  const chunk = material.chunks.find((c) => c.charStart <= start && c.charEnd >= Math.min(end, start + 1))
    || material.chunks.find((c) => c.charStart <= start) || material.chunks[0]
  return {
    found: true,
    start,
    end,
    chunkId: chunk.id,
    line: countLines(raw, start),
    timeStart: chunk.tStart ?? null,
    label: chunk.tStart !== null && chunk.tStart !== undefined ? secondsToClock(chunk.tStart) : `第 ${countLines(raw, start)} 行`,
  }
}

function suggestClosest(material, quote) {
  const terms = new Set(tokenize(quote))
  let best = null
  for (const chunk of material.chunks) {
    const tokens = new Set(tokenize(chunk.text))
    let overlap = 0
    for (const term of terms) if (tokens.has(term)) overlap += 1
    const score = overlap / Math.max(1, terms.size)
    if (!best || score > best.score) best = { score, chunk }
  }
  return best
}

// ── 自动提纲（模型不给 plan 时的兜底）──────────────────────────────────────
function autoPlan(board, brief) {
  const picks = board.picks.filter((p) => p.verified)
  if (!picks.length) {
    return {
      summary: [{ text: '这个 Board 还没有通过校验的引用：先 ym_capture 收素材，再 ym_pick 找亮点并核对原文。', cites: [] }],
      sections: [{ title: '当前 Board 的事实盘点', kicker: '自动兜底', bullets: board.materialRefs.map((m) => ({ text: `${m.title}（${m.chars} 字，${m.kind}）` })) }],
      next: ['补充素材到 Board', '用 ym_pick 逐条校验引用', '把结论改写成 plan 后重新生成'],
    }
  }
  const byMaterial = new Map()
  for (const pick of picks) {
    const list = byMaterial.get(pick.materialId) || []
    list.push(pick)
    byMaterial.set(pick.materialId, list)
  }
  const sections = [...byMaterial.entries()].slice(0, 5).map(([materialId, list]) => {
    const ref = board.materialRefs.find((m) => m.id === materialId)
    return {
      kicker: ref ? ref.kind : '素材',
      title: ref ? ref.title.slice(0, 28) : materialId,
      bullets: list.slice(0, 4).map((p) => ({ text: p.reason || p.quote.slice(0, 40), cites: [p.id] })),
    }
  })
  return {
    summary: picks.slice(0, 3).map((p) => ({ text: (p.reason || p.quote).slice(0, 46), cites: [p.id] })),
    sections,
    next: ['把候选亮点升级为判断，逐条标注「已核实」', '补充反面证据，避免只挑支持性材料', '确认受众与目标后，再改 plan 重新出稿'],
  }
}


function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill'
}

function renderSkillMarkdown(r) {
  const lines = [
    '---',
    `name: ${r.name}`,
    `description: ${r.note || `${r.sections.length} 节结构骨架，含 ${r.rules.length} 条叙事规则`}`,
    '---',
    '',
    `# ${r.name}`,
    '',
    `> 来源：${r.fromBrief}（${String(r.createdAt).slice(0, 10)}）｜ 受众：${r.audience || '未写'} ｜ 目标：${r.goal || '未写'}`,
    '',
    '## 结构骨架',
    '',
    ...r.sections.map((sec, i) => `${i + 1}. **[${sec.kicker || '—'}] ${sec.title}** — ${sec.bulletCount} 条要点${sec.callout ? `；收束句：${sec.callout}` : ''}`),
    '',
    '## 叙事规则',
    '',
    ...(r.rules.length ? r.rules.map((x) => `- ${x}`) : ['- （未写；建议补：标题写成判断句、每页一个观点、不连续三页纯文字）']),
    '',
    '## 视觉令牌',
    '',
    '```json',
    JSON.stringify(r.style && Object.keys(r.style).length ? r.style : { note: '使用默认白蓝风' }, null, 2),
    '```',
    '',
    '## 收尾',
    '',
    `- 三件事：${(r.next || []).join(' / ') || '（未写）'}`,
    r.closingLine ? `- 收尾句：${r.closingLine}` : '',
    '',
    '## 复现提示词',
    '',
    r.prompt ? '```text\n' + r.prompt + '\n```' : '（未保存；可在 save 时用 prompt 参数补上）',
    '',
  ]
  return lines.filter((x) => x !== undefined).join('\n')
}

// ── 插件入口 ──────────────────────────────────────────────────────────────
export function apply(ctx, config, api) {
  const cfg = config || {}
  const store = createStore(api)
  const maxMaterials = Number(cfg.maxMaterialsPerBoard) || 200
  const deckDir = cfg.deckOutputDir || resolve(process.cwd(), 'youmind-decks')
  const recipeFile = api.dataFile('recipes.json')

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }

  // 相对路径按宿主进程 cwd 解析常常不是用户的工作目录：
  // 依次尝试 cwd → config.workspaceDir → DSH_WORKSPACE，取第一个真实存在的。
  const pathRoots = [process.cwd(), cfg.workspaceDir, process.env.DSH_WORKSPACE]
    .filter(Boolean)
    .map((root) => resolve(root))
  function resolveInput(file) {
    const raw = String(file)
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw
    for (const root of pathRoots) {
      const candidate = resolve(root, raw)
      if (existsSync(candidate)) return candidate
    }
    return resolve(pathRoots[0] || '.', raw)
  }

  function summariseBoard(board, state) {
    const lines = [`Board「${board.name}」${board.id}${board.topic ? ` · 主题：${board.topic}` : ''}`]
    lines.push(`素材 ${board.materialRefs.length} 篇 · 引用 ${board.picks.length} 条 · 提纲 ${board.briefs.length} 份`)
    if (board.materialRefs.length) {
      lines.push('', '素材：')
      for (const m of board.materialRefs) {
        lines.push(`- ${m.id}｜${m.title}｜${m.kind}｜${m.chars} 字${m.url ? `｜${m.url}` : ''}`)
      }
    }
    const verified = board.picks.filter((p) => p.verified)
    if (verified.length) {
      lines.push('', `已校验引用（${verified.length}）：`)
      for (const p of verified.slice(-12)) {
        lines.push(`- ${p.id}｜${p.materialTitle} · ${p.locationLabel}｜「${p.quote.slice(0, 42)}${p.quote.length > 42 ? '…' : ''}」`)
      }
    }
    if (board.briefs.length) {
      lines.push('', `提纲（最近）：${board.briefs.slice(-3).map((b) => `${b.id}《${b.title}》`).join('、')}`)
    }
    return lines.join('\n')
  }

  // ── ym_board ────────────────────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_board',
    description: 'YouMind 式工作台：管理 Board（持久化项目上下文，一个主题一个板）。action=create 建板（需要 name，可选 topic）；list 列出所有板；show 查看某板的素材、已校验引用和提纲；update 改主题/名称；delete 删板（需 confirm=true）。素材与引用都挂在板上，跨会话保留。',
    parameters: {
      action: { type: 'string', enum: ['create', 'list', 'show', 'update', 'delete'], required: true, description: '操作类型。' },
      board: { type: 'string', description: 'show/update/delete 用：Board id 或名称。' },
      name: { type: 'string', description: 'create 用：Board 名称（如「AI 创作工具调研」）。' },
      topic: { type: 'string', description: '可选：主题描述，写清用途和受众，后续找亮点会参考。' },
      confirm: { type: 'boolean', description: 'delete 必须显式传 true。' },
    },
    execute: async (args) => {
      const state = store.load()
      if (args.action === 'create') {
        if (!args.name) throw new Error('create 需要 name。')
        const id = store.nextId(state, 'board', 'b')
        const board = { id, name: args.name.trim(), topic: (args.topic || '').trim(), createdAt: nowIso(), updatedAt: nowIso(), materialRefs: [], picks: [], briefs: [] }
        state.boards.push(board)
        store.save(state)
        return `已建 Board ${id}「${board.name}」。下一步：ym_capture 收素材。`
      }
      if (args.action === 'list') {
        if (!state.boards.length) return '还没有 Board。用 ym_board(action="create", name="…") 建一个。'
        return state.boards.map((b) => `- ${b.id}｜${b.name}｜素材 ${b.materialRefs.length}｜引用 ${b.picks.length}｜${b.topic || '（无主题）'}`).join('\n')
      }
      const board = findBoard(state, args.board)
      if (args.action === 'show') return summariseBoard(board, state)
      if (args.action === 'update') {
        if (args.name) board.name = args.name.trim()
        if (args.topic) board.topic = args.topic.trim()
        board.updatedAt = nowIso()
        store.save(state)
        return `已更新 ${board.id}「${board.name}」（主题：${board.topic || '无'}）`
      }
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('delete 需要 confirm=true；素材文件会保留在 materials/ 下。')
        state.boards = state.boards.filter((b) => b.id !== board.id)
        store.save(state)
        return `已删除 Board ${board.id}「${board.name}」。`
      }
      throw new Error(`未知 action：${args.action}`)
    },
  }))

  // ── ym_capture ──────────────────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_capture',
    description: '把素材收进 Board：url 抓网页正文（启发式去导航广告，可能不全，返回时如实标注）；text 直接存文本；file 读本地 .md/.txt/.html/.docx/.pdf（docx 按段落还原，pdf 按文字层解析）；kind=transcript 时保留 [12:34] 时间戳并做对齐，之后引用能跳回时间点。音频/视频本身不做 ASR——需要先有转写稿。写入后自动切块、建索引，返回 material id 与分块数。',
    parameters: {
      board: { type: 'string', required: true, description: '目标 Board（id 或名称）。' },
      url: { type: 'string', description: '网页地址，自动抓正文。' },
      text: { type: 'string', description: '直接给正文（或转写稿）。' },
      file: { type: 'string', description: '本地文件路径（.md/.txt/.html），相对当前工作目录或绝对路径。' },
      title: { type: 'string', description: '自定义标题；省略时取网页 title 或文件名。' },
      note: { type: 'string', description: '给自己留的备注：为什么收这篇、打算用在哪。' },
      kind: { type: 'string', enum: ['auto', 'url', 'text', 'file', 'transcript'], description: '默认 auto。transcript 会解析 [mm:ss] 时间戳。' },
    },
    execute: async (args) => {
      let { url, text, file, kind = 'auto' } = args
      const state = store.load()
      const board = findBoard(state, args.board)
      if (board.materialRefs.length >= maxMaterials) throw new Error(`Board 素材已达上限 ${maxMaterials} 篇。`)

      let title = args.title
      let segments = null
      let pages = 0
      let source = { kind: 'text', url: null }

      if (url) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20000)
        let html
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
            redirect: 'follow',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          html = await response.text()
        } finally {
          clearTimeout(timer)
        }
        title = title || extractTitle(html, new URL(url).hostname)
        text = htmlToText(html)
        kind = 'url'
        source = { kind: 'url', url }
      } else if (file) {
        const path = resolveInput(file)
        if (!existsSync(path)) throw new Error(`文件不存在：${path}（尝试过：${pathRoots.join('、')}；建议直接给绝对路径）`)
        const ext = extname(path).toLowerCase()
        if (ext === '.pdf') {
          const extracted = await extractPdf(path)
          text = extracted.text
          pages = extracted.pages
          title = title || basename(path, ext)
          kind = 'pdf'
          source = { kind: 'file', url: null, path }
        } else if (ext === '.docx') {
          text = await extractDocx(path)
          title = title || basename(path, ext)
          kind = 'docx'
          source = { kind: 'file', url: null, path }
        } else {
          const raw = readFileSync(path, 'utf8')
          text = ext === '.html' || ext === '.htm' ? htmlToText(raw) : raw
          title = title || basename(path, ext)
          kind = 'file'
          source = { kind: 'file', url: null, path }
        }
      }

      if (!text || !text.trim()) throw new Error('没有拿到正文：请提供 url / text / file 之一。')
      if (kind === 'transcript') {
        const parsed = parseTranscript(text)
        text = parsed.text
        segments = parsed.segments
        if (!parsed.hadStamps) {
          // 没时间戳也照收，但明确告知
          segments = null
        }
      }

      text = collapse(text)
      const materialId = store.nextId(state, 'material', 'm')
      const chunks = chunkText(materialId, text, { segments })
      const material = {
        id: materialId,
        title: (title || `素材 ${materialId}`).slice(0, 120),
        kind: kind === 'auto' ? 'text' : kind,
        url: source.url,
        note: args.note || '',
        capturedAt: nowIso(),
        chars: text.length,
        text,
        segments,
        chunks,
      }
      store.writeMaterial(material)
      board.materialRefs.push({
        id: materialId,
        title: material.title,
        kind: material.kind,
        url: material.url,
        chars: material.chars,
        capturedAt: material.capturedAt,
        chunks: chunks.length,
        hasTime: Boolean(segments),
      })
      board.updatedAt = nowIso()
      store.save(state)

      const flags = []
      if (kind === 'url') flags.push('正文为启发式抽取，未做站点级适配；长文可能缺段，引用前请回原文核对')
      if (kind === 'pdf') flags.push(`PDF 按文字层解析（${pages} 页）；扫描件会没有文字，中文也可能缺字或乱序，引用前务必核对`)
      if (kind === 'transcript' && !segments) flags.push('没检测到 [mm:ss] 时间戳：按纯文本切块，无法跳回时间点')
      return [
        `已收入 ${material.id}「${material.title}」→ Board ${board.id}`,
        `类型 ${material.kind}｜${material.chars} 字｜${chunks.length} 块${segments ? `｜${segments.length} 个时间片段` : ''}`,
        args.note ? `备注：${args.note}` : '',
        flags.length ? `注意：${flags.join('；')}` : '',
      ].filter(Boolean).join('\n')
    },
  }))

  // ── ym_search ───────────────────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_search',
    description: '在 Board 的素材里做检索（BM25，中文按字+二元词）。返回带 cite id 的原文片段，每条都含素材、行号或时间点——这是回答问题的证据底座，不要凭记忆补内容。可限定单篇素材。',
    parameters: {
      board: { type: 'string', required: true, description: 'Board id 或名称。' },
      query: { type: 'string', required: true, description: '检索词或一句话问题。' },
      topK: { type: 'number', description: '返回条数，默认 6，最多 20。' },
      material: { type: 'string', description: '可选：只搜某篇素材（m1 这样的 id）。' },
    },
    execute: async (args) => {
      const state = store.load()
      const board = findBoard(state, args.board)
      let docs = buildCorpus(state, store, board)
      if (args.material) docs = docs.filter((d) => d.materialId === args.material)
      if (!docs.length) return '这个 Board 还没有素材。先 ym_capture。'
      const topK = Math.min(20, Math.max(1, Number(args.topK) || 6))
      const hits = bm25(docs, args.query, topK)
      if (!hits.length) return `没有命中「${args.query}」。换个说法，或先用 ym_pick(action="highlights") 看素材整体亮点。`
      return hits.map((hit, i) => {
        const { doc } = hit
        return `${i + 1}. [${doc.chunk.id}] ${doc.materialTitle} · ${locationOf(doc.chunk)} · 分 ${hit.score.toFixed(2)}\n   ${trimSnippet(doc.chunk.text, args.query)}`
      }).join('\n\n')
    },
  }))

  // ── ym_pick（找亮点 + 引用校验）────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_pick',
    description: '「找亮点」与引用校验。action=highlights：逐篇扫素材，给出候选亮点（含量化数据、因果判断、对比或定义，附 cite id 和位置），候选只是线索，要不要用由你判断；action=add：把你选中的原文 quote 存为引用，系统会在原文中逐字定位，找不到就返回 verified=false 并给出最接近的片段（防幻觉）；action=list：看已存引用。',
    parameters: {
      action: { type: 'string', enum: ['highlights', 'add', 'list'], required: true, description: 'highlights=候选亮点；add=存引用并校验；list=已存引用。' },
      board: { type: 'string', required: true, description: 'Board id 或名称。' },
      material: { type: 'string', description: '限定素材 id（highlights 可选；add 可选，省略则跨素材查找）。' },
      query: { type: 'string', description: 'highlights 用：关注点，省略时围绕 Board 主题打分。' },
      limit: { type: 'number', description: 'highlights 返回条数，默认 8。' },
      quote: { type: 'string', description: 'add 用：原文摘录，必须与原文字句一致（允许空白差异）。' },
      reason: { type: 'string', description: 'add 用：你选它的理由，一句话。' },
    },
    execute: async (args) => {
      const state = store.load()
      const board = findBoard(state, args.board)

      if (args.action === 'list') {
        if (!board.picks.length) return '还没有存引用。先用 ym_pick(action="highlights") 找候选。'
        return board.picks.map((p) => `${p.id}｜${p.materialTitle} · ${p.locationLabel}｜${p.verified ? '已校验' : '未校验'}\n   「${p.quote.slice(0, 80)}」${p.reason ? `\n   理由：${p.reason}` : ''}`).join('\n\n')
      }

      if (args.action === 'add') {
        if (!args.quote || args.quote.trim().length < 4) throw new Error('add 需要 quote（原文摘录，至少 4 个字）。')
        const refs = args.material ? board.materialRefs.filter((m) => m.id === args.material) : board.materialRefs
        if (!refs.length) throw new Error('Board 里没有可用的素材。')
        let hit = null
        let hitMaterial = null
        for (const ref of refs) {
          const material = store.readMaterial(ref.id)
          if (!material) continue
          const found = findQuote(material, args.quote)
          if (found && found.found) { hit = found; hitMaterial = material; break }
        }
        if (!hit) {
          // 跨全部素材找最接近的一段，而不是只看第一篇
          let best = null
          for (const ref of refs) {
            const material = store.readMaterial(ref.id)
            if (!material) continue
            const suggestion = suggestClosest(material, args.quote)
            if (suggestion && (!best || suggestion.score > best.score)) best = { ...suggestion, ref }
          }
          return [
            '未通过校验：这段 quote 在原文里找不到逐字匹配，不能当作引用使用。',
            best ? `最接近的原文片段（[${best.chunk.id}] ${best.ref.title} · ${locationOf(best.chunk)}，重合度 ${(best.score * 100).toFixed(0)}%）：` : '',
            best ? `「${trimSnippet(best.chunk.text, args.quote)}」` : '',
            '请从上面片段里原样复制，或先 ym_search 拿到准确原文再 add。',
          ].filter(Boolean).join('\n')
        }
        const id = store.nextId(state, 'pick', 'p')
        const pick = {
          id,
          materialId: hitMaterial.id,
          materialTitle: hitMaterial.title,
          quote: collapse(args.quote),
          reason: args.reason || '',
          verified: true,
          locationLabel: hit.label,
          location: { start: hit.start, end: hit.end, line: hit.line, chunkId: hit.chunkId, time: hit.timeStart },
          createdAt: nowIso(),
        }
        board.picks.push(pick)
        board.updatedAt = nowIso()
        store.save(state)
        return `已存引用 ${id}｜${pick.materialTitle} · ${pick.locationLabel}\n「${pick.quote.slice(0, 80)}${pick.quote.length > 80 ? '…' : ''}」`
      }

      // highlights
      const refs = args.material ? board.materialRefs.filter((m) => m.id === args.material) : board.materialRefs
      if (!refs.length) return 'Board 里还没有素材。'
      const query = args.query || board.topic || board.name
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8))
      const scored = []
      for (const ref of refs) {
        const material = store.readMaterial(ref.id)
        if (!material) continue
        const docs = material.chunks.map((chunk) => ({ chunk, tokens: tokenize(`${chunk.heading} ${chunk.text}`) }))
        const ranked = bm25(docs, query, Math.max(3, Math.ceil(limit / refs.length) + 2))
        const pool = ranked.length ? ranked : docs.map((doc) => ({ doc, score: 0 }))
        for (const entry of pool) {
          const chunk = entry.doc.chunk
          const signals = []
          if (/\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|元|人|天|小时|分钟)/.test(chunk.text)) signals.push('含量化数据')
          if (/(因为|所以|因此|本质|关键在于|前提|结论|意味着)/.test(chunk.text)) signals.push('含因果/判断')
          if (/(不是.{0,12}而是|相比|对比|反过来|然而|但是)/.test(chunk.text)) signals.push('含对比/转折')
          if (/(定义|指的是|即|所谓)/.test(chunk.text)) signals.push('含定义')
          scored.push({ ref, chunk, score: entry.score, signals })
        }
      }
      scored.sort((a, b) => (b.score + b.signals.length * 0.35) - (a.score + a.signals.length * 0.35))
      const top = scored.slice(0, limit)
      if (!top.length) return '素材里没有可切块的内容。'
      return [
        `候选亮点（${top.length} 条；围绕「${query}」；只是线索，用前请判断）：`,
        '',
        ...top.map((item, i) => `${i + 1}. [${item.chunk.id}] ${item.ref.title} · ${locationOf(item.chunk)}${item.signals.length ? ` · ${item.signals.join('/')}` : ''}\n   ${bestSentence(item.chunk.text, query)}`),
        '',
        '确认要用的，逐条 ym_pick(action="add", quote="原文逐字摘录", reason="为什么重要")。',
      ].join('\n')
    },
  }))

  // ── ym_brief ────────────────────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_brief',
    description: '把 Board 里的引用组装成带引用的提纲（deck brief）：summary 三条结论、sections 分页要点、evidence 证据台账、next 下一步；plan 里可选 quote（大字引言）、cards（并列卡片）、flow（四层流程示意图）与 chart（原生条形图，数据必须真实）。建议自己写 plan（模型负责判断与措辞），每条 bullet 用 cites 绑定 pick id；不传 plan 时按已校验引用自动兜底。cites 里出现未知 id 会直接报错。',
    parameters: {
      board: { type: 'string', required: true, description: 'Board id 或名称。' },
      title: { type: 'string', description: '标题；省略用 Board 名称。' },
      subtitle: { type: 'string', description: '副标题/一句话说明。' },
      audience: { type: 'string', description: '讲给谁听。' },
      goal: { type: 'string', description: '这次要达成的目的（决定取舍）。' },
      plan: { type: 'json', description: '自定义提纲：{ summary:[{text,cites}], sections:[{title,kicker,bullets:[{text,cites}],callout}], next:[string], closingLine } 。cites 必须是已存在的 pick id。' },
      save: { type: 'boolean', description: '是否落盘保存，默认 true；false 只预览。' },
      skill: { type: 'string', description: '可选：套用某个已保存的 Skill（ym_recipe），会自动带上它的受众/目标、结构骨架、叙事规则与视觉令牌。' },
      style: { type: 'json', description: '可选：风格预设名（soft / academic / midnight / warm）或自定义令牌对象 {bg,ink,accent,muted,faint,line,soft,font}。' },
    },
    execute: async (args) => {
      const state = store.load()
      const board = findBoard(state, args.board)
      const validPicks = new Map(board.picks.map((p) => [p.id, p]))
      const brief = {
        id: 'draft',
        title: args.title || board.name,
        subtitle: args.subtitle || (board.topic ? board.topic : ''),
        audience: args.audience || '',
        goal: args.goal || '',
        date: new Date().toISOString().slice(0, 10),
        boardId: board.id,
        summary: [],
        sections: [],
        next: [],
        closingLine: '',
      }

      if (args.style) {
        const resolved = resolveStyle(args.style)
        if (resolved) brief.style = resolved
      }

      let appliedSkill = null
      if (args.skill) {
        const recipes = api.readJson(recipeFile, {})
        appliedSkill = recipes[args.skill]
        if (!appliedSkill) throw new Error(`没有找到 Skill「${args.skill}」。先 ym_recipe(action="list")。`)
        brief.skill = args.skill
        brief.audience = brief.audience || appliedSkill.audience || ''
        brief.goal = brief.goal || appliedSkill.goal || ''
        brief.style = brief.style || appliedSkill.style || {}
        brief.rules = appliedSkill.rules || []
      }

      if (!brief.style || !Object.keys(brief.style).length) {
        const preset = resolveStyle(cfg.defaultStyle || 'soft')
        if (preset) brief.style = preset
      }

      let plan = null
      if (args.plan) {
        if (typeof args.plan === 'string') {
          try { plan = JSON.parse(args.plan) } catch { throw new Error('plan 必须是 JSON 对象。') }
        } else plan = args.plan
      }

      const unknown = []
      const checkCites = (cites) => {
        const list = Array.isArray(cites) ? cites : []
        for (const id of list) if (!validPicks.has(id)) unknown.push(id)
        return list.filter((id) => validPicks.has(id))
      }

      if (plan) {
        brief.summary = (plan.summary || []).map((s) => ({ text: String(s.text || ''), cites: checkCites(s.cites) })).filter((s) => s.text)
        brief.sections = (plan.sections || []).map((s) => ({
          title: String(s.title || ''),
          kicker: s.kicker ? String(s.kicker) : '',
          callout: s.callout ? String(s.callout) : '',
          bullets: (s.bullets || []).map((b) => (typeof b === 'string' ? { text: b, cites: [] } : { text: String(b.text || ''), cites: checkCites(b.cites) })).filter((b) => b.text),
        })).filter((s) => s.title)
        brief.next = (plan.next || []).map(String)
        brief.closingLine = plan.closingLine ? String(plan.closingLine) : ''

        if (plan.flow) {
          const steps = (plan.flow.steps || []).slice(0, 4)
            .map((s) => ({ label: String(s.label || ''), sub: String(s.sub || '') }))
            .filter((s) => s.label)
          if (steps.length >= 2) {
            brief.flow = {
              kicker: plan.flow.kicker ? String(plan.flow.kicker) : '',
              title: String(plan.flow.title || '四层能力全景'),
              steps,
              note: plan.flow.note ? String(plan.flow.note) : '',
              caption: plan.flow.caption ? String(plan.flow.caption) : '',
            }
          }
        }

        if (plan.quote && plan.quote.text) {
          brief.quote = {
            text: String(plan.quote.text),
            attribution: plan.quote.attribution ? String(plan.quote.attribution) : '',
            kicker: plan.quote.kicker ? String(plan.quote.kicker) : '',
          }
        }

        if (plan.cards && Array.isArray(plan.cards.items) && plan.cards.items.length) {
          const items = plan.cards.items.slice(0, 6)
            .map((x) => ({ title: String(x.title || ''), desc: String(x.desc || '') }))
            .filter((x) => x.title)
          if (items.length) {
            brief.cards = {
              kicker: plan.cards.kicker ? String(plan.cards.kicker) : '',
              title: String(plan.cards.title || '并列结论'),
              items,
              note: plan.cards.note ? String(plan.cards.note) : '',
            }
          }
        }

        if (plan.chart) {
          const categories = (plan.chart.categories || []).map(String)
          const series = (plan.chart.series || []).map((s) => ({
            name: String(s.name || '数值'),
            values: (s.values || []).map((v) => Number(v)),
          }))
          if (!categories.length || !series.length || series[0].values.length !== categories.length) {
            throw new Error('chart 需要 categories 与 series[0].values 数量一致，且至少一组数据。')
          }
          brief.chart = {
            kicker: plan.chart.kicker ? String(plan.chart.kicker) : '',
            title: String(plan.chart.title || '数据'),
            categories,
            series,
            unit: plan.chart.unit ? String(plan.chart.unit) : '',
            insight: plan.chart.insight ? String(plan.chart.insight) : '',
            caption: plan.chart.caption ? String(plan.chart.caption) : '',
            max: Number(plan.chart.max) || undefined,
          }
        }
      }

      if (unknown.length) {
        throw new Error(`plan 里有不存在的引用 id：${[...new Set(unknown)].join('、')}。现有引用：${[...validPicks.keys()].join('、') || '（无）'}。先 ym_pick(action="add") 再引用。`)
      }

      if (!brief.summary.length && !brief.sections.length) {
        const fallback = autoPlan(board, brief)
        brief.summary = fallback.summary
        brief.sections = fallback.sections
        brief.next = fallback.next
      }

      if (!brief.next.length) brief.next = ['补齐反面证据，避免只挑支持性材料', '把每条结论标为「已核实 / 待核实」', '确认受众与目标后定稿']

      const cited = new Set()
      for (const b of [...brief.summary, ...brief.sections.flatMap((s) => s.bullets)]) for (const id of b.cites) cited.add(id)
      const evidencePicks = board.picks.filter((p) => cited.has(p.id) && p.verified).slice(0, 5)
      brief.evidence = evidencePicks.map((p) => ({
        pickId: p.id,
        quote: p.quote.length > 70 ? `${p.quote.slice(0, 70)}…` : p.quote,
        materialTitle: p.materialTitle,
        locationLabel: p.locationLabel,
      }))
      brief.pickIndex = board.picks.map((p) => ({ id: p.id, materialTitle: p.materialTitle, locationLabel: p.locationLabel, quote: p.quote }))
      brief.footer = 'youmind-desk · 素材可回溯'

      const uncited = [...brief.summary, ...brief.sections.flatMap((s) => s.bullets)].filter((b) => !b.cites.length).length
      if (args.save !== false) {
        const id = store.nextId(state, 'brief', 'd')
        brief.id = id
        brief.createdAt = nowIso()
        board.briefs.push(brief)
        board.updatedAt = nowIso()
        store.save(state)
      }

      const preview = [
        `提纲 ${brief.id}《${brief.title}》｜${brief.sections.length} 节｜${brief.evidence.length} 条证据`,
        `结论 ${brief.summary.length} 条：`,
        ...brief.summary.map((s, i) => `  ${i + 1}. ${s.text}${s.cites.length ? ` [${s.cites.join(',')}]` : '（无引用）'}`),
        ...brief.sections.map((s) => `- ${s.title}（${s.bullets.length} 条${s.bullets.some((b) => b.cites.length) ? '，含引用' : '，无引用'}）`),
        appliedSkill ? `按 Skill「${args.skill}」：${appliedSkill.sections.length} 节骨架、${appliedSkill.rules.length} 条规则、${Object.keys(appliedSkill.style || {}).length ? '已带视觉令牌' : '默认视觉'}。` : '',
        uncited ? `提示：${uncited} 条要点没有引用，页面上会单独标出。` : '全部要点都有引用。',
        args.save === false ? '（未落盘：save=false）' : `下一步：ym_deck(brief="${brief.id}") 出 PPTX。`,
      ]
      return preview.join('\n')
    },
  }))

  // ── ym_style（内置风格预设）──────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_style',
    description: '列出内置风格预设（白蓝汇报 / 象牙纸学术 / 深色技术 / 暖灰品牌），每个含底色、文字、强调色与字体。选中后把名字传给 ym_brief(style="…") 即可。',
    parameters: {},
    execute: async () => ['内置风格（只换令牌，不改版式）：', ...listPresets(), '', '用法：ym_brief(board="…", style="academic")'].join('\n'),
  }))

  // ── ym_recipe（把出稿方法与风格沉淀成可复用 Skill）──────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_recipe',
    description: '把一次满意的出稿沉淀成可复用 Skill：save 从 brief 提炼结构骨架，并可附上叙事规则 rules、视觉令牌 style、复现提示词 prompt；list 列出；show 展开完整清单；export 导出成 SKILL.md 落盘。下次做同类稿前先 show，照骨架与规则填内容。',
    parameters: {
      action: { type: 'string', enum: ['save', 'list', 'show', 'export'], required: true, description: 'save / list / show / export。' },
      name: { type: 'string', description: 'save / show / export 用：Skill 名称，如「领导汇报-四层拆解」。' },
      brief: { type: 'string', description: 'save 用：来源 brief id（如 d1）；省略取最近一份。' },
      note: { type: 'string', description: 'save 用：这套方法适合什么场景。' },
      rules: { type: 'json', description: 'save 用：叙事/版面规则数组，如 ["标题写成判断句","不要连续三页纯文字"]。' },
      style: { type: 'json', description: 'save 用：视觉令牌，如 {"bg":"F2F0E9","ink":"24272A","accent":"8C3738","font":"Songti SC"}。' },
      prompt: { type: 'json', description: 'save 用：可复现的提示词全文（像案例里那 4 组 prompt）。' },
    },
    execute: async (args) => {
      const recipes = api.readJson(recipeFile, {})

      if (args.action === 'list') {
        const keys = Object.keys(recipes)
        if (!keys.length) return '还没有 Skill。先 ym_recipe(action="save", name="…", brief="d1")。'
        return keys.map((k) => {
          const r = recipes[k]
          return `- ${k}｜${r.sections.length} 节｜规则 ${r.rules.length} 条｜风格 ${Object.keys(r.style).length ? '已存' : '默认'}｜来源 ${r.fromBrief}`
        }).join('\n')
      }

      if (args.action === 'show' || args.action === 'export') {
        if (!args.name) throw new Error(`${args.action} 需要 name。`)
        const r = recipes[args.name]
        if (!r) throw new Error(`没有找到 Skill「${args.name}」。现有：${Object.keys(recipes).join('、') || '（无）'}`)
        const md = renderSkillMarkdown(r)
        if (args.action === 'show') return md
        const dir = api.dataFile(join('skills', slugify(args.name)))
        const file = join(dir, 'SKILL.md')
        api.writeText(file, md)
        return `已导出 SKILL.md：${file}`
      }

      if (args.action === 'save') {
        if (!args.name) throw new Error('save 需要 name。')
        const state = store.load()
        let brief = null
        if (args.brief) {
          for (const b of state.boards) {
            const found = b.briefs.find((x) => x.id === args.brief)
            if (found) { brief = found; break }
          }
        } else {
          const all = state.boards.flatMap((b) => b.briefs)
          brief = all[all.length - 1]
        }
        if (!brief) throw new Error('找不到来源 brief：先生成一份提纲，再用 save。')

        const rules = Array.isArray(args.rules)
          ? args.rules.map(String).filter(Boolean)
          : (recipes[args.name]?.rules || [])
        const style = (args.style && typeof args.style === 'object') ? args.style : (recipes[args.name]?.style || brief.style || {})
        const recipe = {
          name: args.name,
          note: args.note || recipes[args.name]?.note || '',
          fromBrief: brief.id,
          audience: brief.audience || '',
          goal: brief.goal || '',
          style,
          rules,
          prompt: typeof args.prompt === 'string' ? args.prompt : (recipes[args.name]?.prompt || ''),
          sections: brief.sections.map((sec) => ({
            title: sec.title,
            kicker: sec.kicker || '',
            bulletCount: sec.bullets.length,
            callout: sec.callout || '',
          })),
          next: brief.next || [],
          closingLine: brief.closingLine || '',
          createdAt: recipes[args.name]?.createdAt || nowIso(),
          updatedAt: nowIso(),
        }
        recipes[args.name] = recipe
        api.writeJson(recipeFile, recipes)
        return [
          `已保存 Skill「${args.name}」`,
          `结构 ${recipe.sections.length} 节 · 规则 ${rules.length} 条 · 风格 ${Object.keys(style).length ? Object.keys(style).join('/') : '默认'}`,
          `查看：ym_recipe(action="show", name="${args.name}")；导出：action="export"`,
        ].join('\n')
      }
      throw new Error(`未知 action：${args.action}`)
    },
  }))

  // ── ym_slides（借用 dsh-ppt 的版式库）──────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_slides',
    description: '把 brief 转成 dsh-ppt 的 ppt_create 参数：返回可直接传参的 JSON（theme/brand/slides），并落盘一份。用于借用 dsh-ppt 的更多版式（cover / bullets / quote / table / chart / closing）。拿到返回值后调用 ppt_create(slides=…, theme=…, brand=…)。',
    parameters: {
      brief: { type: 'string', required: true, description: 'brief id（如 d1）。' },
      theme: { type: 'string', description: 'dsh-ppt 主题，默认 soft。' },
      footer: { type: 'string', description: '页脚文案，默认「youmind-desk · 引用可回溯」。' },
      outputDir: { type: 'string', description: 'payload 落盘目录，默认 <deckDir>/dshppt。' },
    },
    execute: async (args) => {
      const state = store.load()
      let brief = null
      for (const board of state.boards) {
        const found = board.briefs.find((b) => b.id === args.brief)
        if (found) { brief = found; break }
      }
      if (!brief) throw new Error(`没有找到 brief「${args.brief}」。先 ym_brief。`)
      const payload = { ...dshPptOptions(brief, { theme: args.theme, footer: args.footer }), slides: briefToSlides(brief) }
      const outDir = args.outputDir ? resolve(args.outputDir) : join(deckDir, 'dshppt')
      mkdirSync(outDir, { recursive: true })
      const file = join(outDir, `${brief.id}.slides.json`)
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
      return JSON.stringify(payload)
    },
  }))

  // ── ym_deck ─────────────────────────────────────────────────────────────
  ctx.tools.register(api.tool({
    name: 'ym_deck',
    description: '把 brief 渲染成三件套：可编辑 .pptx + 单文件 .html 放映 + .json 工程。16:9、白底、主色 #1D6FE0、Hiragino Sans GB；每页带出处脚注与页码，演讲者备注写口径。默认输出到 <工作目录>/youmind-decks。',
    parameters: {
      brief: { type: 'string', description: 'brief id（如 d1）；省略时用该 Board 最近一份。' },
      board: { type: 'string', description: 'brief 省略时用：Board id 或名称。' },
      fileName: { type: 'string', description: '文件名（不含扩展名）。' },
      outputDir: { type: 'string', description: '输出目录，默认 <cwd>/youmind-decks。' },
    },
    execute: async (args) => {
      const state = store.load()
      let brief = null
      if (args.brief) {
        for (const board of state.boards) {
          const found = board.briefs.find((b) => b.id === args.brief)
          if (found) { brief = found; break }
        }
        if (!brief) throw new Error(`没有找到 brief「${args.brief}」。先 ym_brief。`)
      } else {
        const board = findBoard(state, args.board)
        brief = board.briefs[board.briefs.length - 1]
        if (!brief) throw new Error('这个 Board 还没有 brief。先 ym_brief。')
      }
      const outDir = args.outputDir ? resolve(args.outputDir) : deckDir
      const result = await buildDeck({ brief, outDir, fileName: args.fileName || brief.title })
      return [
        `已生成 ${result.slideCount} 页：`,
        `PPTX  ${result.pptxPath}`,
        `HTML  ${result.htmlPath}`,
        `JSON  ${result.jsonPath}`,
        '未做视觉验收：PPTX 需在 PowerPoint/WPS 打开确认为准；上述路径可直接点开核对。',
      ].join('\n')
    },
  }))

  // 启动自检：让 /youmind-desk 状态可被读到
  try {
    const state = store.load()
    if (state.boards.length) {
      api.log(`已有 ${state.boards.length} 个 Board，${state.boards.reduce((n, b) => n + b.picks.length, 0)} 条引用`)
    }
  } catch (error) {
    api.log(`状态读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
