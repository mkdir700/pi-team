# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-11 12:39 (Asia/Shanghai)
**Commit:** 6c03fe2
**Branch:** main

## OVERVIEW
TypeScript ESM runtime for multi-agent coordination: `teamd` daemon + CLI + extension for guarded tool access and lease-based writes.

## STRUCTURE
```
./
├── src/                 # TypeScript sources (daemon, CLI, extension, IO)
├── tests/               # Vitest suite (*.test.ts)
├── docs/                # Extension + troubleshooting docs
├── dist/                # Build outputs (JS + d.ts)
├── protocol.md          # Runtime protocol + invariants
└── README.md            # Quick start + commands
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Start daemon | src/teamd/index.ts | startTeamd writes runtime.json + lock (src/teamd/index.ts:92-145) |
| HTTP API | src/teamd/server.ts | /v1 routes + auth checks (src/teamd/server.ts:108-200) |
| State store | src/teamd/store.ts | tasks/threads/inbox/audit; idempotency (src/teamd/store.ts:233-796) |
| IO safety | src/io/index.ts | safeJoin + JSONL + atomic writes (src/io/index.ts:49-168) |
| CLI | src/cli/run.ts, src/bin/*.ts | pi-team / teamd entrypoints (src/cli/run.ts:63-115; src/bin/teamd.ts:66-105) |
| Extension | src/extension/* | guarded tools + client (src/extension/team-coordination.ts:33-199) |
| Protocol | protocol.md | single-writer, leases, epoch rules (protocol.md:29-72) |
| Troubleshooting | docs/troubleshooting.md | permissions, lock, JSONL recovery (docs/troubleshooting.md:5-33) |

## CODE MAP (MANUAL)
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| startTeamd | function | src/teamd/index.ts | daemon bootstrap + runtime.json |
| startTeamdHttpServer | function | src/teamd/server.ts | HTTP API + auth |
| TeamdStore | class | src/teamd/store.ts | persisted task/thread state |
| createTeamdClient | function | src/extension/teamd-client.ts | client for teamd HTTP |
| registerTeamCoordinationExtension | function | src/extension/team-coordination.ts | guarded tool registration |
| runCli | function | src/cli/run.ts | CLI command routing |
| formatHelp | function | src/cli/help.ts | CLI help text |

## CONVENTIONS (DEVIATIONS ONLY)
- ESM package: `type: "module"` in package.json; NodeNext module resolution (tsconfig.json).
- Build outputs in `dist/`; exports/bin point to dist artifacts (package.json:6-26).
- Tests live in `tests/` with `*.test.ts`; Vitest include pattern `tests/**/*.test.ts` (vitest.config.ts:1-6).

## ANTI-PATTERNS (THIS PROJECT)
- Clients MUST NOT write to workspace directly; only `teamd` writes state (protocol.md:31-33).
- Do NOT bypass lease/epoch checks for task completion (protocol.md:31-33, 128-133).
- Do NOT expose `teamd` to public network; it is localhost-only (docs/troubleshooting.md:30-33).
- Extensions must block `write/edit/bash` without valid lease (docs/extension.md:54-64).

## UNIQUE STYLES
- Single-writer daemon with lease + epoch fencing (protocol.md:29-37, 126-133).
- JSONL append-only threads/audit with tail recovery (protocol.md:17-24; docs/troubleshooting.md:17-19).
- Guarded tools model (`write`, `edit`, `bash`) enforced by extension (docs/extension.md:54-59).

## COMMANDS
```bash
npm run build
npm test
npm run typecheck
npm run teamd:start -- --json
npm run demo:e2e
npm run demo:crash-recovery
```

## NOTES
- runtime.json must be 0600; teamd uses 127.0.0.1 host by default (docs/troubleshooting.md:5-12; src/teamd/index.ts:112-129).
- Single-instance lock per team (.teamd.lock) (src/teamd/index.ts:101-108; docs/troubleshooting.md:13-16).
