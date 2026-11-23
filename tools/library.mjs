// 素材库看板：把 $DSH_HOME/state/youmind-desk 的板、素材、引用渲染成一个静态页。
// 现在用命令行生成；后续可以做成 DSH 面板常驻。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
const STATE = join(HOME, 'state', 'youmind-desk')
const OUT = process.argv[2] || join(process.cwd(), 'youmind-decks', 'library')
const state = JSON.parse(readFileSync(join(STATE, 'boards.json'), 'utf8'))

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const kindLabel = { url: '网页', file: '文件', text: '文本', transcript: '转写稿' }

function materialOf(id) {
  try {
    return JSON.parse(readFileSync(join(STATE, 'materials', `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

const boards = state.boards.map((b) => ({ ...b, materials: (b.materialRefs || []).map((ref) => materialOf(ref.id)).filter(Boolean) }))
const totalMaterials = boards.reduce((n, b) => n + b.materials.length, 0)
const totalPicks = boards.reduce((n, b) => n + b.picks.length, 0)

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>素材库 · youmind-desk</title>
<style>
:root{--primary:#1D6FE0;--ink:#121A2B;--muted:#55637A;--faint:#8B98AD;--line:#E2E8F0;--teal:#0EA582;--soft:#F7F9FC;--blue:#EEF4FE}
*{box-sizing:border-box}
body{margin:0;background:#F1F5FB;font-family:"Hiragino Sans GB","PingFang SC",sans-serif;color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);padding:22px 40px;position:sticky;top:0;z-index:5}
header h1{margin:0;font-size:22px}
header p{margin:6px 0 0;color:var(--muted);font-size:13px}
.bar{height:5px;background:linear-gradient(90deg,var(--teal) 0 38%,var(--primary) 38%)}
main{max-width:1080px;margin:0 auto;padding:26px 24px 80px}
.board{background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:26px;overflow:hidden}
.board-head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.board-head h2{margin:0;font-size:18px}
.board-head .id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint)}
.board-head .topic{color:var(--muted);font-size:13px;margin-top:4px}
.counts{font-size:12px;color:var(--muted);white-space:nowrap}
.section{padding:16px 22px;border-top:1px solid var(--line)}
.section:first-of-type{border-top:0}
.section h3{margin:0 0 12px;font-size:12px;letter-spacing:1.2px;color:var(--primary);font-weight:700}
.section h3.teal{color:var(--teal)}
.mat{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--soft)}
.mat .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.mat .title{font-weight:700;font-size:14px}
.mat .meta{font-size:11.5px;color:var(--faint)}
.mat .chunks{margin:8px 0 0;font-size:12px;color:var(--muted);line-height:1.6}
.mat code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--primary);background:var(--blue);padding:1px 5px;border-radius:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.loc{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--teal);white-space:nowrap}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;background:#E9F9F4;color:var(--teal)}
.badge.no{background:#FDEEF1;color:#D93B56}
.empty{color:var(--faint);font-size:13px}
footer{max-width:1080px;margin:0 auto;padding:0 24px 40px;color:var(--faint);font-size:11.5px}
</style></head><body>
<div class="bar"></div>
<header>
  <h1>素材库</h1>
  <p>${boards.length} 个板 · ${totalMaterials} 篇素材 · ${totalPicks} 条引用 ｜ 数据：${esc(STATE)}</p>
</header>
<main>
${boards.map((b) => `
  <section class="board" id="${esc(b.id)}">
    <div class="board-head">
      <div>
        <h2>${esc(b.name)} <span class="id">${esc(b.id)}</span></h2>
        ${b.topic ? `<div class="topic">${esc(b.topic)}</div>` : ''}
      </div>
      <div class="counts">素材 ${b.materials.length} · 引用 ${b.picks.length} · 提纲 ${b.briefs.length}</div>
    </div>

    <div class="section">
      <h3>素材 MATERIALS</h3>
      ${b.materials.length ? b.materials.map((m) => `
        <div class="mat">
          <div class="row"><span class="title">${esc(m.title)}</span><span class="meta">${esc(kindLabel[m.kind] || m.kind)} · ${m.chars} 字 · ${m.chunks.length} 块</span></div>
          <div class="meta">${esc(m.id)}${m.url ? ` · ${esc(m.url)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div>
          <p class="chunks">首块：${esc(m.chunks[0] ? m.chunks[0].text.slice(0, 110) : '')}…</p>
        </div>`).join('') : '<p class="empty">还没有素材。用 ym_capture 收一篇。</p>'}
    </div>

    <div class="section">
      <h3 class="teal">引用 PICKS</h3>
      ${b.picks.length ? `<table><thead><tr><th style="width:44px">ID</th><th>原文</th><th style="width:150px">素材 · 位置</th><th style="width:64px">校验</th></tr></thead><tbody>
        ${b.picks.map((p) => `<tr><td class="loc">${esc(p.id)}</td><td>「${esc(p.quote.length > 60 ? p.quote.slice(0, 60) + '…' : p.quote)}」${p.reason ? `<div style="color:var(--faint);font-size:11.5px;margin-top:4px">${esc(p.reason)}</div>` : ''}</td><td class="loc">${esc(p.materialTitle)} · ${esc(p.locationLabel)}</td><td>${p.verified ? '<span class="badge">已校验</span>' : '<span class="badge no">未通过</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">还没有引用。</p>'}
    </div>

    <div class="section">
      <h3>提纲 BRIEFS</h3>
      ${b.briefs.length ? b.briefs.map((d) => `<div class="mat"><div class="row"><span class="title">${esc(d.title)}</span><span class="meta">${esc(d.id)} · ${d.sections.length} 节 · ${d.evidence.length} 条证据</span></div><div class="meta">${esc(d.audience || '')}${d.goal ? ' · ' + esc(d.goal) : ''}</div></div>`).join('') : '<p class="empty">还没有提纲。</p>'}
    </div>
  </section>`).join('\n')}
</main>
<footer>由 youmind-desk 状态目录生成 · 只读快照 · 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</footer>
</body></html>`

mkdirSync(OUT, { recursive: true })
const file = join(OUT, 'index.html')
writeFileSync(file, html, 'utf8')
console.log(file)
