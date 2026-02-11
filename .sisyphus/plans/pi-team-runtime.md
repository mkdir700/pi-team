# pi-team 多 Agent 协作系统（teamd + extension + peer discussion）Work Plan

## TL;DR

> **Quick Summary**: 在不 fork `pi-mono` 的前提下，以独立项目 `pi-team` 交付一个本机多 Agent 协作运行时：`teamd` 单写者 + `team-coordination` 扩展注册 Team tools + 纯文件协议落盘（JSON/JSONL），实现 tasks/inbox/threads/lease/locks 的最小闭环，并用 TDD 把原子写、lease fencing、崩溃恢复、路径安全打牢。
>
> **Deliverables**:
> - `teamd`（Node/TS）：HTTP localhost API，单写者管理 `~/.pi/teams/<teamId>/`
> - `pi-team`（Node/TS CLI）：创建 team、查看 tasks/threads、启动/停止 daemon、生成 agent 启动环境
> - `team-coordination`（pi extension）：注册 `team.*` 工具 + inbox 注入 + tool_call 写入拦截（含 bash）
> - 纯文件协议 + schema/versioning + append-only audit
> - vitest 测试套件 + 端到端 demo 脚本（无 LLM 也可验证闭环）
>
> **Estimated Effort**: Large（偏系统工程：一致性/恢复/权限/测试）
> **Parallel Execution**: YES（2-3 waves）
> **Critical Path**: 协议/原子写工具 → teamd 状态机/lease → extension 写拦截 → e2e demo + crash recovery

---

## Context

### Original Request
- 基于 `pi-mono / pi-coding-agent` 的 Extension 能力，实现类似 Claude Code Agent Teams 的多 Agent 协作：Leader + Teammates、独立上下文、共享任务/消息系统、peer-to-peer 讨论。

### Interview Summary（已确认决策）
- **交付形态**：独立 `pi-team` 项目（不 fork pi-mono），包含 `pi-team` CLI + `teamd` daemon + `team-coordination` extension。
- **持久化**：纯文件协议（JSON + JSONL + artifacts 目录），teamd 单写者。
- **实现技术栈**：TypeScript/Node.js。
- **IPC**：HTTP localhost。
- **测试策略**：YES（TDD，建议 vitest）。

### Research Findings（外部资料要点）
- Claude Code Agent Teams：lead + teammates、共享 task list、mailbox、任务依赖与 claim、落盘目录语义（`~/.claude/teams`, `~/.claude/tasks`）。
  - `https://code.claude.com/docs/en/agent-teams`
- pi-coding-agent extensions：可 `registerTool`、拦截 `tool_call` 阻断、`sendMessage` 注入、`session_before_compact` 自定义 compaction。
  - `https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md`
  - 示例：`protected-paths.ts`, `permission-gate.ts`, `custom-compaction.ts`
- 架构评审（Metis/Oracle）：最大风险在原子写/崩溃恢复/lease fencing/幂等/路径安全；MVP 必须把这些写成不变量并自动验证；extension 必须覆盖 `bash` 以防绕过写入。

---

## Work Objectives

### Core Objective
在单机环境构建一个“可审计、可恢复、可控写入”的多 Agent 协作运行时：任务分派/领取/完成闭环 + peer discussion 线程 + inbox 通知 + lease/锁 + 守护进程单写者。

### Concrete Deliverables
- `teamd`：
  - 管理工作区：`~/.pi/teams/<teamId>/`
  - HTTP API：teams/tasks/threads/inbox/leases/health
  - 单写者语义：所有状态写入仅由 teamd 执行；客户端只读文件/只走 API
- `pi-team` CLI：
  - `pi-team daemon start|stop|status`
  - `pi-team team create|list|show`
  - `pi-team tasks list|show`
  - `pi-team threads list|tail|show`
  - `pi-team agent env|start`（至少输出 env exports，MVP 可不强制自动拉起多终端）
- `team-coordination` extension：
  - LLM-facing tools：`team.createTask/claimTask/completeTask/failTask/listTasks/startThread/postThreadMessage/readThread/...`
  - Inbox polling + 注入（短通知为主，避免上下文污染）
  - 工具写拦截：`write/edit/bash` 无 lease 一律阻断（MVP 保守正确）
