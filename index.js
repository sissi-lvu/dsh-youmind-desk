// youmind-desk — YouMind 式创作工作台（DeepSeek Harness 插件）
//
// 把 YouMind 的四层能力落到本机：
//   Input   网页/文本/文件/转写稿 → 归一化文本 + 切块（转写稿保留时间戳）
//   Process Board 持久化上下文 + BM25 检索 + 找亮点候选 + 引用逐字校验
//   Output  brief → PPTX + HTML + JSON
//
// 本文件只做接线：状态目录、api 适配、把领域层挂到 ctx.tools 上。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyDomain } from './domain.mjs'
import { renderLibrary } from './library.mjs'

export const name = 'youmind-desk'

export const inject = ['tools']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'state', 'youmind-desk')
const SKILLS_DIR = join(PACKAGE_DIR, 'skills')
const SKILL_FILE = join(SKILLS_DIR, 'youmind-deck', 'SKILL.md')
const LIBRARY_PATH = '/youmind-desk/library'
const SKILL_NAME = 'youmind-deck'
const SKILL_DESCRIPTION = 'Turn a topic or document into a deck through research → outline → iterative refinement → audience/length confirmation → generation → saving the recipe. Use for 汇报 / PPT / 演示文稿 requests or when reusing a previous deck style.'

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** evolve 版 api 的最小替身：领域层不关心自己跑在哪个宿主里。 */
function createApi() {
  return {
    tool: (spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: textOutput,
        execute: async (args) => {
          const result = await spec.execute(args)
          return typeof result === 'string' ? result : JSON.stringify(result)
        },
      }),
    dataFile(relative) {
      const file = join(STATE_DIR, String(relative))
      mkdirSync(dirname(file), { recursive: true })
      return file
    },
    readJson(file, fallback) {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
    },
    writeJson(file, value) {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    },
    readText(file, fallback) {
      return existsSync(file) ? readFileSync(file, 'utf8') : fallback
    },
    writeText(file, text) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text, 'utf8')
    },
    log: (...args) => console.log('[youmind-desk]', ...args.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))),
  }
}

/** 注册 youmind-deck 技能：让新会话也知道这条创作流程。 */
function registerSkill(ctx) {
  const candidate = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'youmind-desk-bundled',
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILLS_DIR },
    rank: 600,
    locator: SKILL_FILE,
  }
  const provider = {
    name: 'youmind-desk-bundled',
    list: () => Promise.resolve([candidate]),
    async get() {
      return { ...candidate, content: readFileSync(SKILL_FILE, 'utf8') }
    },
  }
  try {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.effect(() => skillCtx.skills.registerProvider(() => provider))
    })
  } catch (error) {
    console.log(`[youmind-desk] 技能注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 只读素材库页面：现读状态目录，浏览器刷新即可看到新素材。 */
function createLibraryHandler() {
  return function libraryHandler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const remote = String((req.socket && req.socket.remoteAddress) || '')
      const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!local) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const html = renderLibrary(STATE_DIR)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : html)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`素材库渲染失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function registerLibraryRoute(ctx) {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() =>
        webCtx.webServer.register({ kind: 'exact', path: LIBRARY_PATH, handler: createLibraryHandler() }),
      )
    })
  } catch (error) {
    console.log(`[youmind-desk] 素材库路由注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx, config = {}) {
  mkdirSync(STATE_DIR, { recursive: true })
  console.log(`[youmind-desk] 状态目录 ${STATE_DIR}`)
  registerSkill(ctx)
  registerLibraryRoute(ctx)
  return applyDomain(ctx, config, createApi())
}
