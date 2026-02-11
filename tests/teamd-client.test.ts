import { describe, expect, it, vi } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createTeamdClient } from "../src/extension/teamd-client.js";

async function writeRuntimeFile(path: string, payload: { url: string; token: string }): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: "1.0.0",
      url: payload.url,
      token: payload.token,
      pid: 123,
    })}\n`,
    "utf8",
  );
}

describe("teamd client discovery", () => {
  it("auto-discovers latest runtime and generates agent id", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-team-runtime-"));
    const teamsRoot = join(root, ".pi", "teams");
    const alphaDir = join(teamsRoot, "alpha");
    const betaDir = join(teamsRoot, "beta");
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });

    const alphaRuntime = join(alphaDir, "runtime.json");
    const betaRuntime = join(betaDir, "runtime.json");
    await writeRuntimeFile(alphaRuntime, { url: "http://127.0.0.1:4401", token: "token-alpha" });
    await writeRuntimeFile(betaRuntime, { url: "http://127.0.0.1:4402", token: "token-beta" });

    const now = new Date();
    const old = new Date(now.getTime() - 60_000);
    await utimes(alphaRuntime, old, old);
    await utimes(betaRuntime, now, now);

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ allow: true, reason: "lease_active_for_resource" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createTeamdClient({
      env: {
        PI_TEAM_WORKSPACE_ROOT: teamsRoot,
        USER: "tester",
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const result = await client.canWrite("src/index.ts");
    expect(result.allow).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(requestUrl)).toContain("http://127.0.0.1:4402/v1/can-write");
    expect(String(requestUrl)).toContain("teamId=beta");
    expect(String(requestUrl)).toContain("agentId=tester-auto");
    expect((requestInit.headers as Record<string, string>).authorization).toBe("Bearer token-beta");
  });

  it("uses team-specific runtime when team id is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-team-runtime-"));
    const teamsRoot = join(root, ".pi", "teams");
    const alphaDir = join(teamsRoot, "alpha");
    const betaDir = join(teamsRoot, "beta");
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });

    await writeRuntimeFile(join(alphaDir, "runtime.json"), { url: "http://127.0.0.1:5501", token: "token-alpha" });
    await writeRuntimeFile(join(betaDir, "runtime.json"), { url: "http://127.0.0.1:5502", token: "token-beta" });

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createTeamdClient({
      env: {
        PI_TEAM_ID: "alpha",
        PI_TEAM_WORKSPACE_ROOT: teamsRoot,
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    await client.listTasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(requestUrl)).toContain("http://127.0.0.1:5501/v1/tasks");
    expect(String(requestUrl)).toContain("teamId=alpha");
    expect((requestInit.headers as Record<string, string>).authorization).toBe("Bearer token-alpha");
  });
});
