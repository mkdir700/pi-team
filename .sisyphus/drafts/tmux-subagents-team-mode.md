# Draft: tmux-backed subagents for pi-team “team mode”

## Goal (user-stated)
- In current behavior, giving `pi` a prompt causes it to create tasks, connect tasks, and then auto-claim tasks.
- You want to **constrain the main agent’s capabilities via built-in system prompt**, and you want the **main agent (leader) to be able to create subagents (workers)**.
- You expect subagents to run **in independent tmux sessions** (visualization + manual takeover).

## Requirements (confirmed)
- Team mode semantics:
  - If the user explicitly assigns what each worker should do → follow the instruction.
  - If the user is vague → leader decides and decomposes work into multiple workers.
  - Leader must support creating/spawning child agents.
- Subagent runtime: **each worker runs in an independent tmux session**.

## UX/behavior preferences (confirmed)
From your selections “1.A 2.B 3.A 4.A”:
- 1.A: tmux subagent is primarily for **visualization + manual takeover** (not necessarily full streaming UI).
- 2.B: tmux sessions should **remain after completion** (do not auto-kill).
- 3.A: integrate as a **pi-team extension tool**.
- 4.A: **tmux must be installed**; missing tmux should be a hard error (no fallback).

## Latest decisions (confirmed)
From your latest answers:
- pi CLI flags/behavior: **consistent with pi-mono**.
- Tool surface: **"按推荐进行"** (i.e., implement the recommended companion tools beyond just start).
- System prompt injection: **A** (inline; no temp-file prompt injection).
- Result handoff channel: **A** (when no threadId is provided, leader **creates a thread** and workers **post to threads only**; do **not** add any inbox write/post API).
- tmux orchestration layer: **Extension directly runs tmux** (no CLI delegation).
- Worker process shape in tmux: **Interactive pi** (for visualization/manual takeover), with tmux `remain-on-exit` keeping pane visible after exit.
- `attach` tool semantics: **Return attach command/instructions** (do not hijack the current pi process).
- Naming strategy: **prefix + incrementing index** (avoid collisions; list/filter by prefix).
- `start` behavior: **auto send-keys** to feed the task instruction into the interactive pi session.
- `capture` default: **1000 lines** (parameter can override).

## Key repo findings (evidence)

### Extension: tool registration + write guards
- Tool registrations live in:
  - `src/extension/team-coordination.ts`
    - registers `team_tasks_*` and `team_threads_*` tools via `pi.registerTool(...)` using JSON schema helpers (`objectSchema`, etc.).
    - intercepts `write`, `edit`, `bash` and blocks if no UI or no active lease (`/v1/can-write`).
    - evidence: `src/extension/team-coordination.ts:34-35, 126-300, 349-367`
- Teamd client discovery + HTTP calls:
  - `src/extension/teamd-client.ts`
    - can auto-discover `runtime.json` under `${HOME}/.pi/teams/*/runtime.json` (or `PI_TEAM_WORKSPACE_ROOT`).
    - uses `Authorization: Bearer <token>` and calls `/v1/tasks`, `/v1/inbox`, `/v1/threads/*`, `/v1/can-write`.
    - evidence: `src/extension/teamd-client.ts:118-164, 188-250, 252-288, 294-327`
- Extension tool naming constraints are tested:
  - `tests/extension.test.ts` checks tool names match `/^[a-zA-Z0-9_-]+$/` and parameters use object JSON schema.
  - evidence: `tests/extension.test.ts:80-121`

### Test infrastructure (repo-local)
- Test runner: Vitest
  - `package.json` scripts: `"test": "vitest run"` (and `vitest` devDependency)
  - evidence: `package.json:20-27, 39-44`
- Vitest config includes tests under `tests/**/*.test.ts`
  - evidence: `vitest.config.ts:1-7`
- Tests are located in `tests/` (not in `.github/workflows/`)
  - evidence (examples):
    - `tests/extension.test.ts`
    - `tests/teamd.test.ts`
    - `tests/teamd-client.test.ts`
    - `tests/cli.test.ts`

