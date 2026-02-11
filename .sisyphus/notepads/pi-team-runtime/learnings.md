# Learnings

## 2026-02-11: Initial Repository Inspection

### Current State
- The repository is a greenfield project.
- Existing files: `DRAFT.md`, `.git/`, `.sisyphus/`.
- Missing: `package.json`, `tsconfig.json`, `src/`, `tests/`, and all other project scaffolding.
- Environment: Node `v22.19.0`, npm `10.9.3`.

### Constraints & Requirements (from DRAFT.md)
- **Components**: `teamd` (daemon), `pi-team` (CLI), `team-coordination` (extension).
- **Data Protocol**: File-based storage in `~/.pi/teams/<teamId>/` using JSON and JSONL.
- **Tech Stack**: TypeScript, ESM, Vitest.
- **Architecture**: Single-writer daemon (`teamd`) to ensure consistency.

### Recommendations for Task 1
1. **Layout**: Use a structured `src/` directory with subdirectories for `core`, `teamd`, `cli`, and `extension`.
2. **ESM**: Enable `"type": "module"` in `package.json` to leverage modern Node.js features.
3. **Validation**: Use `zod` for defining and validating the file-based protocols (tasks, threads, etc.) described in `DRAFT.md`.
4. **Testing**: Set up Vitest with support for workspace-like testing if components grow complex.
5. **Entry Points**: Define clear entry points in `package.json` for `pi-team` and `teamd`.


## [2026-02-11] Task 1: DRAFT.md Analysis Findings

### Data Model Summary
- **Team**: Manages agents, budget, and runtime config.
- **Task**: Core unit of work with status, deps, resources (for locking), and lease.
- **Inbox**: Notification layer for agents (task assignments, mentions, etc.).
- **Thread**: Peer-to-peer discussion carrier (JSONL append-only).

### Directory Layout
- Root: `~/.pi/teams/<teamId>/`
- Subdirs: `tasks/`, `inboxes/`, `threads/`, `index/`, `artifacts/`, `logs/`.

### Protocol Key Points
- **Single Writer**: `teamd` is the only process allowed to write to the workspace.
- **Atomic Writes**: Essential for consistency (temp + rename for JSON).
- **Lease Fencing**: Uses epochs to prevent stale workers from completing tasks.
- **Idempotency**: `Idempotency-Key` for mutating API calls.

### Identified Risks/Ambiguities
- Schema versioning and migration strategy.
- Detailed artifact linking and storage structure.
- Specific lease TTL and renewal intervals.
- Conflict detection logic beyond simple lease expiry.

## [2026-02-11 00:14:34] Task 1 Scaffold Decisions
- Chose **TypeScript + ESM** (`"type": "module"`) to match Node 22 and future multi-entry runtime modules.
- Build uses **tsc** (`tsconfig.build.json`) for minimal tooling and deterministic `dist/` output.
- Output paths standardized to `dist/`: CLI at `dist/bin/pi-team.js`, library root at `dist/index.js`, future entrypoints at `dist/teamd/index.js` and `dist/extension/index.js`.

## [2026-02-10 16:24:18Z] Task 3 IO behavior notes
- Atomic JSON durability pattern is stable on macOS with `write temp -> fsync(temp fd) -> rename -> best-effort fsync(parent dir)`; the final file remains parseable even when unrelated partial temp files exist.
- JSONL reader should drop the non-newline-terminated last fragment to tolerate crash-interrupted appends, while still throwing for malformed complete lines.
- Symlink escape checks should inspect each existing path segment via `lstat`/`realpath`; lexical `resolve` alone cannot detect `teamRoot/evil -> /outside` escapes.

## [2026-02-11 01:12:00Z] Plan Tracking
- Marked `.sisyphus/plans/pi-team-runtime.md` checkboxes as completed after verifying: `npm test`, `npm run build`, `npm run typecheck`, `npm run demo:e2e`, `npm run demo:crash-recovery`.

## [2026-02-11] pi-mono Extension Implementation Crib Sheet

This crib sheet summarizes the key APIs and patterns for implementing the `team-coordination` extension, based on `pi-mono` documentation and examples.

