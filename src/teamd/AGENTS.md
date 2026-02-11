# TEAMD MODULE NOTES

## OVERVIEW
Daemon runtime: HTTP API + persistent store for tasks, threads, inbox, audit.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Bootstrap | src/teamd/index.ts | startTeamd + runtime.json + lock (src/teamd/index.ts:92-145) |
| HTTP routes | src/teamd/server.ts | /v1 routing + auth + error handling (src/teamd/server.ts:108-200) |
| State store | src/teamd/store.ts | task/thread/inbox/audit persistence (src/teamd/store.ts:233-786) |
| IO safety | src/io/index.ts | safeJoin + JSONL + atomic writes (src/io/index.ts:49-168) |
| Tests | tests/teamd.test.ts | API + lease + idempotency coverage |

## CONVENTIONS
- `/v1/*` routes require Bearer token; unauthorized returns 401 (src/teamd/server.ts:123-133).
- Idempotency for task creation via Idempotency-Key (src/teamd/store.ts:90-97, 312-365).
- File layout lives under `~/.pi/teams/<teamId>/` with JSON + JSONL (protocol.md:5-24).
- JSONL reads tolerate trailing partial line (src/io/index.ts:99-115).

## ANTI-PATTERNS
- Never write workspace files directly outside IO helpers (use writeJsonAtomic/appendJsonl/safeJoin).
- Do NOT accept task completion/failure without epoch fencing (protocol.md:128-133).
- Inbox is a cache; do NOT treat it as authoritative state (protocol.md:31-34).

## UNIQUE STYLES
- Single-writer lock per team; lock file enforces one instance (src/teamd/index.ts:101-108).
- Resource scoping: tasks declare `resources[]`, write permission checked by `can-write` (protocol.md:134-137).