### teamd: task lifecycle has no auto-claim
- Task creation sets status to `blocked` or `pending` and does not claim/lease.
- Claim is explicit via `POST /v1/tasks/:id/claim` → store increments epoch and assigns lease.
- evidence:
  - API routes: `src/teamd/server.ts:175-233`
  - create/claim logic: `src/teamd/store.ts:297-375, 391-438`
  - protocol lease/epoch fencing: `protocol.md:126-137`

### tmux authoritative commands (external)
- Man page reference with relevant primitives:
  - `tmux new-session -d -s <name> -n <window> <cmd>`
  - keep panes after exit: `set-option -w remain-on-exit on|failed`
  - capture output: `pipe-pane` (stream) and `capture-pane -p -aS -` (snapshot)
  - session checks: `has-session`, `list-sessions`, attach/detach
- primary source: https://man.openbsd.org/tmux.1

### Architecture guidance (Oracle)
- Recommended: keep `teamd` as registry/message bus; do tmux orchestration in CLI; extension should ideally call CLI rather than managing tmux directly.
- Rationale: avoids expanding `teamd` into a privileged command runner; keeps guarded tools model intact.
- (Note: this recommendation may conflict with your preference 3.A unless we implement the tool in extension but delegate to CLI.)

### CLI surface (current)
- `pi-team` CLI currently implements (in code) only:
  - `agent env --team ... --agent ...` (prints exports)
  - `daemon status --team ...`
  - evidence: `src/cli/run.ts:63-115`
- `src/cli/help.ts` lists additional commands (`daemon start`, `team create`, `tasks list`, `threads list|tail|show`) but they are not implemented in `run.ts` yet.
  - evidence: `src/cli/help.ts:8-13` + `src/cli/run.ts:63-115`

## External reference already reviewed
- pi-mono subagent example (not tmux-based):
  - `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/README.md`
  - local checkout was read under `/tmp/pi-mono/.../examples/extensions/subagent/*`
  - it spawns `pi` subprocesses using `spawn("pi", ...)` and `--append-system-prompt`, but does not create tmux sessions.

## Research findings (authoritative)

### pi-mono CLI flags (evidence)
From `badlogic/pi-mono` commit `34878e7cc8074f42edff6c2cdcc9828aa9b6afde`:
- `--append-system-prompt <text>` parses as a string argument (help says: “Append text or file contents to the system prompt”).
  - Evidence: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L85-L86
  - Help: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L195
- `--mode json` accepts `text|json|rpc`.
  - Evidence: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L68-L72
  - Mode type: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L10
- `-p/--print` enables non-interactive mode.
  - Evidence: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L121-L122
  - Help: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L197
- `--no-session` disables session persistence (“ephemeral”).
  - Evidence: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L87-L88
  - Help: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/src/cli/args.ts#L202

### pi-mono subagent example: standard arg bundle
- Typical subagent invocation uses: `--mode json -p --no-session` and conditionally `--append-system-prompt`.
  - Evidence: https://github.com/badlogic/pi-mono/blob/34878e7cc8074f42edff6c2cdcc9828aa9b6afde/packages/coding-agent/examples/extensions/subagent/index.ts#L247-L280

## Scope boundaries (draft)
- INCLUDE:
  - add capability for leader to spawn worker subagents in tmux sessions
  - keep sessions around post-run
  - integrate through pi-team extension tool surface (direct or via CLI delegation)
- EXCLUDE (not confirmed yet):
  - any teamd feature that runs processes (high risk)
  - changing lease/epoch invariants

## Open questions (need user answers)
1) Where should tmux be orchestrated in practice?
   - (A) Extension tool directly runs tmux
   - (B) Extension tool delegates to `pi-team` CLI (recommended by Oracle)
2) What exactly is a “worker subagent process”?
   - Spawn a full `pi` instance in tmux with a worker system prompt?
   - Or spawn a lightweight CLI that only claims tasks + posts summaries?
3) “attach” tool semantics:
   - (A) Return an attach command/instructions (e.g., `tmux attach -t <session>`)
   - (B) Attempt to attach from within the tool call (likely disruptive)

## Correction log
- Earlier assumption that tests were under `.github/workflows/*.test.ts` was incorrect for this repo snapshot; tests live under `tests/` per `vitest.config.ts`.