### 1. Extension Structure & Registration
Extensions are TypeScript modules that export a default function receiving `ExtensionAPI`.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Registration logic here
}
```

### 2. Registering Custom Tools
Use `pi.registerTool()` to add tools callable by the LLM.

```typescript
pi.registerTool({
  name: "team_notify",
  label: "Team Notify",
  description: "Send a notification to the team inbox",
  parameters: Type.Object({
    message: Type.String({ description: "Notification content" }),
    priority: Type.Optional(Type.String({ enum: ["low", "normal", "high"] }))
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Implementation logic
    return {
      content: [{ type: "text", text: "Notification sent" }],
      details: { status: "success" }
    };
  }
});
```

### 3. Lifecycle Events
Key events for interception and state management:
- `session_start`: Fired on initial load.
- `before_agent_start`: Before agent loop; can inject messages or modify system prompt.
- `tool_call`: Before tool executes; **can block**.
- `tool_result`: After tool executes; can modify result.
- `session_before_compact`: Before compaction; can customize summary.
- `agent_end`: After agent finishes all turns for a prompt.

### 4. Intercepting & Blocking Tool Calls (write/edit/bash)
Return `{ block: true, reason: "..." }` from a `tool_call` handler to prevent execution.

```typescript
pi.on("tool_call", async (event, ctx) => {
  // Intercept Bash
  if (event.toolName === "bash") {
    const command = event.input.command as string;
    if (command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command blocked" };
    }
  }

  // Intercept Write/Edit
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = event.input.path as string;
    if (path.startsWith(".pi/teams/")) {
      return { block: true, reason: "Direct writes to team data are forbidden. Use team tools." };
    }
  }
});
```

### 5. Handling No-UI Mode
Check `ctx.hasUI` before attempting user interaction.

```typescript
if (!ctx.hasUI) {
  return { block: true, reason: "Interaction required but no UI available" };
}
const choice = await ctx.ui.select("Confirm action", ["Yes", "No"]);
```

### 6. User Notification & Message Injection
- **UI Toasts**: `ctx.ui.notify(message, "info" | "warning" | "error" | "success")`
- **Inject Message (LLM Context)**: `pi.sendMessage(message, options)`
- **Trigger Agent (User Message)**: `pi.sendUserMessage(text, options)`

**Delivery Modes (`deliverAs`):**
- `"steer"`: Interrupts streaming, delivered after current tool.
- `"followUp"`: Waits for agent to finish all tools.
- `"nextTurn"`: Queued for next user prompt.

```typescript
// Inject a steering message
pi.sendMessage({
  customType: "team-update",
  content: "New task assigned to you.",
  display: true
}, { deliverAs: "steer", triggerTurn: true });
```

### 7. Source Documentation URLs
- [Extension Docs](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md)
- [Protected Paths Example](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/protected-paths.ts)
- [Permission Gate Example](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/permission-gate.ts)
- [Custom Compaction Example](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/examples/extensions/custom-compaction.ts)

### Verification: Must Implement in Task 6
- [ ] Use `pi.on("tool_call", ...)` to intercept `write`, `edit`, and `bash`.
- [ ] Implement path validation for `~/.pi/teams/` to enforce "teamd-only" writes.
- [ ] Use `ctx.hasUI` to fail gracefully in non-interactive environments.
- [ ] Use `pi.sendMessage` with `deliverAs: "steer"` for real-time team coordination updates.
- [ ] Register `team_` prefixed tools for task management (claim, complete, etc.).
- [ ] Handle `session_before_compact` to ensure team-related context is preserved or summarized correctly.

## [2026-02-11T00:38:00Z] Task 4 teamd runtime/lock behavior notes

- macOS + Node `fs.open(lock, "wx")` is sufficient for single-instance lock semantics; on second start it fails with `EEXIST`, and reading lockfile payload (`pid`, `startedAt`) gives actionable diagnostics without guessing stale state.
- For daemon startup verification in CI-like shells, `npm run teamd:start -- --json` should be treated as long-running; capture first JSON line (`url`, `token`) then terminate by signal, instead of waiting for natural exit.
- Built-in `fetch` in Node 22 is stable for concurrent claim race tests; `Promise.all` with two `POST /claim` calls reliably produces one `200` and one `409` when mutation queue is serialized.

## [2026-02-11T00:45:00Z] Task 5 pi-team CLI conventions

- Keep `pi-team` command outputs scriptable by default: stable one-line JSON for `daemon status`, `tasks list`, and placeholder `threads` subcommands.
- `agent env` prints plain `export KEY=value` lines in fixed order: `PI_TEAM_ID`, `PI_AGENT_ID`, `PI_TEAMD_URL`, `PI_TEAMD_TOKEN_FILE`.
- Runtime discovery is read-only from `<workspaceRoot>/<teamId>/runtime.json`; CLI never mutates team state files directly.
- `team create` prefers API calls; if runtime is missing it can bootstrap by starting `teamd` and then issuing `POST /v1/teams`.
