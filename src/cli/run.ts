import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatHelp } from "./help.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RuntimeInfo {
  schemaVersion: string;
  url: string;
  token: string;
  pid: number;
}

function defaultWorkspaceRoot(): string {
  return join(homedir(), ".pi", "teams");
}

function readOption(args: string[], optionName: string): string | undefined {
  const index = args.indexOf(optionName);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], optionName: string): boolean {
  return args.includes(optionName);
}

async function readRuntimeFile(runtimePath: string): Promise<RuntimeInfo | null> {
  try {
    const raw = await readFile(runtimePath, "utf8");
    return JSON.parse(raw) as RuntimeInfo;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function ok(stdout: string): CliResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function fail(stderr: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
  };
}

export async function runCli(args: string[]): Promise<CliResult> {
  if (args.length === 0 || hasFlag(args, "-h") || hasFlag(args, "--help")) {
    return ok(`${formatHelp()}\n`);
  }

  if (args[0] === "agent" && args[1] === "env") {
    const teamId = readOption(args, "--team");
    const agentId = readOption(args, "--agent");
    const workspaceRoot = readOption(args, "--workspace-root") ?? defaultWorkspaceRoot();
    if (!teamId || !agentId) {
      return fail("agent env requires --team and --agent\n");
    }

    const runtimePath = join(workspaceRoot, teamId, "runtime.json");
    const runtime = await readRuntimeFile(runtimePath);
    if (!runtime) {
      return fail(`runtime.json not found at ${runtimePath}\n`);
    }

    return ok(
      [
        `export PI_TEAM_ID=${teamId}`,
        `export PI_AGENT_ID=${agentId}`,
        `export PI_TEAMD_URL=${runtime.url}`,
        `export PI_TEAMD_TOKEN_FILE=${runtimePath}`,
        "",
      ].join("\n"),
    );
  }

  if (args[0] === "daemon" && args[1] === "status") {
    const teamId = readOption(args, "--team");
    const workspaceRoot = readOption(args, "--workspace-root") ?? defaultWorkspaceRoot();
    const asJson = hasFlag(args, "--json");

    if (!teamId) {
      return fail("daemon status requires --team\n");
    }

    const runtimePath = join(workspaceRoot, teamId, "runtime.json");
    const runtime = await readRuntimeFile(runtimePath);
    if (!runtime) {
      return fail(`runtime.json not found at ${runtimePath}\n`);
    }

    if (asJson) {
      return ok(`${JSON.stringify({ teamId, runtimePath, runtime })}\n`);
    }

    return ok(`team ${teamId} runtime: ${runtime.url} pid=${runtime.pid}\n`);
  }

  return fail(`Unknown command: ${args.join(" ")}\nRun \`pi-team --help\` for usage.\n`);
}
