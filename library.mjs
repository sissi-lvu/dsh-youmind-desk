// 素材库只读页面：从状态目录现读现渲染，供浏览器里实时查看（收一篇刷新即可）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const KIND = { url: '网页', file: '文件', text: '文本', transcript: '转写稿', pdf: 'PDF', docx: 'Word' }

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function renderLibrary(stateDir) {
  const state = readJson(join(stateDir, 'boards.json'), { boards: [] })
  const boards = (state.boards || []).map((b) => ({
    ...b,
    materials: (b.materialRefs || []).map((ref) => readJson(join(stateDir, 'materials', `${ref.id}.json`), null)).filter(Boolean),
  }))
  const totalMaterials = boards.reduce((n, b) => n + b.materials.length, 0)
  const totalPicks = boards.reduce((n, b) => n + b.picks.length, 0)

  const body = boards.length ? boards.map((b) => `
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
          <div class="row"><span class="title">${esc(m.title)}</span><span class="meta">${esc(KIND[m.kind] || m.kind)} · ${m.chars} 字 · ${(m.chunks || []).length} 块</span></div>
          <div class="meta">${esc(m.id)}${m.url ? ` · ${esc(m.url)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div>
          <p class="chunks">首块：${esc((m.chunks && m.chunks[0] ? m.chunks[0].text : '').slice(0, 110))}…</p>
        </div>`).join('') : '<p class="empty">还没有素材。用 ym_capture 收一篇。</p>'}
    </div>

    <div class="section">
      <h3 class="teal">引用 PICKS</h3>
      ${b.picks.length ? `<table><thead><tr><th style="width:44px">ID</th><th>原文</th><th style="width:190px">素材 · 位置</th><th style="width:64px">校验</th></tr></thead><tbody>
        ${b.picks.map((p) => `<tr><td class="loc">${esc(p.id)}</td><td>「${esc(p.quote.length > 70 ? `${p.quote.slice(0, 70)}…` : p.quote)}」${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ''}</td><td class="loc">${esc(p.materialTitle)} · ${esc(p.locationLabel)}</td><td>${p.verified ? '<span class="badge">已校验</span>' : '<span class="badge no">未通过</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">还没有引用。</p>'}
    </div>

    <div class="section">
      <h3>提纲 BRIEFS</h3>
      ${b.briefs.length ? b.briefs.map((d) => `<div class="mat"><div class="row"><span class="title">${esc(d.title)}</span><span class="meta">${esc(d.id)} · ${(d.sections || []).length} 节 · ${(d.evidence || []).length} 条证据</span></div><div class="meta">${esc(d.audience || '')}${d.goal ? ` · ${esc(d.goal)}` : ''}</div></div>`).join('') : '<p class="empty">还没有提纲。</p>'}
    </div>
  </section>`).join('\n') : '<p class="empty" style="padding:40px">还没有 Board。</p>'

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>素材库 · youmind-desk</title>
<style>
:root{--primary:#1D6FE0;--ink:#121A2B;--muted:#55637A;--faint:#8B98AD;--line:#E2E8F0;--teal:#0EA582;--soft:#F7F9FC;--blue:#EEF4FE}
*{box-sizing:border-box}
body{margin:0;background:#F1F5FB;font-family:"Hiragino Sans GB","PingFang SC",sans-serif;color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);padding:20px 40px;position:sticky;top:0;z-index:5}
header h1{margin:0;font-size:21px}
header p{margin:6px 0 0;color:var(--muted);font-size:13px}
.bar{height:5px;background:linear-gradient(90deg,var(--teal) 0 38%,var(--primary) 38%)}
main{max-width:1080px;margin:0 auto;padding:24px 24px 80px}
.board{background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:24px;overflow:hidden}
.board-head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.board-head h2{margin:0;font-size:18px}
.board-head .id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint)}
.topic{color:var(--muted);font-size:13px;margin-top:4px}
.counts{font-size:12px;color:var(--muted);white-space:nowrap}
.section{padding:16px 22px;border-top:1px solid var(--line)}
.section:first-of-type{border-top:0}
.section h3{margin:0 0 12px;font-size:12px;letter-spacing:1.2px;color:var(--primary);font-weight:700}
.section h3.teal{color:var(--teal)}
.mat{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--soft)}
.mat .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.mat .title{font-weight:700;font-size:14px}
.meta{font-size:11.5px;color:var(--faint)}
.chunks{margin:8px 0 0;font-size:12px;color:var(--muted);line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.loc{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--teal);white-space:nowrap}
.why{color:var(--faint);font-size:11.5px;margin-top:4px}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;background:#E9F9F4;color:var(--teal)}
.badge.no{background:#FDEEF1;color:#D93B56}
.empty{color:var(--faint);font-size:13px}
footer{max-width:1080px;margin:0 auto;padding:0 24px 40px;color:var(--faint);font-size:11.5px}
</style></head><body>
<div class="bar"></div>
<header>
  <h1>素材库</h1>
  <p>${boards.length} 个板 · ${totalMaterials} 篇素材 · ${totalPicks} 条引用 ｜ 刷新本页即可看到最新</p>
</header>
<main>${body}</main>
<footer>youmind-desk · 只读视图 · 数据目录 ${esc(stateDir)} · 渲染于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</footer>
</body></html>`
}
