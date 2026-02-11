import { spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readJsonlSafe } from "../io/index.js";

interface TeamdStartup {
  url: string;
  token: string;
  pid: number;
  teamId: string;
  schemaVersion: string;
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

type TeamdChild = ChildProcessByStdio<null, Readable, Readable>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const evidenceRoot = join(projectRoot, ".sisyphus", "evidence");
const evidenceDir = join(evidenceRoot, "demo-crash-recovery");
const workspaceRoot = join(evidenceRoot, "demo-workspace", "crash-recovery");

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function ensureCleanDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

async function writeEvidence(fileName: string, payload: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseJsonSafe(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { raw: trimmed };
  }
}

async function waitForExit(child: TeamdChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("teamd process did not exit in time"));
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function stopTeamd(child: TeamdChild): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function startTeamd(teamId: string, workspace: string): Promise<{ child: TeamdChild; startup: TeamdStartup }> {
  const teamdBin = join(projectRoot, "dist", "bin", "teamd.js");
  const child = spawn(process.execPath, [teamdBin, "--json", "--team", teamId, "--workspace-root", workspace, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const startup = await new Promise<TeamdStartup>((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`Timed out waiting for teamd startup JSON. stderr=${stderrBuffer.trim()}`));
      }
    }, 10_000);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as TeamdStartup;
          if (!parsed.url || !parsed.token) {
            continue;
          }

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolvePromise(parsed);
            return;
          }
        } catch {
          continue;
        }
      }
    });

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectPromise(error);
      }
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectPromise(
          new Error(`teamd exited before startup payload: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrBuffer.trim()}`),
        );
      }
    });
  });

  return { child, startup };
}

async function apiRequest<T>(
  startup: TeamdStartup,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  allowError = false,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${startup.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${startup.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const parsed = parseJsonSafe(raw) as T;
  if (!response.ok && !allowError) {
    throw new Error(`HTTP ${response.status} ${method} ${path}: ${raw.trim()}`);
  }

  return {
    status: response.status,
    body: parsed,
  };
}

async function assertTaskFilesParseable(teamRoot: string): Promise<{ parsedCount: number; files: string[] }> {
  const tasksDir = join(teamRoot, "tasks");
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);

  for (const fileName of files) {
    const raw = await readFile(join(tasksDir, fileName), "utf8");
    JSON.parse(raw);
  }

  return {
    parsedCount: files.length,
    files,
  };
}

async function main(): Promise<void> {
  const teamId = "demo-crash-team";
  const agentA = "agentA";
  const agentB = "agentB";
  let firstChild: TeamdChild | null = null;
  let secondChild: TeamdChild | null = null;

  await ensureCleanDir(evidenceDir);
  await ensureCleanDir(workspaceRoot);

  try {
    const firstStart = await startTeamd(teamId, workspaceRoot);
    firstChild = firstStart.child;
    await writeEvidence("teamd-start.json", firstStart.startup);

    await apiRequest(firstStart.startup, "POST", "/v1/teams", {
      teamId,
      agents: [
        { id: agentA, role: "leader" },
        { id: agentB, role: "worker" },
      ],
    });

    const threadStart = await apiRequest<{ thread: { id: string } }>(firstStart.startup, "POST", "/v1/threads", {
      teamId,
      title: "crash drill",
      participants: [agentA, agentB],
      agentId: agentA,
    });
    const threadId = threadStart.body.thread.id;

    await apiRequest(firstStart.startup, "POST", `/v1/threads/${encodeURIComponent(threadId)}/messages`, {
      teamId,
      agentId: agentA,
      message: "message before simulated crash",
    });

    const taskCreate = await apiRequest<{ task: { id: string } }>(firstStart.startup, "POST", "/v1/tasks", {
      teamId,
      title: "lease-expiry-after-restart",
      resources: ["src/demo"],
    });
    const taskId = taskCreate.body.task.id;

    const taskClaim = await apiRequest<{ lease: { epoch: number } }>(
      firstStart.startup,
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      {
        teamId,
        agentId: agentB,
        ttlMs: 120,
      },
    );

    const threadFilePath = join(workspaceRoot, teamId, "threads", `${threadId}.jsonl`);
    await appendFile(threadFilePath, '{"partial":', "utf8");
    await writeEvidence("thread-corruption.json", {
      threadId,
      threadFilePath,
      note: "Appended a truncated JSONL line to simulate crash-interrupted append.",
    });

    await stopTeamd(firstStart.child);
    firstChild = null;

    await sleep(180);

    const restart = await startTeamd(teamId, workspaceRoot);
    secondChild = restart.child;
    await writeEvidence("teamd-restart.json", restart.startup);

    const parseResult = await assertTaskFilesParseable(join(workspaceRoot, teamId));
    await writeEvidence("tasks-parseable.json", parseResult);

    const safeThreadLines = await readJsonlSafe(threadFilePath);
    await writeEvidence("thread-readJsonlSafe.json", {
      threadId,
      lineCount: safeThreadLines.length,
      lines: safeThreadLines,
    });

    const completeAfterRestart = await apiRequest<Record<string, unknown>>(
      restart.startup,
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        teamId,
        agentId: agentB,
        epoch: taskClaim.body.lease.epoch,
      },
      true,
    );
    await writeEvidence("lease-expired-complete.json", completeAfterRestart);
    if (completeAfterRestart.status === 200) {
      throw new Error("Expected expired lease completion to fail after restart, but it succeeded.");
    }

    const reclaim = await apiRequest<Record<string, unknown>>(
      restart.startup,
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      {
        teamId,
        agentId: agentB,
        ttlMs: 5_000,
      },
      true,
    );
    await writeEvidence("lease-reclaim.json", reclaim);
  } finally {
    if (firstChild) {
      await stopTeamd(firstChild);
    }
    if (secondChild) {
      await stopTeamd(secondChild);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