- 测试与 demo：
  - vitest 单测覆盖关键不变量
  - e2e 脚本验证：thread 讨论 → task 创建/领取/完成 → inbox 通知 → 崩溃恢复

### Definition of Done
- `npm test` 通过（包含原子写、JSONL 尾部半行、lease fencing、路径安全、并发 claim 等核心用例）。
- `npm run demo:e2e`（或同等脚本）可在本机无人工交互跑通闭环并输出可检查的证据文件（JSON 输出/日志/快照）。
- `team-coordination` 扩展在无 lease 时能阻断 `write/edit/bash`（至少通过单测 + 最小集成验证）。

### Must NOT Have（Guardrails / 防止 scope creep）
- 不做跨机器分布式一致性（单机优先）。
- MVP 不做 WebSocket/SSE 推送（先轮询 inbox，后续可升级）。
- 不做复杂 RBAC/多用户权限体系（本机单用户 + token 即可）。
- 不强依赖 tmux/iTerm2（可以后续加显示后端）。
- extension/CLI 不允许直接写 `~/.pi/teams/<teamId>/` 状态文件（必须通过 teamd）。

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> 本计划的验收/验证必须全部由执行 agent 通过命令或工具完成；不允许“用户手动打开看一下”。

### Test Decision
- **Infrastructure exists**: NO（greenfield）
- **Automated tests**: YES（TDD）
- **Framework**: vitest（建议）

### Agent-Executed QA Scenarios（全任务通用）
- CLI/API：用 `node`（内置 fetch）或 `curl` 调用 HTTP 接口，写入 `.sisyphus/evidence/` 捕获响应 JSON。
- 进程管理：用 `bash` 启动/停止 `teamd`，验证 pid、端口、健康检查。
- 崩溃恢复：在 e2e 脚本中模拟 kill/restart，验证状态不损坏、lease 过期释放。

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Start Immediately)
- Task 1: 项目脚手架 + vitest（TDD 基座）
- Task 2: 协议/目录布局/JSON schema 定稿（含原子写规范）

Wave 2 (After Wave 1)
- Task 3: 文件 I/O 库（atomic JSON / JSONL append / safe read / path safety）+ 单测
- Task 4: teamd 核心状态机（tasks/deps/lease/locks/audit）+ HTTP API + 单测

Wave 3 (After Wave 2)
- Task 5: `pi-team` CLI（daemon/team/tasks/threads/agent env）
- Task 6: `team-coordination` extension（tools + inbox 注入 + tool_call 拦截）

Wave 4 (After Wave 3)
- Task 7: e2e demo（无 LLM）+ crash recovery 演练脚本
- Task 8: 文档与可运行示例（README/快速上手）

Critical Path: 1 → 2 → 3 → 4 → 6 → 7

---

## TODOs

> Implementation + Test = ONE Task（TDD）。

- [x] 1. 初始化 `pi-team` 项目脚手架（Node/TS + vitest）

  **What to do**:
  - 创建 Node/TypeScript 项目（建议包含 `src/`、`test/`、`bin/`）
  - 加入 vitest，配置 `npm test`
  - 加入基本 lint/format（可选，但建议）
  - 建立 `.sisyphus/evidence/` 作为 e2e 输出目录（后续脚本写入）

  **Must NOT do**:
  - 不引入复杂 monorepo 工具链（除非后续确实需要）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `test-driven-development`
  - **Skills Evaluated but Omitted**: `systematic-debugging`（除非遇到工具链错误）

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 Task 2 可并行）
  - **Blocks**: 3, 4, 5, 6, 7, 8

  **References**:
  - `DRAFT.md` - 目标范围、数据模型草案、目录布局设想

  **Acceptance Criteria**:
  - [ ] `npm test` 可运行（至少 1 个占位测试 PASS）
  - [ ] `npm run build`（或等价）可产出可执行的 `pi-team` CLI（哪怕只打印 help）


