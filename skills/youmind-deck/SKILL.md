---
name: youmind-deck
description: Turn a topic or document into a deck through research → outline → iterative refinement → audience/length confirmation → generation → saving the recipe. Use when the user asks for a 汇报 / PPT / 演示文稿 from a topic or file, or wants to reuse a previous deck style.
user-invocable: true
---

# 从一个主题到一版能交付的稿

这是一条**创作流程**，不是功能清单。顺序不能反过来：先想清楚讲什么，再排结构，最后才碰版式。

## 何时用

- 用户给一个主题或文档，要「汇报 / PPT / 演示文稿」
- 用户说「按上次那个路子来」「复刻这种风格」
- 用户想先看大纲，再决定做不做

## 七步

### 1. 调研：先定「讲什么」

不要立刻建版面。先：
- `ym_board(action="create", name="<主题>", topic="给谁、要达成什么")`
- 用 `ym_capture` 收素材（url / file / text / kind=transcript）
- `ym_pick(action="highlights")` 看候选，`ym_search` 找具体原文
- 给用户一页「思路」：**3 个判断 + 建议的 4–6 节**

禁止在这一步直接出稿。

### 2. 大纲 v1

`ym_brief(board, title, audience, goal, plan)` 出一版骨架（分节标题 + 每节要点数 + 收束句）。
只给结构，不给成品。告诉用户「现在改结构最便宜」。

### 3. 多轮打磨（至少两轮）

每轮只听一个意图，改一处：
- 砍节 / 合并节
- 加「边界」页（没做什么）
- 给每条结论挂引用（`ym_pick(action="add")`，逐字校验）
- 需要时插入 `quote`（大字引言）、`cards`（并列）、`flow`（分层）

改完给用户看「变了什么」，不要默默重排。

### 4. 确认对象与时长

问清三件事：**给谁、讲多久、多少页**。
然后给一张节奏表（每页多少秒），并说明按这个时长该删哪里。

### 5. 出稿

`ym_deck(brief="…", outputDir=…)`，产出 PPTX + HTML + JSON。
风格默认 `soft`（汇报）；学术用 `academic`，技术分享用 `midnight`。

### 6. 自查

- 每条结论是否都有引用；没有的页面是否标注「待核实」
- 是否连续三页纯文字（应插入流程/图表/卡片）
- 图表数据是否有出处；示意是否标注

### 7. 存成 Skill

用户满意后：`ym_recipe(action="save", name="…", brief="…", rules=[…], style=…)`。
下次先 `ym_recipe(action="show")`，按骨架和规则填，不要从零想结构。

已存的几套（先 `show` 再动手）：

- **领导 5 分钟 · 四层带状态**｜8 页正文 + 1 页证据附录，四层各标完成度，最短板单独占时。
  适合 5 分钟口径的能力交底（复刻 / 立项 / 改造成果）。
- **领导汇报-四层拆解**｜5 节长版，四层 + 边界页，适合 10 分钟以上、要展开讲的场合。

## 硬规则

- 引用必须能在原文里逐字找到；找不到就判未通过，**不许改写成「大概意思」**
- 不编数据、不编引文；示意必须标注
- 大纲没确认前，不调版式、不选颜色
- 一次只改一个维度；结构稳定后再谈视觉
