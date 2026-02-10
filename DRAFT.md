# 基于 pi-mono 的多 Agent 协作系统方案书（Team Runtime + Extension + Peer Discussion）

> 目标：在 **pi-mono / pi-coding-agent** 之上实现类似 **Claude Code Agent Teams** 的多 Agent 协作：**Leader + Teammates 并行、独立上下文、共享任务板与消息系统**，并且 **Agent 之间可横向讨论（peer-to-peer）**，而不只是执行 leader 派发的任务。

---

## 0. 摘要

本方案设计一个“团队运行时（Team Runtime）”+“pi 扩展（Extension）”的协作系统：

- **teamd（外置协调进程）**：单写者（Single Writer）维护任务板、inbox、讨论线程（threads）、锁/租约（lease）与预算统计，提供一致性与可观测性。
- **N 个 pi session（leader/teammates）**：每个 agent 运行在独立 session/context 中，通过 `team-coordination` extension 注入协作事件，并通过 team tools 与 teamd 交互。
- **文件系统协议**：共享目录 `~/.pi/teams/<teamId>/`，结构化落盘（tasks/inboxes/threads/artifacts/logs），可审计、可复盘、可复现。
- **Peer Discussion 一等公民**：agent 之间可发起线程讨论、互相 review、请求帮助、拉第三方仲裁；leader 默认负责最终决策与集成，但不垄断通信。

对标对象：Claude Code Agent Teams 的协作语义（lead + teammates、独立上下文、共享任务/消息协作）。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))

---

## 1. 背景与动机

### 1.1 为什么多 Agent

单 agent 在以下场景吞吐不足或风险过高：

- 并行探索型：安全/性能/架构多角度审查、依赖升级影响面调查
- 多方案对比：多个实现路径/算法/架构权衡并行产出
- 多产线并行：代码实现 + 测试补齐 + 文档/变更说明同时推进

多 Agent 的核心收益来自：

- **并行能力**
- **上下文隔离**（避免“一个会话塞太多导致污染与遗忘”）

Claude Teams 的定位与实践正是这套思路。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))

### 1.2 为什么选 pi-mono

pi-mono 作为 monorepo，具备构建协作系统的底座：统一 LLM API、coding agent、TUI 等。([github.com](https://github.com/badlogic/pi-mono?utm_source=chatgpt.com))
更关键：pi-coding-agent 支持 **Extension** 机制（注册工具、拦截工具调用、注入上下文、配合 compaction）。([github.com](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md?utm_source=chatgpt.com))
作者对 pi-coding-agent / pi-tui 的设计取向有公开阐述，可作为“极简核心 + 可扩展协作层”的哲学依据。([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/?utm_source=chatgpt.com))

---

## 2. 设计目标与非目标

### 2.1 目标（Goals）

G1. 多会话协作：一个 team = leader + N teammates
G2. 上下文隔离：每个 agent 独立 context window，信息共享走显式协议
G3. 共享任务系统：tasks 三态/多态 + 依赖 DAG + 可审计落盘
G4. 消息系统：inbox 投递通知 + threads 承载讨论（可横向互聊）
G5. 最小侵入：优先用 teamd + extension + tools，不改或极少改 core
G6. 成本控制：模型分层、预算阈值、超额降级策略、统计可观测
G7. Peer Discussion 一等公民：任意 agent ↔ 任意 agent 讨论/互助/review/仲裁（不必经过 leader）
G8. 治理与收敛：讨论能回流到任务与决策记录，避免“聊嗨不落地”

### 2.2 非目标（Non-goals）

- MVP 不追求跨机器分布式强一致（先单机多进程/多终端跑通）
- MVP 不做“完全自治的自动分解+自动合并”超强系统（先闭环）
- MVP 不强依赖 tmux/iTerm2（先 CLI/日志/TUI 后置）

---

## 3. 对标参考：Claude Code Agent Teams 可复用要点

- Lead + Teammates：lead 拆解/分配/综合输出，teammates 独立执行。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))
- 独立上下文：每个 teammate 有独立上下文窗口。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))
- 协作语义：共享任务板与消息机制；teammates 之间可互发消息（不只是向 leader 汇报）。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))
- 社区复刻/拆解可作为实现细节交叉验证来源（以官方为准）。([dev.to](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol?utm_source=chatgpt.com))

