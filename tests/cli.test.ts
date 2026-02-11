import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatHelp } from "../src/cli/help.js";

describe("pi-team CLI", () => {
  it("help output contains top-level command groups", () => {
    const output = formatHelp();
    expect(output).toContain("daemon");
    expect(output).toContain("team");
    expect(output).toContain("tasks");
    expect(output).toContain("threads");
    expect(output).toContain("agent env");
  });

  it("agent env prints required environment exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-team-cli-"));
    const teamId = "alpha";
    const runtimeDir = join(root, teamId);
    const runtimePath = join(runtimeDir, "runtime.json");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      runtimePath,
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        url: "http://127.0.0.1:4400",
        token: "secret",
        pid: 123,
      })}\n`,
      "utf8",
    );

    const { runCli } = await import("../src/cli/run.js");
    const result = await runCli([
      "agent",
      "env",
      "--team",
      teamId,
      "--agent",
      "worker-a",
      "--workspace-root",
      root,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export PI_TEAM_ID=alpha");
    expect(result.stdout).toContain("export PI_AGENT_ID=worker-a");
    expect(result.stdout).toContain("export PI_TEAMD_URL=http://127.0.0.1:4400");
    expect(result.stdout).toContain(`export PI_TEAMD_TOKEN_FILE=${runtimePath}`);
  });

  it("daemon status reports runtime missing error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-team-cli-"));
    const { runCli } = await import("../src/cli/run.js");
    const result = await runCli(["daemon", "status", "--team", "missing", "--workspace-root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime.json");
    expect(result.stderr).toContain("not found");
  });
});
