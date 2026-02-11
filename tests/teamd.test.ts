import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { startTeamd, type TeamdHandle } from "../src/teamd/index.js";

type JsonObject = Record<string, unknown>;

const tempDirs: string[] = [];
const runningServers: TeamdHandle[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-team-teamd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    if (server) {
      await server.close();
    }
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startForTest(): Promise<TeamdHandle> {
  const workspaceRoot = await createTempDir();
  const server = await startTeamd({
    teamId: "test-team",
    workspaceRoot,
    token: "test-token",
    port: 0,
  });
  runningServers.push(server);
  return server;
}

async function apiRequest(
  server: TeamdHandle,
  path: string,
  init: {
    method?: string;
    body?: JsonObject;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test-token");
  if (init.body) {
    headers.set("content-type", "application/json");
  }

  return fetch(`${server.url}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("teamd", () => {
  it("returns healthz payload", async () => {
    const server = await startForTest();

    const response = await fetch(`${server.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      version: "1.0.0",
    });
  });

  it("requires Bearer token for /v1 routes", async () => {
    const server = await startForTest();

    const response = await fetch(`${server.url}/v1/tasks?teamId=test-team`);

    expect(response.status).toBe(401);
  });

  it("writes runtime.json with private permissions", async () => {
    const server = await startForTest();

    const runtimeRaw = await readFile(server.runtimeFile, "utf8");
    const runtimeMode = (await stat(server.runtimeFile)).mode & 0o777;

    expect(JSON.parse(runtimeRaw)).toMatchObject({
      schemaVersion: "1.0.0",
      pid: process.pid,
      token: "test-token",
      url: server.url,
    });
    expect(runtimeMode).toBe(0o600);
  });

  it("fails on second instance start with actionable lock error", async () => {
    const workspaceRoot = await createTempDir();
    const first = await startTeamd({
      teamId: "lock-team",
      workspaceRoot,
      token: "lock-token-a",
      port: 0,
    });
    runningServers.push(first);

    await expect(
      startTeamd({
        teamId: "lock-team",
        workspaceRoot,
        token: "lock-token-b",
        port: 0,
      }),
    ).rejects.toThrow(/already running|lock/i);
  });

  it("recovers from stale lock when lock holder pid is no longer alive", async () => {
    const workspaceRoot = await createTempDir();
    const teamId = "stale-lock-team";
    const teamDir = join(workspaceRoot, teamId);
    await mkdir(teamDir, { recursive: true });

    const lockPath = join(teamDir, ".teamd.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), schemaVersion: "1.0.0" })}\n`,
      "utf8",
    );

    const server = await startTeamd({
      teamId,
      workspaceRoot,
      token: "stale-lock-token",
      port: 0,
    });
    runningServers.push(server);

    const lockContent = await readFile(lockPath, "utf8");
    expect(lockContent).toContain(`"pid":${process.pid}`);
    expect(lockContent).toContain('"schemaVersion":"1.0.0"');
  });

  it("supports createTask idempotency via Idempotency-Key", async () => {
    const server = await startForTest();

    const first = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      headers: {
        "Idempotency-Key": "create-task-1",
      },
      body: {
        teamId: "test-team",
        title: "idempotent-task",
        resources: ["src/io/"],
      },
    });
    const firstPayload = await json<{ task: { id: string } }>(first);

    const second = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      headers: {
        "Idempotency-Key": "create-task-1",
      },
      body: {
        teamId: "test-team",
        title: "idempotent-task",
        resources: ["src/io/"],
      },
    });
    const secondPayload = await json<{ task: { id: string } }>(second);

    const listResponse = await apiRequest(server, "/v1/tasks?teamId=test-team");
    const listPayload = await json<{ tasks: Array<{ id: string }> }>(listResponse);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondPayload.task.id).toBe(firstPayload.task.id);
    expect(listPayload.tasks).toHaveLength(1);
  });

  it("allows only one winner when two agents claim the same task concurrently", async () => {
    const server = await startForTest();

    const createResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "race-claim-task",
        resources: ["src/"],
      },
    });
    const createPayload = await json<{ task: { id: string } }>(createResponse);
    const taskId = createPayload.task.id;

    const claimA = apiRequest(server, `/v1/tasks/${taskId}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        ttlMs: 5_000,
      },
    });
    const claimB = apiRequest(server, `/v1/tasks/${taskId}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-b",
        ttlMs: 5_000,
      },
    });

    const [responseA, responseB] = await Promise.all([claimA, claimB]);
    const statuses = [responseA.status, responseB.status].sort((a, b) => a - b);

    expect(statuses).toEqual([200, 409]);
  });

  it("rejects complete after lease expiry", async () => {
    const server = await startForTest();

    const createResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "lease-expiry-task",
        resources: ["src/"],
      },
    });
    const createPayload = await json<{ task: { id: string } }>(createResponse);
    const taskId = createPayload.task.id;

    const claimResponse = await apiRequest(server, `/v1/tasks/${taskId}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        ttlMs: 25,
      },
    });
    const claimPayload = await json<{ lease: { epoch: number } }>(claimResponse);

    await sleep(50);

    const completeResponse = await apiRequest(server, `/v1/tasks/${taskId}/complete`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        epoch: claimPayload.lease.epoch,
      },
    });

    expect(completeResponse.status).toBe(403);
  });

  it("rejects stale epoch via fencing", async () => {
    const server = await startForTest();

    const createResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "epoch-fencing-task",
        resources: ["src/"],
      },
    });
    const createPayload = await json<{ task: { id: string } }>(createResponse);
    const taskId = createPayload.task.id;

    await apiRequest(server, `/v1/tasks/${taskId}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        ttlMs: 5_000,
      },
    });

    const completeResponse = await apiRequest(server, `/v1/tasks/${taskId}/complete`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        epoch: 0,
      },
    });

    expect(completeResponse.status).toBe(409);
  });

  it("unlocks dependent task from blocked to pending when deps complete", async () => {
    const server = await startForTest();

    const depTaskResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "dep-source",
        resources: ["src/"],
      },
    });
    const depTaskPayload = await json<{ task: { id: string } }>(depTaskResponse);

    const blockedTaskResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "dep-target",
        deps: [depTaskPayload.task.id],
        resources: ["src/"],
      },
    });
    const blockedTaskPayload = await json<{ task: { id: string; status: string } }>(blockedTaskResponse);

    expect(blockedTaskPayload.task.status).toBe("blocked");

    const claimResponse = await apiRequest(server, `/v1/tasks/${depTaskPayload.task.id}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        ttlMs: 5_000,
      },
    });
    const claimPayload = await json<{ lease: { epoch: number } }>(claimResponse);

    const completeResponse = await apiRequest(server, `/v1/tasks/${depTaskPayload.task.id}/complete`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-a",
        epoch: claimPayload.lease.epoch,
      },
    });
    expect(completeResponse.status).toBe(200);

    const fetchedBlockedTask = await apiRequest(
      server,
      `/v1/tasks/${blockedTaskPayload.task.id}?teamId=test-team`,
    );
    const fetchedBlockedPayload = await json<{ task: { status: string } }>(fetchedBlockedTask);

    expect(fetchedBlockedPayload.task.status).toBe("pending");
  });

  it("supports thread messaging and inbox polling for completion events", async () => {
    const server = await startForTest();

    const warmInbox = await apiRequest(server, "/v1/inbox?teamId=test-team&agentId=agent-a");
    expect(warmInbox.status).toBe(200);

    const threadResponse = await apiRequest(server, "/v1/threads", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "handoff",
        participants: ["agent-a", "agent-b"],
      },
    });
    expect(threadResponse.status).toBe(201);
    const threadPayload = await json<{ thread: { id: string } }>(threadResponse);
    const threadId = threadPayload.thread.id;

    const postResponse = await apiRequest(server, `/v1/threads/${threadId}/messages`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-b",
        message: "done with implementation",
      },
    });
    expect(postResponse.status).toBe(201);

    const tailResponse = await apiRequest(server, `/v1/threads/${threadId}/tail?teamId=test-team&limit=5`);
    expect(tailResponse.status).toBe(200);
    const tailPayload = await json<{ messages: Array<{ from: string; body: string }> }>(tailResponse);
    expect(tailPayload.messages).toHaveLength(1);
    expect(tailPayload.messages[0]).toMatchObject({
      from: "agent-b",
      body: "done with implementation",
    });

    const createResponse = await apiRequest(server, "/v1/tasks", {
      method: "POST",
      body: {
        teamId: "test-team",
        title: "notify-agent-a",
        resources: ["src/"],
      },
    });
    const createPayload = await json<{ task: { id: string } }>(createResponse);

    const claimResponse = await apiRequest(server, `/v1/tasks/${createPayload.task.id}/claim`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-b",
        ttlMs: 5_000,
      },
    });
    const claimPayload = await json<{ lease: { epoch: number } }>(claimResponse);

    const completeResponse = await apiRequest(server, `/v1/tasks/${createPayload.task.id}/complete`, {
      method: "POST",
      body: {
        teamId: "test-team",
        agentId: "agent-b",
        epoch: claimPayload.lease.epoch,
      },
    });
    expect(completeResponse.status).toBe(200);

    const inboxResponse = await apiRequest(server, "/v1/inbox?teamId=test-team&agentId=agent-a");
    expect(inboxResponse.status).toBe(200);
    const inboxPayload = await json<{ events: Array<{ type: string; taskId?: string }> }>(inboxResponse);
    expect(inboxPayload.events.some((event) => event.type === "task_completed")).toBe(true);
    expect(inboxPayload.events.some((event) => event.taskId === createPayload.task.id)).toBe(true);
  });
});
