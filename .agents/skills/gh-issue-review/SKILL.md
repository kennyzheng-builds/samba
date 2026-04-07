---
name: gh-issue-review
description: 每日 Issue 审阅日报。拉取最近 open issue，检查评论、关联 PR/commit、标签等事件，按处理状态分组，以中文表格呈现。用户说"看 issue"、"issue 日报"、"未回复 issue"时触发。
---

# GitHub Issue 每日审阅

为产品经理生成 Issue 日报，快速了解哪些 issue 已在处理、哪些需要关注、哪些可以快速回复。

## 工作流程

### Step 1: 拉取最近 Issue

```bash
gh issue list --state open -L 30 --json number,title,author,createdAt,comments,labels,body -S "sort:created-desc"
```

- 默认拉取最近 30 个 open issue，用户可指定数量或时间范围
- 如果用户指定了时间范围（如"最近3天"），用 `created:>=YYYY-MM-DD` 过滤

### Step 2: 检查每个 Issue 的处理状态

对每个 issue，通过 GitHub Timeline API 检查事件动态：

```bash
gh api "repos/{owner}/{repo}/issues/{number}/timeline" \
  --jq '[.[] | select(.event == "cross-referenced" or .event == "referenced" or .event == "closed" or .event == "renamed" or .event == "labeled") | {event, actor: .actor.login, created_at, source_issue: .source.issue.number}]'
```

根据以下规则判断处理状态：

| 状态 | 判断条件 |
|---|---|
| **已有修复 PR** | timeline 中有 `cross-referenced` 事件指向 PR，或有 `referenced` 事件关联 commit |
| **维护者已关注** | 维护者（非 bot）执行了 `renamed`/`labeled` 等操作，但无关联 PR |
| **社区已讨论** | 有用户评论（comments > 0），但无团队成员参与 |
| **完全无人关注** | 无评论、无维护者操作、无关联 PR（仅有 bot 自动打标签不算） |

**注意**：`dosubot[bot]` 的自动标签操作不视为"维护者已关注"。

### Step 3: 获取 Issue 详情

对每个 issue 读取完整内容：

- **body**: issue 原文（去掉模板 checklist 部分，提取核心描述）
- **comments**: 所有评论内容
- **关联 PR**: 从 timeline 中提取的 PR 编号

如果 issue 原文是英文（由 Claude 自动翻译），查找 `<details><summary>Original Content</summary>` 中的中文原文作为摘要来源。

### Step 4: 生成日报

按以下结构输出，全部使用**中文**：

#### 格式要求

1. **Issue 编号必须带超链接**：使用 `[#数字](https://github.com/{owner}/{repo}/issues/数字)` 格式
2. **标题和描述用中文**：将 issue 内容整理为中文摘要
3. **时间要具体**：显示 `MM-DD HH:mm` 格式（UTC 时间）
4. **表格形式呈现**

#### 输出结构

```markdown
# {repo} Issue 日报（YYYY-MM-DD）

## 一、已有修复 PR / 正在处理

| Issue | 标题 | 描述 | 处理进展 | 提交者 | 时间 |
|---|---|---|---|---|---|
| [#xxx](url) | 中文标题 | 中文摘要 | 关联 PR/commit 信息 | author | MM-DD HH:mm |

## 二、维护者已关注但无修复 PR

### Bug（N个）

| Issue | 标题 | 描述 | 维护者动作 | 提交者 | 时间 |
|---|---|---|---|---|---|

### 功能请求（N个）

| Issue | 标题 | 描述 | 维护者动作 | 提交者 | 时间 |
|---|---|---|---|---|---|

### 使用咨询（N个）

| Issue | 标题 | 描述 | 维护者动作 | 提交者 | 时间 |
|---|---|---|---|---|---|

## 三、完全无人关注

| Issue | 标题 | 描述 | 提交者 | 时间 |
|---|---|---|---|---|

## 四、已有社区讨论但团队未介入

| Issue | 标题 | 回复摘要 | 提交者 | 时间 |
|---|---|---|---|---|

## 五、处理建议

| 优先级 | Issue | 建议 |
|---|---|---|
| 高（核心功能） | [#xxx](url), [#xxx](url) | 原因和建议 |
| 中（需跟进） | ... | ... |
| 可快速回复 | ... | ... |
```

#### Issue 类型判断

根据标题前缀和标签判断：

| 前缀/标签 | 类型 |
|---|---|
| `[Bug]` | Bug |
| `[Feature]` | 功能请求 |
| `[Discussion]` / `[Other]` | 使用咨询 |
| `[Refactor]` | 重构（团队内部，可省略） |

#### 处理建议优先级

| 优先级 | 条件 |
|---|---|
| **高** | 核心功能阻断（发送消息、模型调用、翻译等基础功能不可用） |
| **中** | 有明确复现路径的 bug，或影响体验的 UI 问题 |
| **可快速回复** | 使用咨询类，可给操作指引或确认功能边界 |

### Step 5: 等待用户指令

日报输出后，询问用户想处理哪个 issue，可以：

1. **分析代码**：定位 issue 相关的代码位置，分析根因
2. **起草回复**：用中文为用户起草 GitHub 回复
3. **提交修复**：如果是简单 bug，帮助修复并提 PR

## 过滤规则

- **排除团队成员自建的 Refactor issue**：如果 author 是 collaborator 且标题含 `[Refactor]`，默认不展示（除非用户要求）
- **排除已关闭的 issue**：只看 open 状态
- **合并相似 issue**：如果多个 issue 描述同一问题，在备注中标注关联

## 注意事项

- Timeline API 可能因网络问题返回 EOF，对失败的请求需要重试一次
- bot 自动操作（dosubot[bot]）不计入"维护者已关注"
- 如果 issue 数量较多，可并行调用 `gh api` 提高效率
- 评论中如果有 `Original Content` 折叠块，优先从中文原文提取摘要
