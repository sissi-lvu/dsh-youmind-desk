#!/usr/bin/env node
// 命令行版 Skill 管理：与插件共用 $DSH_HOME/state/youmind-desk/recipes.json。
// 插件热加载前也能用；重启后 ym_recipe 直接读同一份数据。
//
//   node tools/skill.mjs list
//   node tools/skill.mjs show "领导汇报-四层拆解"
//   node tools/skill.mjs save "领导汇报-四层拆解" --brief d1 --note "给高管的四层拆解" \
//        --rules '["标题写成判断句","每页一个观点"]' --style '{"bg":"F2F0E9"}'
//   node tools/skill.mjs export "领导汇报-四层拆解"

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const HOME = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
const STATE = join(HOME, 'state', 'youmind-desk')
const RECIPES = join(STATE, 'recipes.json')
const BOARDS = join(STATE, 'boards.json')

const load = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d)
const save = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)) }
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill'

const [action, name, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
}

const recipes = load(RECIPES, {})

function render(r) {
  return [
    '---',
    `name: ${r.name}`,
    `description: ${r.note || `${r.sections.length} 节结构骨架`}`,
    '---',
    '',
    `# ${r.name}`,
    '',
    `> 来源：${r.fromBrief}（${String(r.createdAt).slice(0, 10)}）｜受众：${r.audience || '未写'}｜目标：${r.goal || '未写'}`,
    '',
    '## 结构骨架',
    ...r.sections.map((s, i) => `${i + 1}. **[${s.kicker || '—'}] ${s.title}** — ${s.bulletCount} 条要点${s.callout ? `；收束句：${s.callout}` : ''}`),
    '',
    '## 叙事规则',
    ...(r.rules.length ? r.rules.map((x) => `- ${x}`) : ['- （未写）']),
    '',
    '## 视觉令牌',
    '```json',
    JSON.stringify(r.style && Object.keys(r.style).length ? r.style : { note: '默认白蓝风' }, null, 2),
    '```',
    '',
    '## 收尾',
    `- 三件事：${(r.next || []).join(' / ') || '（未写）'}`,
    r.closingLine ? `- 收尾句：${r.closingLine}` : '',
    '',
    '## 复现提示词',
    r.prompt ? '```text\n' + r.prompt + '\n```' : '（未保存）',
  ].filter((x) => x !== '').join('\n')
}

if (action === 'list') {
  const keys = Object.keys(recipes)
  console.log(keys.length ? keys.map((k) => `- ${k}｜${recipes[k].sections.length} 节｜规则 ${recipes[k].rules.length} 条｜${recipes[k].fromBrief}`).join('\n') : '还没有 Skill。')
} else if (action === 'show' || action === 'export') {
  const r = recipes[name]
  if (!r) { console.error(`没有 Skill：${name}`); process.exit(1) }
  const md = render(r)
  if (action === 'show') console.log(md)
  else {
    const file = join(STATE, 'skills', slugify(name), 'SKILL.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, md)
    console.log(file)
  }
} else if (action === 'save') {
  if (!name) { console.error('save 需要名字'); process.exit(1) }
  const boards = load(BOARDS, { boards: [] }).boards
  const briefId = flags.brief
  let brief = null
  if (briefId) {
    for (const b of boards) { const f = b.briefs.find((x) => x.id === briefId); if (f) { brief = f; break } }
  } else {
    const all = boards.flatMap((b) => b.briefs)
    brief = all[all.length - 1]
  }
  if (!brief) { console.error('找不到 brief；先生成一份提纲。'); process.exit(1) }
  const prev = recipes[name] || {}
  recipes[name] = {
    name,
    note: flags.note || prev.note || '',
    fromBrief: brief.id,
    audience: brief.audience || '',
    goal: brief.goal || '',
    style: flags.style ? JSON.parse(flags.style) : (prev.style || brief.style || {}),
    rules: flags.rules ? JSON.parse(flags.rules) : (prev.rules || []),
    prompt: flags.prompt || prev.prompt || '',
    sections: brief.sections.map((s) => ({ title: s.title, kicker: s.kicker || '', bulletCount: s.bullets.length, callout: s.callout || '' })),
    next: brief.next || [],
    closingLine: brief.closingLine || '',
    createdAt: prev.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  save(RECIPES, recipes)
  console.log(`已保存 Skill「${name}」：${recipes[name].sections.length} 节、规则 ${recipes[name].rules.length} 条`)
} else {
  console.log('用法：skill.mjs list | show <name> | save <name> [--brief d1] [--rules json] [--style json] | export <name>')
}
