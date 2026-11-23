#!/usr/bin/env node
// 把某份 brief 转成 dsh-ppt 的 ppt_create 参数（slides 数组 + 主题/品牌），写到 JSON。
//   node tools/to-dshppt.mjs d1 [输出目录]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { briefToSlides, dshPptOptions } from '../slides.mjs'

const HOME = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
const STATE = join(HOME, 'state', 'youmind-desk')
const briefId = process.argv[2]
const outDir = process.argv[3] || join(process.cwd(), 'youmind-decks', 'dshppt')

const state = JSON.parse(readFileSync(join(STATE, 'boards.json'), 'utf8'))
let brief = null
for (const board of state.boards) {
  const found = board.briefs.find((b) => b.id === briefId)
  if (found) { brief = found; break }
}
if (!brief) {
  console.error(`找不到 brief：${briefId}`)
  process.exit(1)
}

const slides = briefToSlides(brief)
const payload = { ...dshPptOptions(brief), slides }
mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${briefId}.slides.json`)
writeFileSync(file, JSON.stringify(payload, null, 2))
console.log(file)
console.log(`页数 ${slides.length}｜版式 ${[...new Set(slides.map((s) => s.layout))].join(' / ')}`)
