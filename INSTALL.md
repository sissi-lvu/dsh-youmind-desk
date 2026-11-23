# 安装 youmind-desk

一个把「素材 → Board → 带引用的检索 → 出稿」串起来的 DSH 插件。装上后多 9 个工具、1 个流程技能、1 个素材库页面。

## 前置

- DeepSeek Harness，profile `web`（桌面版把 `web` 换成 `desktop`）
- Node ≥ 20
- 安装时能联网（从 GitHub 拉代码 / 拉 `pdf-parse`）

`pptxgenjs` 与 `jszip` 已随包携带（`vendor/`），不依赖宿主的 node_modules 布局，也不需要 `dsh-ppt`。

## 方式 A：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:<你的用户名>/youmind-desk
```

指定版本（打完 tag 后）：

```bash
dsh plugin --profile web add github:<你的用户名>/youmind-desk#v0.3.4
```

## 方式 B：从 release 附件安装

下载 `youmind-desk-0.3.4.tgz`，然后：

```bash
dsh plugin --profile web add /绝对路径/youmind-desk-0.3.4.tgz
```

装完**重启一次 dsh**。

## 装完自查

1. 让助手列出工具，应出现 9 个：
   `ym_board` `ym_capture` `ym_search` `ym_pick` `ym_brief` `ym_deck` `ym_recipe` `ym_style` `ym_slides`
2. 浏览器打开 `http://127.0.0.1:3080/youmind-desk/library`，应看到「素材库」页（不是 404）
3. 新会话说「做一版关于 X 的汇报」，应先给判断与章节建议，而不是直接生成 PPT

## 数据与产物

- 状态：`$DSH_HOME/state/youmind-desk/`（`boards.json`、`materials/`、`recipes.json`）
- 产物：默认写到调用时的 `youmind-decks/`；建议在 `ym_deck` 里显式传 `outputDir`

## 可选配置

```yaml
- id: youmind-desk
  config:
    deckOutputDir: /path/to/decks   # 默认产物目录
    defaultStyle: soft              # soft / academic / midnight
    maxMaterialsPerBoard: 200
```

## 排错

**报「PKG_DIR is not defined」**：0.3.1 的回归 bug，0.3.2 起已修，升级即可。

**报「未找到 pptxgenjs」**：装的是 0.3.0 或更早。升级到 0.3.4（vendor 自带），或在插件目录 `npm i pptxgenjs`。

**素材库页面 404**：插件进程没重启，重启 dsh 再试。

**Word/PDF 解析失败**：安装时没联网，`jszip`（已随包）/ `pdf-parse`（可选）没就位。

## 卸载

```bash
dsh plugin --profile web remove youmind-desk
```

## 已知边界

- 没有 ASR：音视频要先有转写稿；带 `[mm:ss]` 的稿会保留时间点
- PDF 只读文字层：扫描件没字；中文可能缺字乱序
- 检索是 BM25：同义改写召回弱
- 没有浏览器插件/账号同步
- **不生成图像/视频**：只做可编辑的文字与矢量版式
- PPTX 未做 Office 渲染验收：交付前用 PowerPoint/WPS 打开确认
- 字体：`academic` 用 Songti SC、`midnight` 用 PingFang SC，Windows 上可能回退
