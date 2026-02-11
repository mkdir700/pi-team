# Plan: tmux-backed subagents for pi-team team mode

## Summary
Implement tmux-backed subagent tools in the **extension** (not teamd) to allow the leader to start/list/attach/capture worker sessions. Each worker runs an **interactive `pi`** inside its own tmux session, sessions persist after exit, and workers report via **threads only**. No inbox writes. No workspace writes outside teamd.

## Decisions (confirmed)
- Orchestration layer: **extension directly runs tmux**.
- Result handoff: **threads only**; if no `threadId`, **create a thread**.
- Worker process: **interactive `pi`**; **auto send-keys** with task prompt.
- Sessions must remain after exit.
- Attach tool returns instructions only.
- Naming strategy: prefix + incrementing index.
- Capture default: 1000 lines.
- tmux socket: **dedicated socket path** (non-workspace), e.g. `~/.pi/agent/tmux/<teamId>/tmux.sock`.

## Constraints & Non-goals
- Do **not** add any inbox write API.
- Do **not** bypass lease/epoch checks.
- Do **not** write to `~/.pi/teams/<teamId>/` from the extension.
- Do **not** invoke shell strings; use argv arrays only.
- Do **not** load user `.tmux.conf` (avoid `run-shell` risk).

## Tool surface (new extension tools)
> Names must match `/^[a-zA-Z0-9_-]+$/` and parameters must be **object JSON schemas**.

1) `team_tmux_start`
   - Inputs: `taskPrompt`, optional `threadId`, `sessionPrefix`, `cwd`, `lines` (optional for initial capture), `title` (thread title override).
   - Behavior:
     - Ensure tmux installed.
     - Resolve/validate session name (prefix + next index; safe identifier).
     - Ensure tmux socket dir exists (non-workspace).
     - Start tmux server with `-f /dev/null` + `-S <socket>`.
     - Create session + set `remain-on-exit on`.
     - Launch interactive `pi` and **send-keys** task prompt.
     - If no `threadId`, create thread via teamd, then post status + attach/capture instructions.

2) `team_tmux_list`
   - Inputs: optional `sessionPrefix`.
   - Behavior:
     - List sessions via tmux `list-sessions -F ...`, filter by prefix, return structured list.

3) `team_tmux_attach`
   - Inputs: `sessionName`.
   - Behavior:
     - Return `tmux -S <socket> attach -t <sessionName>` instructions only.

4) `team_tmux_capture`
   - Inputs: `sessionName`, optional `lines` (default 1000).
   - Behavior:
     - `capture-pane -p -S -<lines> -E -`, clamp lines to max.
     - Return capture text; optionally post to thread if `threadId` supplied.

## tmux command details (argv only, no shell)
- Start server (dedicated socket, no user config):
  - `tmux -f /dev/null -S <socket> start-server`
- Create session (detached):
  - `tmux -f /dev/null -S <socket> new-session -d -s <session> -n <window> <command...>`
- Set remain-on-exit:
  - `tmux -f /dev/null -S <socket> set-option -t <session> remain-on-exit on`
- Send keys (literal):
  - `tmux -f /dev/null -S <socket> send-keys -t <session>:0 -l <text>`
  - `tmux ... send-keys -t <session>:0 Enter`
- Capture:
  - `tmux -f /dev/null -S <socket> capture-pane -p -t <session>:0 -S -<lines> -E -`
- List:
  - `tmux -f /dev/null -S <socket> list-sessions -F "#{session_name} #{session_windows} #{session_created}"`

## Session persistence strategy
- Use tmux server (detached) so session persists after client exit.
- Set `remain-on-exit on` for panes to keep output visible post-exit.
- Avoid relying on shell wrappers; prefer direct command invocation.

## Security & safety
- **No shell** invocation; argv arrays only.
- **Sanitize identifiers**: session/prefix must match `[a-zA-Z0-9._-]`.
- **Disable tmux conf**: always pass `-f /dev/null`.
- **Minimal env**: strip `PI_TEAMD_TOKEN`, `PI_TEAMD_TOKEN_FILE`, `PI_TEAMD_URL`; keep PATH + HOME.
- **Guarded tool parity**: treat tmux start/capture as sensitive; call `canWrite` where applicable if running in project workspace.
- **Thread-only handoff**: always use `team_threads_*`; never write inbox.

## Data flow
1. Leader calls `team_tmux_start` with task prompt.
2. Extension ensures tmux session exists and starts `pi` interactively.
3. Extension creates thread (if missing) and posts initial message (session name + attach instructions).
4. Worker interacts in tmux; leader can `team_tmux_capture` and post to thread.

## Failure handling
- tmux missing → error `tmux_not_installed`.
- session exists → idempotent response.
- session missing on capture/attach → error `session_not_found`.
- capture too large → clamp and append truncation marker.
- tmux server/socket errors → structured error with command + stderr.

## Tests (Vitest)
- `tests/extension.test.ts`:
  - registers new tools with valid names + object schemas.
  - mock tmux runner: verify correct argv for start/list/attach/capture.
  - start creates thread when `threadId` missing; posts initial message.
- If adding a tmux runner module: unit tests for input validation + error mapping.

## Implementation steps (TDD)
1. Add tmux runner helper (new module under `src/extension/`):
   - spawn/execFile wrapper with timeout + stdout/stderr capture.
   - enforce argv-only execution and minimal env.
2. Extend `registerTools` in `src/extension/team-coordination.ts`:
   - register `team_tmux_*` tools with objectSchema.
   - implement start/list/attach/capture with validation and thread usage.
3. Update `docs/extension.md`:
   - document new tools, tmux requirement, and attach/capture usage.
4. Add tests to `tests/extension.test.ts`:
   - tool registration + schema; mocked tmux runner and teamd-client methods.

## Acceptance criteria
- New tools registered and schema-valid.
- `team_tmux_start` creates a tmux session, keeps it after exit, and posts to a thread.
- `team_tmux_list` returns sessions filtered by prefix.
- `team_tmux_attach` returns correct attach command (no hijack).
- `team_tmux_capture` returns last N lines with truncation.
- No inbox writes; no workspace writes outside teamd.
- All tests pass.