---

## 4. 总体架构

### 4.1 架构概览

**推荐：teamd（外置单写者）+ 多 pi sessions + 文件协议**

- **teamd（Coordinator/Daemon）**

  - 单写者维护：tasks / inboxes / threads / locks / budget / logs
  - 负责：任务创建/领取/状态流转、依赖解锁、消息投递、线程追加、预算统计、租约过期回收
  - 对外：IPC（HTTP/Unix socket）+ CLI（也可文件 requests/ 方式）

- **pi sessions（leader + teammates）**

  - 每个 agent：普通 pi session（独立上下文、独立压缩）
  - 加载：`team-coordination` extension
  - 通过 team tools 与 teamd 交互（claim/complete/send/startThread/postMessage 等）
  - extension 负责把协作事件注入 context（系统事件/notes）

- **共享目录（Team Workspace）**

  - `~/.pi/teams/<teamId>/`：team.json、tasks、inboxes、threads、artifacts、logs

### 4.2 为什么 teamd 必须是单写者（MVP 推荐）

多 agent 并发写 JSON 很容易“写坏/丢消息/状态回退”。采用 teamd 单写者显著降低一致性成本。社区复刻 Claude Teams 的工程实践也强调了协议与一致性处理的重要性。([dev.to](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol?utm_source=chatgpt.com))

---

## 5. 协作协议：目录布局与数据模型

### 5.1 目录布局（建议）

```
~/.pi/teams/<teamId>/
  team.json
  tasks/
    0001.json
    0002.json
  inboxes/
    leader.json
    worker_a.json
    worker_b.json
  threads/
    t-<threadId>.jsonl
  index/
    threads.json
  artifacts/
    summaries/
    patches/
    traces/
  logs/
    teamd.log
```

### 5.2 team.json（Team 配置）

建议字段：

- `teamId`
- `agents[]`: `{id, role, model, systemPromptRef, skills[], extensions[]}`
- `budget`: `{dailyTokens, perTaskTokens, hardLimitPolicy}`
- `locks`: `{mode: "task_resources"|"file_lock", rules: ...}`
- `runtime`: `{ipcEndpoint, pollIntervalMs, maxInboxBatch, threadTailN}`

### 5.3 Task（tasks/<id>.json）

建议字段：

- `id`
- `title`, `description`
- `status`: `pending | in_progress | blocked | completed | failed | canceled`
- `owner`
- `deps[]`
- `resources[]`（路径 glob，用于写冲突控制）
- `inputs`: `repoPaths[] / refs / constraints / acceptanceCriteria`
- `outputs`: `summary / artifacts[] / filesTouched[] / discussionRefs[] / result`
- `lease`: `{holder, expiresAt}`
- `timestamps`: `{createdAt, startedAt, completedAt}`

> 任务分配与综合输出是 Claude Teams 的核心语义之一，本方案将其工程化为 task 模型。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))

### 5.4 Inbox（inboxes/<agentId>.json）

Inbox 是**投递队列/通知层**（轻量、可批量处理），每条事件：

- `id`
- `from`, `to`
- `type`:

  - `task_assigned | task_claimed | task_completed | task_failed`
  - `thread_message`（新线程消息通知）
  - `mention`（被 @ 提及）
  - `conflict`（冲突警报）

- `payload`: `{taskId?, threadId?, messageId?, preview?, mentions?}`
- `ts`

### 5.5 Threads（threads/t-<threadId>.jsonl）

