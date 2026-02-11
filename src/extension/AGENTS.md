# EXTENSION MODULE NOTES

## OVERVIEW
Agent extension bridging tool calls to `teamd`, enforcing lease-based write restrictions.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Tool registration | src/extension/team-coordination.ts | guarded tools + inbox polling (src/extension/team-coordination.ts:33-199) |
| HTTP client | src/extension/teamd-client.ts | env discovery + auth headers (src/extension/teamd-client.ts:111-184) |
| Public exports | src/extension/index.ts | extension entrypoints |
| Docs | docs/extension.md | env vars + install + rules (docs/extension.md:25-64) |

## CONVENTIONS
- Guarded tools set: `write`, `edit`, `bash` (src/extension/team-coordination.ts:33-35).
- Tool names must be alnum/underscore/dash only (docs/extension.md:41-52).
- Env discovery precedence: `PI_TEAMD_TOKEN` overrides `PI_TEAMD_TOKEN_FILE` (docs/extension.md:37).

## ANTI-PATTERNS
- Do NOT allow write/edit/bash when lease missing; must block with reason (docs/extension.md:54-64).
- In no-UI mode, block writes by default (docs/extension.md:62-64).

## UNIQUE STYLES
- Inbox polling with one-line summaries (src/extension/team-coordination.ts:80-86).
- HTTP calls always carry Bearer token from env discovery (src/extension/teamd-client.ts:163-176).
