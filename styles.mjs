// 内置风格预设：只换令牌，不改版式。
// 每套覆盖底色/文字/强调/辅助色/字体；版式由 deck.mjs 统一渲染。

export const STYLE_PRESETS = {
  soft: {
    label: '白蓝 · 汇报',
    bg: 'FFFFFF', ink: '121A2B', accent: '1D6FE0',
    muted: '55637A', faint: '8B98AD', line: 'E2E8F0', soft: 'F7F9FC',
    font: 'Hiragino Sans GB',
  },
  academic: {
    label: '象牙纸 · 学术',
    bg: 'F2F0E9', ink: '24272A', accent: '8C3738',
    muted: '5A5A55', faint: '8C8A80', line: 'D8D2C4', soft: 'EFEBE1',
    font: 'Songti SC',
  },
  midnight: {
    label: '深色 · 技术',
    bg: '121A2B', ink: 'F1F5F9', accent: '38BDF8',
    muted: 'A8B3C4', faint: '6B7A90', line: '2A3446', soft: '1A2438',
    font: 'PingFang SC',
  },
}

export function resolveStyle(input) {
  if (!input) return null
  if (typeof input === 'string') {
    const preset = STYLE_PRESETS[input]
    if (!preset) {
      throw new Error(`没有这个风格预设：${input}。可用：${Object.keys(STYLE_PRESETS).join(' / ')}`)
    }
    return { ...preset }
  }
  if (typeof input === 'object') return { ...input }
  return null
}

export function listPresets() {
  return Object.entries(STYLE_PRESETS).map(([id, s]) => `- ${id}｜${s.label}｜底色 #${s.bg}｜强调 #${s.accent}｜${s.font}`)
}
