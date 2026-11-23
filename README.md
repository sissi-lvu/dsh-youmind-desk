# youmind-desk

从 GitHub 安装：

```bash
dsh plugin --profile web add github:<你的用户名>/youmind-desk
```

装完重启 dsh。详细步骤与排错见 [INSTALL.md](./INSTALL.md)。

把 YouMind 的核心链路搬进 DeepSeek Harness 的插件：**素材摄取 → Board 持久上下文 → 带引用的检索 / 找亮点 → 一键出 PPTX**。

不是界面复刻，是三件真正难抄的事：

1. **上下文持久**：一个主题一个 Board，素材、引用、提纲跨会话留存，不随聊天窗口消失。
2. **引用可回溯**：每条引用都落到原文行号，转写稿落到秒级时间点；AI 给的话必须能在原文里逐字找到，否则明确判为未通过校验。
3. **产出可编辑**：同一份 brief 同时出 `.pptx`、`.html`、`.json`，PPTX 里的文字都能继续改。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ym_board` | 建板 / 列表 / 查看 / 改主题 / 删板 |
| `ym_capture` | 收网页正文、文本、本地文件、带时间戳的转写稿；自动切块建索引 |
| `ym_search` | Board 内 BM25 检索，返回带位置引用的原文片段 |
| `ym_pick` | 「找亮点」候选 + 引用逐字校验（找不到就返回最接近片段） |
| `ym_brief` | 组装带引用的提纲（结论 / 分页要点 / 证据台账 / 下一步） |
| `ym_deck` | 渲染 PPTX + HTML + JSON |

## 典型用法

```text
ym_board(action="create", name="AI 创作工具调研", topic="给领导讲清能力边界")
ym_capture(board="b1", file="notes/research.md")
ym_capture(board="b1", kind="transcript", text="[00:12] ……")
ym_search(board="b1", query="持久上下文")
ym_pick(board="b1", action="highlights", query="Board")
ym_pick(board="b1", action="add", quote="原文逐字摘录", reason="为什么重要")
ym_brief(board="b1", audience="公司领导", plan={...})
ym_deck(brief="d1", outputDir="/abs/path/decks")
```

`plan` 由模型负责判断与措辞，插件只做三件事：校验 `cites` 是否存在、把引用渲染成脚注、保证版面不糊。不传 `plan` 时按已校验引用自动兜底。

`plan` 还支持两页「非纯文字」版式：

- `flow`：四层流程示意图（输入 → 上下文 → 智能体 → 输出），`steps[].label/sub` + `note/caption`
- `chart`：原生条形图，`categories` 与 `series[0].values` 必须等长；数据由调用方保证真实，`caption` 写出处

页序固定为：封面 → 结论 → 流程图 → 分节 → 图表 → 证据台账 → 下一步。

## 已知边界（不做假装）

- **没有 ASR**：音频/视频本身不转写，只接收已有转写稿；转写稿里的 `[mm:ss]` 会解析成时间片段，引用可跳回时间点。
- **网页抽取是启发式**：去脚本、去导航，非站点级适配，公众号/X 这类站点可能缺段；返回时会明确提示「引用前回原文核对」。
- **PDF 不解析**：请先抽成文本。没有引入 PDF 解析依赖，避免把「看起来能读」当「读全了」。
- **检索是 BM25，不是向量**：中文按字 + 二元词，够用于单板几十篇素材；跨语言、同义改写召回弱。
- **没有浏览器插件与同步**：素材靠工具调用录入，不与 YouMind 账号互通。
- **PPTX 未做 Office 渲染验收**：本机没有 LibreOffice/Keynote 导出权限，只用 OOXML 自检 + python-pptx 几何检查 + HTML 同源版式截图交叉验证；最终外观请用 PowerPoint/WPS 打开确认。

## 输出规格

16:9、白底、主色 `#1D6FE0`、正文 `#121A2B`、字体 Hiragino Sans GB；每页带出处脚注和页码；演讲者备注写口径与引用来源。页序：封面 → 结论 → 分节 → 证据台账 → 下一步。

## 素材库页面（实时）

插件启动时注册一个只读路由：

```
http://127.0.0.1:3080/youmind-desk/library
```

从 `$DSH_HOME/state/youmind-desk` 现读现渲染，**收完一篇刷新即可看到**。只接受本机回环访问，不写任何数据。

## 流程 Skill：youmind-deck

插件注册了一个技能 `youmind-deck`，把「调研 → 大纲 v1 → 多轮打磨 → 确认对象/时长 → 出稿 → 存 Skill」固化成流程。
新会话里说「做一版关于 X 的汇报」，模型会加载它，先给思路和大纲，而不是直接出稿。

## 状态与配置

- 状态目录：`$DSH_HOME/state/youmind-desk/`（`boards.json` + `materials/*.json`）
- 产物默认写到 `<宿主进程 cwd>/youmind-decks`；跨会话使用时建议在 `ym_deck` 里显式传 `outputDir`
- 可选配置：`deckOutputDir`、`maxMaterialsPerBoard`

## License

MIT

## 风格预设

默认 **汇报 = `soft`**（白底 + 品牌蓝 + 黑体），适合打印与投屏。另有：

| 预设 | 适合 | 底色 / 强调 / 字体 |
| --- | --- | --- |
| `soft`（默认） | 汇报、打印 | `#FFFFFF` / `#1D6FE0` / Hiragino Sans GB |
| `academic` | 论坛、思想演讲 | `#F2F0E9` / `#8C3738` / Songti SC |
| `midnight` | 技术分享、发布会 | `#121A2B` / `#38BDF8` / PingFang SC |

`ym_brief(style="academic")` 选预设，也可传自定义令牌对象；`ym_style` 列出可用预设。
注意：换的只是令牌，版式几何不变；`Songti SC` / `PingFang SC` 在 Windows 上可能回退。

## 版式

`ym_deck` 自带 6 种版式，全部走同一套风格令牌：

| 版式 | 用途 | 触发方式 |
| --- | --- | --- |
| 要点 | 分节结论 | `sections` |
| 大字引言 | 一句原文压场 | `plan.quote = {text, attribution, kicker}` |
| 卡片 | 2–6 项并列能力/结论 | `plan.cards = {title, items:[{title,desc}]}` |
| 流程 | 分层/分步示意图 | `plan.flow` |
| 图表 | 原生条形图 | `plan.chart` |
| 证据表 | 引用台账 | `evidence`（自动） |

## 多版式：借用 dsh-ppt（备选，不推荐表格）

如果还想要 dsh-ppt 的视觉，用 `ym_slides` 把 brief 转成 `ppt_create` 参数：

```text
ym_slides(brief="d1", theme="soft")   # 返回 {theme, brand, slides:[...]}
ppt_create(slides=[...], theme="soft", brand={...}, title="…")
```

可获得 cover / bullets / quote / table / chart / closing 等版式，输出 HTML + PPTX + JSON。

**为什么不推荐用它做表格**：`soft` 主题的表头是浅蓝 `#D6E4FB`、斑马纹是暖橘 `#FDF4EA`，都来自主题色，`brand` 覆盖不到；冷蓝表头配暖橘条纹很跳。证据表请走 native。

限制（实测）：
- 表格单元格上限 60 字符，转换器会截断到 56 + 省略号
- 主题色归 dsh-ppt 管；brand 能覆盖主色/字体/页脚，但表格斑马纹不受控
- 封面标题过长（>18 字）在 40pt 下会折成两行，建议标题控制在 12–16 字，副标题承载补充信息
- 该路径的 PPTX 同样未做 Office 渲染验收