Threads 是**讨论承载层**（长对话载体）。采用 JSONL（append-only）：
每行一条 message：

- `id`, `threadId`
- `from`
- `to`: `["worker_a"]` / `["worker_a","worker_b"]` / `["*"]`
- `kind`: `question | answer | critique | proposal | decision | review_request | review_response | info`
- `topic`
- `refs`: `{taskId?, files?, commits?, urls?}`
- `body`（允许 markdown）
- `ts`

并配合索引文件：

- `index/threads.json`：`{threadId, topic, participants, lastUpdated, linkedTaskId?, tags[]}`

> Claude Teams 的语义强调 teammates 互相沟通；本方案用 threads 把“互聊”变成一等协议对象，而不只靠 leader/任务。([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))

---

## 6. pi 侧集成：team-coordination extension + Team Tools

pi-coding-agent 的 extension 能力（注册工具、拦截工具调用、注入上下文等）是本方案的核心支点。([github.com](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md?utm_source=chatgpt.com))

### 6.1 Extension 职责

`team-coordination` extension（每个 agent 都加载）：

1. **Inbox polling / subscription**

   - 轮询 `inboxes/<self>.json`（或通过 IPC stream）
   - 将新事件注入 context（以系统事件/notes 形式）

2. **Thread awareness**

   - 收到 `thread_message/mention` → 注入“通知摘要”
   - 仅在需要时拉取 thread tail（最近 N 条）注入 context

3. **Task awareness**

   - 新任务 assigned → 生成“下一步动作建议”
   - claim/complete/fail 等通过 tool 调用 teamd

4. **工具拦截（Guard）**

   - 未持有 lease/lock：禁止对受保护路径执行写操作
   - 超预算：限制为只读分析/输出方案

### 6.2 Team Tools（LLM 可调用）

#### 任务类

- `team.createTask({title, description, deps?, resources?, inputs?}) -> {taskId}`
- `team.claimTask({taskId}) -> {lease}`
- `team.completeTask({taskId, outputs})`
- `team.failTask({taskId, reason})`
- `team.listTasks({status?, owner?}) -> tasks[]`

#### 讨论类（Peer Discussion 核心）

- `team.startThread({topic, participants[], refs?}) -> {threadId}`
- `team.postThreadMessage({threadId, kind, to[], body, refs?, mentions?})`
- `team.readThread({threadId, tailN}) -> messages[]`
- `team.searchThreads({query, limit}) -> threadSummaries[]`
- `team.linkThreadToTask({threadId, taskId})`

#### 互助/仲裁类（可选但非常实用）

- `team.requestHelp({toAgentId, context, refs?}) -> {threadId}`
- `team.requestArbitration({agents[], question, refs?}) -> {threadId}`

---

## 7. 关键流程（生命周期）

### 7.1 Team 创建

1. `pi-team create --team <teamId> --agents leader,worker_a,worker_b ...`
2. 写入 `team.json`，初始化目录结构
3. 启动 teamd（后台或前台）
4. 启动多个 pi session（可由 CLI 拉起）

### 7.2 任务派发与并行执行（基本闭环）

1. leader 创建并行 tasks：`team.createTask` x N
2. teammates 领取：`team.claimTask`（teamd 发 lease + 锁检查）
3. teammate 执行并产出：`team.completeTask` + `outputs.summary/artifacts`
4. leader inbox 收到完成事件，综合推进后续任务（依赖解锁）

### 7.3 Peer Discussion（横向互聊闭环）

1. 任意 agent 发现问题（bug/设计分歧/需要 review）
2. 直接发起线程：

   - `team.requestHelp({toAgentId, ...})` 或 `team.startThread(...)`

3. 对方在 thread 内回复、补充、挑战、提出替代方案（`postThreadMessage`）
4. 讨论结论回流：

   - `team.linkThreadToTask`（绑定到现有 task）
   - 或创建新 task（把讨论结论转成行动项）

