# pi-team Protocol Specification (MVP)

This document defines the protocol for the `pi-team` multi-agent coordination system. It covers the workspace layout, data schemas, state machines, lease models, and the HTTP API contract.

## 1. Workspace Layout

All team data is stored under `~/.pi/teams/<teamId>/`.

```text
~/.pi/teams/<teamId>/
├── team.json           # Team configuration and agent definitions
├── runtime.json        # Current runtime info (url, token, pid) - 0600 permissions
├── tasks/              # Authoritative task state
│   ├── 0001.json
│   └── 0002.json
├── inboxes/            # Per-agent notification cache (rebuildable)
│   ├── leader.json
│   └── worker_a.json
├── threads/            # Discussion threads (JSONL, append-only)
│   ├── t-001.jsonl
│   └── t-002.jsonl
├── audit/              # Append-only audit log
│   └── events.jsonl
└── artifacts/          # Shared outputs (patches, summaries, etc.)
    ├── summaries/
    └── patches/
```

## 2. Authority & Recovery Rules

1.  **Single Writer**: Only the `teamd` daemon is allowed to write to the workspace directory. Clients (CLI, Extensions) MUST interact with the state via the HTTP API.
2.  **Authoritative State**: `tasks/*.json` and `threads/*.jsonl` are the source of truth.
3.  **Rebuildable Cache**: `inboxes/*.json` are transient notification queues and can be rebuilt from the audit log if necessary.
4.  **Audit Log**: `audit/events.jsonl` is append-only and records all state transitions. It is used for observability and tracing. The MVP does NOT require full deterministic replay from the audit log.

## 3. Data Models

All JSON files MUST include a `schemaVersion` field.

### 3.1 team.json
Defines the team structure and constraints.
```json
{
  "schemaVersion": "1.0.0",
  "teamId": "pi-team-dev",
  "agents": [
    { "id": "leader", "role": "leader", "model": "anthropic/claude-3-5-sonnet" },
    { "id": "worker_a", "role": "worker", "model": "anthropic/claude-3-5-haiku" }
  ],
  "budget": {
    "maxTokens": 1000000,
    "hardLimit": true
  }
}
```

### 3.2 task.json
Represents a unit of work.
```json
{
  "schemaVersion": "1.0.0",
  "id": "task-001",
  "title": "Implement file I/O",
  "description": "Create atomic write utilities",
  "status": "pending",
  "owner": null,
  "deps": [],
  "resources": ["src/io/"],
  "lease": null,
  "epoch": 0,
  "timestamps": {
    "createdAt": "2026-02-11T10:00:00Z",
    "startedAt": null,
    "completedAt": null
  }
}
```

### 3.3 Thread Message (JSONL line)
```json
{ "id": "msg-001", "threadId": "t-001", "from": "leader", "to": ["worker_a"], "body": "Please review the I/O spec.", "ts": "2026-02-11T10:05:00Z" }
```

### 3.4 Runtime Info (runtime.json)
```json
{
  "url": "http://127.0.0.1:4500",
  "token": "secret-bearer-token",
  "pid": 12345,
  "schemaVersion": "1.0.0"
}
```

### 3.5 Inbox Cache (inboxes/<agentId>.json)
Stores transient notifications for a specific agent.
```json
{
  "schemaVersion": "1.0.0",
  "agentId": "worker_a",
  "messages": [
    {
      "id": "evt-123",
      "type": "task_assigned",
      "payload": { "taskId": "task-001" },
      "ts": "2026-02-11T10:00:00Z"
    }
  ]
}
```

### 3.6 Audit Event (audit/events.jsonl line)
Append-only record of a state transition.
```json
{ "schemaVersion": "1.0.0", "id": "evt-123", "actor": "teamd", "type": "task_status_changed", "refs": { "taskId": "task-001" }, "data": { "old": "pending", "new": "in_progress" }, "ts": "2026-02-11T10:00:00Z" }
```

## 4. Task State Machine

**States**: `pending` -> `in_progress` -> `completed` | `failed` | `canceled`
- `blocked`: A task with incomplete dependencies (`deps`).
- `pending`: All dependencies are `completed`.
- `in_progress`: Claimed by an agent (has an active lease).

**Dependency Rule**: A task automatically moves from `blocked` to `pending` when all its `deps` reach the `completed` state.

## 5. Lease Model & Resource Scoping

### 5.1 Lease & Epoch
- **Lease**: When an agent claims a task, it receives a lease with a TTL (e.g., 5 minutes).
- **Renewal**: The agent must periodically renew the lease to keep the task `in_progress`.
- **Epoch**: Every time a task is claimed, its `epoch` increments.
- **Fencing**: All `completeTask` or `failTask` requests MUST include the `epoch`. If the epoch in the request does not match the current task epoch, the request is rejected (fencing).

### 5.2 Resource Scoping
- Tasks declare `resources[]` (path prefixes).
- An agent can only write to a path if it holds a valid lease for a task that covers that path.
- `teamd` provides a `GET /v1/can-write?path=...&agentId=...` endpoint for extensions to verify write permissions.

## 6. Idempotency

Mutating endpoints (`createTask`, `startThread`, `postThreadMessage`) MUST support the `Idempotency-Key` header.
- If a request with the same key is received, the server MUST return the same response as the original successful request.

## 7. HTTP API Contract (/v1)

**Auth**: All requests MUST include `Authorization: Bearer <token>`.

### 7.1 Endpoints
- `GET /v1/tasks`: List tasks.
- `POST /v1/tasks`: Create a task.
- `POST /v1/tasks/:id/claim`: Claim a task.
- `POST /v1/tasks/:id/renew`: Renew a lease.
- `POST /v1/tasks/:id/complete`: Mark task as completed (requires `epoch`).
- `POST /v1/tasks/:id/fail`: Mark task as failed (requires `epoch`).
- `GET /v1/inbox`: Poll for new notifications (uses `since` cursor).
- `POST /v1/threads`: Start a thread.
- `POST /v1/threads/:id/messages`: Post a message.
- `GET /v1/threads/:id/messages`: Read thread messages (supports `tail`).
- `GET /v1/can-write`: Check write permission for a path.

### 7.2 Error Codes
- `401 Unauthorized`: Missing or invalid token.
- `403 Forbidden`: Lease expired or resource not owned.
- `409 Conflict`: Epoch mismatch or task already claimed.
- `429 Too Many Requests`: Budget exceeded.

## 8. Hard Invariants

1.  **Single-Writer Enforcement**: Clients MUST NOT write to the workspace directory directly.
2.  **Bash Interception**: The `team-coordination` extension MUST intercept `bash` tool calls to prevent bypassing write restrictions.
3.  **Epoch Verification**: `teamd` MUST verify the `epoch` for all state-changing operations on a task.
4.  **Path Safety**: `teamd` MUST prevent path traversal (e.g., `../`) in all resource and file operations.

## 9. Examples

### Create Task Request
```http
POST /v1/tasks
Authorization: Bearer secret-token
Idempotency-Key: unique-uuid-123

{
  "title": "Fix bug",
  "description": "Fix the race condition in I/O",
  "resources": ["src/io/"]
}
```

### Claim Task Response
```json
{
  "taskId": "task-001",
  "lease": {
    "expiresAt": "2026-02-11T10:15:00Z",
    "epoch": 1
  }
}
```