- [x] 2. 定稿文件协议 + API contract（MVP 版）

  **What to do**:
  - 定义工作区结构（基于 DRAFT.md，补齐 schemaVersion、命名规则、权限建议）
  - 明确“权威来源”与恢复语义：
    - tasks/*.json 与 threads/*.jsonl 为权威状态；inboxes 为通知缓存（可重建）
    - audit/events.jsonl 为 append-only 审计（trace），不要求可完全重放（MVP）
  - 定义 Task 状态机与 deps 规则：pending/blocked/in_progress/completed/failed/canceled
  - 定义 lease：TTL + renew + fencing(epoch)；所有完成/失败必须带 epoch 校验
  - 定义 resources/写入权限判定：
    - task 创建时声明 `resources[]`（路径前缀或 glob；MVP 可先路径前缀）
    - claim 成功 = 获取该 task 的资源 lease；`canWrite(path)` 通过 resources + lease(epoch/ttl) 判定
  - 定义幂等策略（MVP）：
    - HTTP 支持 `Idempotency-Key`（至少用于 createTask/startThread/postThreadMessage）
    - 重复请求（相同 key）应返回同一 object id 或同一语义结果（避免 LLM/客户端重试制造重复对象）
  - 定义 HTTP endpoints（/v1/..）与鉴权方式（Bearer token）

  **Must NOT do**:
  - 不上分布式一致性、不上推送（先轮询）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `writing-plans`
  - **Skills Evaluated but Omitted**: `ultrabrain`（不需要超高难推理）

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 Task 1 可并行）
  - **Blocks**: 3, 4, 5, 6, 7
  - **Blocked By**: None

  **References**:
  - `DRAFT.md` - 初始目录布局与字段建议
  - `https://code.claude.com/docs/en/agent-teams` - 对标语义（task list/mailbox/claim）
  - `https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md` - extension 能力边界（tool_call 拦截、sendMessage 注入）

  **Acceptance Criteria**:
  - [ ] 在仓库内新增一份协议文档（例如 `protocol.md` 或 `src/protocol/README.md`），包含：目录树、JSON/JSONL schema、状态机、HTTP endpoints、错误码约定
  - [ ] 协议明确写入两条硬性不变量：
    - 客户端不得写状态文件（single-writer）
    - extension 必须覆盖 `bash` 的写入绕过


- [x] 3. 实现文件 I/O 基础库（atomic JSON + JSONL + path safety）并用 TDD 验证

  **What to do**:
  - `writeJsonAtomic(path, data)`：temp 写入 + fsync + rename（同目录）+（可选）dir fsync
  - `appendJsonl(path, obj)`：单行 JSON + `\n`；写后 fsync；保证并发安全（teamd 单写者仍需防重入）
  - `readJsonlSafe(path)`：容忍尾部半行（忽略不完整最后一行或自动 truncate）
  - `safeJoin(teamRoot, relative)`：防 `..` 路径穿越；必要时 realpath 前缀校验；拒绝 symlink 逃逸（best-effort）
  - 文件权限：team 目录 0700；token/runtime 文件 0600

  **Must NOT do**:
  - 不把“只靠单写者”当作原子性替代；必须防半写/半行

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `test-driven-development`, `systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: NO（teamd 依赖此库）
  - **Blocks**: 4, 5, 6, 7
  - **Blocked By**: 1, 2

  **References**:
  - `DRAFT.md` - 原子写与 JSONL 设想
  - Metis review notes（在计划内已固化为不变量：尾部半行容忍、路径安全）

  **Acceptance Criteria**:
  - [ ] `npm test` 覆盖：
    - JSON 原子写：模拟写入中断不产生损坏 JSON
    - JSONL 半行：人为写入半行，读取仍能返回之前完整记录且不抛异常
    - 路径穿越：`../` 被拒绝
    - symlink：team root 内 symlink 写入被拒绝（或返回明确错误码）


- [x] 4. 实现 `teamd`（单写者核心 + HTTP API + lease fencing + audit）

  **What to do**:
  - teamd 启动：
    - 仅监听 loopback（127.0.0.1）
    - 生成 Bearer token（随机）
    - 写 runtime 文件（包含 url/token/pid/schemaVersion），权限 0600
    - 单实例锁（全局或 per-team），第二实例启动失败且给出可诊断信息
  - 数据面：
    - teams：create/list/show
    - tasks：create/list/get/claim/complete/fail + deps 解锁
    - threads：start/post/readTail/searchIndex + linkThreadToTask
    - inbox：per-agent 拉取（`since` 游标），写入通知（task_assigned/claimed/completed/thread_message/mention/conflict）
    - leases：TTL + renew + epoch fencing；提供 `canWrite` 判定给 extension
    - audit：append-only `audit/events.jsonl` 记录所有 state transition（event_id、actor、type、refs、ts）
  - 一致性：
    - per-team 串行队列处理所有 mutating 请求（线性化）
    - tasks 与 threads 为权威；inbox 可重建（缺通知不影响权威状态）

  **Must NOT do**:
  - 不在 MVP 引入 push 订阅（SSE/WS）
  - 不允许客户端直接写 team workspace 文件

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `test-driven-development`
  - **Skills Evaluated but Omitted**: `frontend-ui-ux`（非前端）

  **Parallelization**:
  - **Can Run In Parallel**: PARTIAL（与 Task 5/6 仅在 contract 稳定后可并行）
  - **Blocks**: 5, 6, 7
  - **Blocked By**: 1, 2, 3

  **References**:
  - `DRAFT.md` - teamd 职责、数据模型建议
  - `https://code.claude.com/docs/en/agent-teams` - 任务与 mailbox 的语义对标
  - Metis/Oracle 缺口：lease fencing、token、单实例锁、路径安全

  **Acceptance Criteria**:
  - [ ] `npm test` 覆盖：
    - 并发 claim：两请求竞争同一 task，只有一个成功（确定性）
    - lease 过期：过期后写入/complete 被拒绝（错误码明确）
    - epoch fencing：旧 epoch 的 complete 被拒绝
    - deps 解锁：deps completed 后 blocked→pending
    - createTask 幂等：相同 `Idempotency-Key` 重复 createTask 返回同一 taskId（或等价的幂等语义）
  - [ ] 通过 `npm run teamd:start -- --json`（或等价脚本）启动时，stdout 输出包含 `url` 与 `token`（或 tokenFile）
  - [ ] `GET /healthz` 返回 `{status:"ok", version:"..."}`（或同等固定字段）


- [x] 5. 实现 `pi-team` CLI（Command Chronicle 风格：事件流优先）

  **What to do**:
  - daemon：start/stop/status/logs（MVP 可仅 start + status）
  - team：create/list/show（create 会初始化 `~/.pi/teams/<teamId>` 目录结构与 team.json）
  - tasks：list/show/claim/complete（为人类操作与调试提供入口）
  - threads：list/tail/show/search
  - agent：
    - `pi-team agent env --team <id> --agent <agentId>` 输出 env export（teamId/agentId/teamdUrl/tokenFile）
    - 可选：`pi-team agent start ...` 直接 spawn `pi`（不要求 tmux，先前台）

  **Must NOT do**:
  - 不把 CLI 做成复杂 TUI；保持可脚本化

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: `test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES（在 Task 4 API 稳定后，与 Task 6 并行）
  - **Blocks**: 7, 8
  - **Blocked By**: 4

  **References**:
  - Artistry UX：Command Chronicle（inbox peek, thread tail, decide -> task）

  **Acceptance Criteria**:
  - [ ] `pi-team --help` 显示命令列表
  - [ ] `pi-team team create t_demo --leader leader` 成功创建目录与 team.json
  - [ ] `pi-team tasks list --team t_demo` 能列出 tasks（至少空列表）


- [x] 6. 实现 `team-coordination` 扩展（tools + inbox 注入 + 写入拦截）

  **What to do**:
  - 注册 Team tools（至少覆盖 MVP）：
    - tasks：create/claim/complete/fail/list
    - threads：start/post/readTail/search/linkToTask
    - help/arbitration：可先作为 thread wrapper（MVP 只要 startThread+participants 即可）
  - inbox polling：
    - `session_start` 启动轮询（可用 setInterval）
    - 拉取增量事件（since 游标）
    - 注入方式：默认仅注入短通知（1 行摘要 + refs），避免把整段 thread 倒进上下文
  - tool_call 拦截（MVP 必须保守正确）：
    - `write` / `edit`：调用 teamd `canWrite`，无 lease 则 block
    - `bash`：同样调用 `canWrite`（或更保守：无任意有效 lease 一律 block）
    - 无 UI 模式（ctx.hasUI=false）默认拒绝写
  - 失败反馈：使用 `ctx.ui.notify` + 返回 `{block:true, reason:"..."}`

  **Must NOT do**:
  - 不在 extension 内直接写 team workspace 状态文件
  - 不把 thread 全量注入上下文

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `test-driven-development`
  - **Skills Evaluated but Omitted**: `planning-with-files`（计划已固定）

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 Task 5 并行）
  - **Blocks**: 7
  - **Blocked By**: 4（至少需要 canWrite + tasks/threads API）

  **References**:
  - Extension docs：`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md`
  - 拦截示例：`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/protected-paths.ts`
  - bash gate 示例：`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/permission-gate.ts`
  - 注入/compaction 示例：`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/custom-compaction.ts`

  **Acceptance Criteria**:
  - [ ] 单测覆盖：无 lease 时 write/edit/bash 都会被 block（至少对 handler 逻辑做单测）
  - [ ] 单测覆盖：inbox 事件被压缩为短通知注入（不直接注入 thread 全文）

  **Agent-Executed QA Scenarios**:
  - Scenario: 无 lease 阻断写入
    - Tool: Bash + Node（不依赖真实 pi UI）
    - Steps:
      1. 启动 teamd（临时 team）
      2. 运行一个最小“extension harness”脚本：加载 extension 模块，构造 fake ctx/event，调用 `tool_call` handler
      3. 触发一次 `write` 与一次 `bash` 的拦截逻辑（目标 path 在受保护范围内）
      4. 断言：两者均返回 `{block:true}`；reason 包含 "lease"（或同等关键字）
    - Evidence: `.sisyphus/evidence/task-6-no-lease-block.json`


- [x] 7. e2e demo + 崩溃恢复演练（无 LLM 也可跑通）

  **What to do**:
  - 写一个 `demo:e2e` 脚本：
    - 创建 team
    - A、B 两个“模拟 agent”（Node 脚本）通过 API：
      - startThread + 互发消息（证明 peer discussion）
      - createTask（由 leader/agentA）
      - claimTask（agentB）→ completeTask（agentB）
      - agentA inbox 收到完成通知
  - 写一个 `demo:crash-recovery`：
    - 在写入中 kill teamd
    - 重启后：
      - tasks JSON 可解析
      - JSONL 读取不因尾部半行崩
      - 过期 lease 被释放（或被标记并可继续）
  - 输出 evidence 到 `.sisyphus/evidence/`

  **Must NOT do**:
  - 不依赖人工打开 TUI

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 4/5/6）
  - **Blocked By**: 4, 5, 6
  - **Blocks**: 8

  **References**:
  - `DRAFT.md` - 闭环 demo 目标
  - Metis 建议验收（healthz、幂等/错误码、crash recovery、symlink escape）

  **Acceptance Criteria**:
  - [ ] `npm run demo:e2e` 退出码 0
  - [ ] `.sisyphus/evidence/` 生成至少：inbox 拉取结果、thread tail、task 完成结果 JSON
  - [ ] `npm run demo:crash-recovery` 退出码 0


- [x] 8. 文档与快速上手（README + 运行手册）

  **What to do**:
  - README：安装、启动 teamd、创建 team、启动 agent（env exports）、常用 CLI
  - Extension 安装：
    - 全局安装到 `~/.pi/agent/extensions/` 的方式
    - 项目安装到 `.pi/extensions/` 的方式
  - 故障排查：token 文件权限、端口占用、双实例锁、JSONL 修复

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `writing-plans`

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 Task 7 末期并行）
  - **Blocked By**: 5, 6（需要命令与行为稳定）

  **Acceptance Criteria**:
  - [ ] README 包含端到端示例（复制粘贴可跑）
  - [ ] 文档明确 MVP 非目标（无推送/无跨机/无 RBAC）

---

## Commit Strategy（可选）

如果该目录后续纳入 git：
- 建议每个 TODO 任务一个原子提交；提交信息用 English（符合你的全局偏好）。

---

## Success Criteria

### Verification Commands
```bash
npm test
npm run demo:e2e
npm run demo:crash-recovery
```

### Final Checklist
- [x] teamd 单写者：客户端不直接写状态文件
- [x] extension 写拦截覆盖 write/edit/bash
- [x] tasks + deps + lease fencing 工作正常
- [x] threads + inbox 可跑通 peer discussion + 通知闭环
- [x] 原子写/JSONL 半行/路径安全/单实例锁 具备自动化测试
