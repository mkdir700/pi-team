#!/usr/bin/env node

import { startTeamd } from "../teamd/index.js";

interface ParsedArgs {
  teamId: string;
  workspaceRoot?: string;
  token?: string;
  port?: number;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    teamId: "default",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--team") {
      parsed.teamId = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--workspace-root") {
      parsed.workspaceRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--token") {
      parsed.token = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value)) {
        throw new Error("--port requires an integer value.");
      }
      parsed.port = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write("Usage: teamd [--team <teamId>] [--workspace-root <path>] [--port <n>] [--json]\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const handle = await startTeamd({
    teamId: args.teamId,
    workspaceRoot: args.workspaceRoot,
    token: args.token,
    port: args.port,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        url: handle.url,
        token: handle.token,
        pid: handle.pid,
        teamId: handle.teamId,
        schemaVersion: "1.0.0",
      })}\n`,
    );
  } else {
    process.stdout.write(`teamd started at ${handle.url} (team: ${handle.teamId})\n`);
  }

  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
