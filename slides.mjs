// brief → dsh-ppt 的 slides 参数（借用它的版式库：cover / bullets / quote / chart / table / closing）
// 原则：只做形状映射，不改内容；引用一律落到「素材 · 位置」。

const clip = (text, max = 56) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function briefToSlides(brief, options = {}) {
  const picks = new Map((brief.pickIndex || []).map((p) => [p.id, p]))
  const cite = (bullet) => {
    const text = String(bullet.text || '').trim()
    const refs = (bullet.cites || [])
      .map((id) => picks.get(id))
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => `${p.materialTitle} · ${p.locationLabel}`)
    return refs.length ? `${text}〔${refs.join('；')}〕` : text
  }

  const slides = []
  slides.push({
    layout: 'cover',
    kicker: brief.kicker || '素材驱动 · 引用可回溯',
    title: brief.title,
    subtitle: brief.subtitle || '',
  })

  if ((brief.summary || []).length) {
    slides.push({
      layout: 'bullets',
      kicker: '结论先行',
      title: brief.summaryTitle || '三句话讲完这份材料',
      bullets: brief.summary.map(cite),
      notes: `口径：结论均来自本 Board 素材；括号内为出处位置。`,
    })
  }

  // 一页大字引言：挑第一条带理由的引用，展示 quote 版式
  const quotePick = (brief.pickIndex || []).find((p) => p.quote && p.quote.length <= 90)
  if (quotePick) {
    slides.push({
      layout: 'quote',
      text: quotePick.quote,
      attribution: `${quotePick.materialTitle} · ${quotePick.locationLabel}`,
      notes: '这一页只用原文，不加解释；解释放在下一页。',
    })
  }

  for (const section of brief.sections || []) {
    slides.push({
      layout: 'bullets',
      kicker: section.kicker || '',
      title: section.title,
      bullets: (section.bullets || []).map(cite),
      notes: section.callout || '',
    })
  }

  if (brief.chart && (brief.chart.categories || []).length) {
    const series = brief.chart.series && brief.chart.series[0]
    slides.push({
      layout: 'chart',
      kicker: brief.chart.kicker || '数据',
      title: brief.chart.title,
      chart: {
        kind: 'bar',
        categories: brief.chart.categories,
        series: [{ name: series?.name || '数值', values: series?.values || [] }],
        unit: brief.chart.unit || '',
        caption: brief.chart.caption || '',
      },
      notes: brief.chart.insight || '',
    })
  }

  if ((brief.evidence || []).length >= 2) {
    const rows = [['#', '原文摘录', '素材', '位置']]
    brief.evidence.slice(0, 8).forEach((item, i) => {
      rows.push([String(i + 1), clip(item.quote), clip(item.materialTitle, 20), item.locationLabel || '—'])
    })
    slides.push({
      layout: 'table',
      kicker: '证据台账',
      title: '每个结论都能回到原文',
      rows,
      notes: '逐条摘录，可对照原文核对。',
    })
  }

  if ((brief.next || []).length) {
    slides.push({
      layout: 'closing',
      title: brief.closingTitle || '下一步',
      bullets: brief.next,
      notes: brief.closingLine || '收尾：先对齐事实，再确认下一步责任人。',
    })
  }

  return slides
}

export function dshPptOptions(brief, options = {}) {
  return {
    title: brief.title,
    theme: options.theme || 'soft',
    lang: 'zh',
    motion: options.motion || 'on',
    brand: {
      primaryColor: '#1D6FE0',
      backgroundColor: '#FFFFFF',
      textColor: '#121A2B',
      fontFamily: 'Hiragino Sans GB',
      footer: options.footer || 'youmind-desk · 引用可回溯',
    },
  }
}
