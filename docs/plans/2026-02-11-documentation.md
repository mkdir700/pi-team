# Documentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create comprehensive README and supporting documentation for the pi-team project.

**Architecture:** 
- `README.md`: Main entry point with quick start, CLI, and demo instructions.
- `docs/extension.md`: Detailed extension installation and configuration.
- `docs/troubleshooting.md`: Troubleshooting guide and MVP non-goals.

**Tech Stack:** Markdown

---

### Task 1: Create README.md

**Files:**
- Create: `README.md`

**Step 1: Draft README.md**
Include:
- Project overview
- Installation (Node 20+, npm)
- Build and Test commands
- Starting `teamd` (with `--json`)
- CLI usage (`pi-team`)
- Running demos (`npm run demo:e2e`, `npm run demo:crash-recovery`)
- Evidence location (`.sisyphus/evidence/`)

### Task 2: Create docs/extension.md

**Files:**
- Create: `docs/extension.md`

**Step 1: Draft docs/extension.md**
Include:
- Global vs Project-local installation
- Environment variables (`PI_TEAM_ID`, `PI_AGENT_ID`, `PI_TEAMD_URL`, `PI_TEAMD_TOKEN_FILE`)
- Tool registration details

### Task 3: Create docs/troubleshooting.md

**Files:**
- Create: `docs/troubleshooting.md`

**Step 1: Draft docs/troubleshooting.md**
Include:
- Token file permissions (0600)
- Port in use / loopback only
- Single-instance lock file
- JSONL partial line recovery
- MVP Non-goals (no push/SSE/WS, no cross-machine, no RBAC)

### Task 4: Final Review and Verification

**Step 1: Verify links and commands**
Ensure all cross-references work and commands are copy-pasteable.