5. leader（可选）订阅 task/thread，负责最终集成与决策记录

### 7.4 依赖管理（DAG）

- teamd 维护 `deps[]`
- deps 全部 completed → blocked 自动转 pending
- 检测循环依赖 → 标记 failed 并通知相关 agent

### 7.5 Shutdown（可选）

- leader broadcast `shutdown_request`
- teammates 回复 `shutdown_response` 安全退出
  （社区讨论中常见此类协议语义；可作为后续增强）。([reddit.com](https://www.reddit.com/r/ClaudeCode/comments/1qz8tyy/how_to_set_up_claude_cdes_agent_teams_full/?utm_source=chatgpt.com))

> 注：上面 reddit 链接的具体内容依赖帖子可用性与页面变化；它仅作交叉验证参考，不作为唯一真相来源。

---

## 8. 上下文隔离与共享：注入策略（避免讨论污染）

这是“互聊型团队系统”最容易翻车的地方：讨论信息如果像用户消息一样塞进对话，会污染语义并吃掉上下文预算。

### 8.1 两层注入策略

- **层 1：通知层（inbox）**
  注入一条系统 note（短）：

  - “你被 @X 提及于 thread T（topic=...），预览：...”

- **层 2：拉取层（thread tail）**
  只有当 agent 要回应/继续时，才拉取 thread 最近 N 条进入上下文（N 默认为 3~5）

### 8.2 讨论压缩（thread summarize）

- 当 thread 太长：

  - extension 或 teamd 生成结构化摘要（可用便宜模型）：

    - 共识点 / 分歧点 / 待决问题 / 下一步行动

- 注入上下文的默认形态是“摘要 + tail”，而不是完整回放

这些都属于 extension 可承担的职责范畴。([github.com](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md?utm_source=chatgpt.com))

---

## 9. 一致性与并发控制

### 9.1 MVP 推荐：teamd 单写者

- tasks/inboxes/threads 只有 teamd 写
- workers 通过 IPC/tool 请求更新
- 落盘采用原子写：

  - tasks/inboxes：写 temp → rename
  - threads：append JSONL（同样需要锁或单写者保证）

### 9.2 冲突控制（资源锁）

推荐策略：**任务级资源声明 + teamd 锁发放**

- task 创建时声明 `resources: ["src/foo/**", "Cargo.toml"]`
- claim 时检查锁冲突：冲突则拒绝或置为 blocked
- release lock：complete/fail 自动释放，lease 过期回收

备选策略（后置）：文件级锁（成本高、死锁风险大）

---

## 10. 成本控制与模型分层

### 10.1 模型分层（默认）

- leader：强模型（拆解、综合、决策、最终 patch/PR）
- workers：便宜模型（读代码、提出建议、局部实现/测试）

### 10.2 预算策略（可执行）

- `budget.perTaskTokens` 超额：

  - 强制该 task 进入“只读分析/产出方案”模式

- `budget.dailyTokens` 超额：

  - teamd 拒绝新 task 或强制所有 worker 降级

- 统计维度：

  - 每 task：input/output tokens、模型、工具调用次数、耗时

---

## 11. 治理：讨论、决策与落地的责任边界

为了避免“大家都能聊但没人拍板”，引入轻量治理规则（写入 team.json 或 AGENTS.md）：

- **Discussion**：任何 agent 可发起/参与
- **Decision**：默认 leader 负责写入 `kind=decision`（或授予权限的 agent）
- **Execution**：以 task 完成、patch、commit 作为落地产物
- **争议无法收敛**：`requestArbitration` 拉 2–3 agent 并行给意见，leader 选择并记录 decision

---

## 12. UI / TUI 规划

pi 的 TUI 与整体设计倾向适合做一个“多窗格团队面板”。([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/?utm_source=chatgpt.com))

### 12.1 MVP（CLI）

- `pi-team status`：tasks 列表（状态、owner、deps、锁、预算）
- `pi-team threads`：thread 索引（topic、participants、lastUpdated、linkedTask）
- `pi-team tail`：teamd 日志 + message stream

### 12.2 Phase（TUI）

- panes：Leader / Workers / Tasks / Threads / Logs
- 支持：按 threadId/taskId 快速跳转、打开 artifacts（patch/summary）

---

## 13. 测试策略

### 13.1 teamd 单元测试

- task 状态机：流转合法性
- deps DAG：解锁、循环依赖检测
- lease：发放、过期、回收
- locks：冲突检测、释放一致性
- 原子写与崩溃恢复：中断后数据恢复

### 13.2 集成测试（无 LLM）

- 启动 teamd + mock workers（用脚本模拟 claim/complete/postThreadMessage）
- 校验：tasks/inboxes/threads 一致，无丢消息，无写坏文件

### 13.3 真实项目试点（dogfooding）

- 选一个中等 repo
- 并行任务：安全/性能/架构 review + 一个小改动实现 + 测试补齐
- 目标：验证“互聊→结论回流→集成”闭环的效率与稳定性

---

## 14. 迭代路线图（可交付）

### Phase 1：闭环 MVP（1–2 周）

- teamd：tasks/inboxes 基础能力 + IPC
- extension：inbox 注入 + task tools
- Demo：leader 创建 3 tasks，2 workers 并行完成并回传 summary/artifacts

### Phase 2：Peer Discussion（1 周）

- teamd：threads（JSONL）+ thread 索引 + inbox 通知
- extension：thread_message/mention 注入策略 + readThread tail
- Demo：worker_a 直接向 worker_b 请求帮助并在 thread 中收敛结论，绑定回 task

### Phase 3：依赖与锁（1–2 周）

- deps DAG 自动解锁
- resources 锁 + lease 过期回收
- 预算统计与降级策略

### Phase 4：TUI（1 周）

- tasks/threads/logs 面板，多窗格协作视图

### Phase 5：优化（持续）

- 更强的冲突检测与合并策略
- 线程摘要与上下文预算自动化
- 更精细的模型调度（按 task 类型自动选择）

---

## 15. 风险与对策

1. **一致性风险（并发写坏 JSON/丢消息）**

   - MVP：teamd 单写者 + 原子写/append-only thread

2. **讨论污染上下文**

   - 两层注入：inbox 通知（短）+ 按需拉取 thread tail（短）+ 超长 thread 摘要

3. **成本失控**

   - token 预算硬阈值 + 超额降级（只读/只产出方案）

4. **多人改同一文件冲突**

   - task resources 锁 + leader 最终合并

5. **“互聊不落地”**

   - thread 必须可 link 到 task；结论要转成 action items；决策要记录为 `decision`

---

## 16. 参考链接（可点击）

- Claude Code Agent Teams 官方文档（lead/teammates、独立上下文、协作语义）
  ([code.claude.com](https://code.claude.com/docs/en/agent-teams?utm_source=chatgpt.com))

- pi-mono 仓库（monorepo 包结构与基础设施）
  ([github.com](https://github.com/badlogic/pi-mono?utm_source=chatgpt.com))

- pi-coding-agent extension 文档（注册工具、拦截、注入上下文等关键能力）
  ([github.com](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md?utm_source=chatgpt.com))

- Mario Zechner 对 pi-coding-agent 的设计文章（设计取向与组件说明）
  ([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/?utm_source=chatgpt.com))

- “Porting Claude Code Agent Teams to OpenCode”（复刻/拆解，供实现细节参考）
  ([dev.to](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol?utm_source=chatgpt.com))

- ClaudeCode 社区讨论帖（交叉验证参考，非唯一真相源）
  ([reddit.com](https://www.reddit.com/r/ClaudeCode/comments/1qz8tyy/how_to_set_up_claude_cdes_agent_teams_full/?utm_source=chatgpt.com))
