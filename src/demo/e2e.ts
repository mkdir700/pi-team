import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

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
const evidenceDir = join(evidenceRoot, "demo-e2e");
const workspaceRoot = join(evidenceRoot, "demo-workspace");

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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${method} ${path}: ${raw.trim()}`);
  }

  return {
    status: response.status,
    body: parsed,
  };
}

async function main(): Promise<void> {
  const teamId = "demo-e2e-team";
  const agentA = "agentA";
  const agentB = "agentB";

  await ensureCleanDir(evidenceDir);
  await ensureCleanDir(workspaceRoot);

  const { child, startup } = await startTeamd(teamId, workspaceRoot);
  try {
    await writeEvidence("teamd.json", startup);

    await apiRequest(startup, "POST", "/v1/teams", {
      teamId,
      agents: [
        { id: agentA, role: "leader" },
        { id: agentB, role: "worker" },
      ],
    });

    const initialInbox = await apiRequest<{ events: unknown[]; nextSince: string }>(
      startup,
      "GET",
      `/v1/inbox?teamId=${encodeURIComponent(teamId)}&agentId=${encodeURIComponent(agentA)}`,
    );

    const threadStart = await apiRequest<{ thread: { id: string } }>(startup, "POST", "/v1/threads", {
      teamId,
      title: "agent handoff",
      participants: [agentA, agentB],
      agentId: agentA,
    });
    const threadId = threadStart.body.thread.id;

    await apiRequest(startup, "POST", `/v1/threads/${encodeURIComponent(threadId)}/messages`, {
      teamId,
      agentId: agentA,
      message: "Please pick up task implementation.",
    });
    await apiRequest(startup, "POST", `/v1/threads/${encodeURIComponent(threadId)}/messages`, {
      teamId,
      agentId: agentB,
      message: "Acknowledged. I will complete it now.",
    });

    const threadTail = await apiRequest(startup, "GET", `/v1/threads/${encodeURIComponent(threadId)}/tail?teamId=${encodeURIComponent(teamId)}&limit=10`);
    await writeEvidence("thread-tail.json", threadTail.body);

    const taskCreate = await apiRequest<{ task: { id: string } }>(startup, "POST", "/v1/tasks", {
      teamId,
      title: "demo e2e task",
      description: "claim and complete from agentB",
      resources: ["src/demo"],
    });
    await writeEvidence("task-create.json", taskCreate.body);

    const taskId = taskCreate.body.task.id;
    const taskClaim = await apiRequest<{ task: { id: string }; lease: { epoch: number } }>(
      startup,
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      {
        teamId,
        agentId: agentB,
        ttlMs: 30_000,
      },
    );
    await writeEvidence("task-claim.json", taskClaim.body);

    const taskComplete = await apiRequest<{ task: { id: string; status: string } }>(
      startup,
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        teamId,
        agentId: agentB,
        epoch: taskClaim.body.lease.epoch,
      },
    );
    await writeEvidence("task-complete.json", taskComplete.body);

    await sleep(100);

    const inboxA = await apiRequest<{ events: Array<{ type: string; taskId?: string }>; nextSince: string }>(
      startup,
      "GET",
      `/v1/inbox?teamId=${encodeURIComponent(teamId)}&agentId=${encodeURIComponent(agentA)}&since=${encodeURIComponent(
        initialInbox.body.nextSince,
      )}`,
    );
    await writeEvidence("inbox-agentA.json", inboxA.body);

    const sawCompletion = inboxA.body.events.some((event) => event.type === "task_completed" && event.taskId === taskId);
    if (!sawCompletion) {
      throw new Error("agentA inbox did not contain task_completed event");
    }
  } finally {
    await stopTeamd(child);
  }
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
