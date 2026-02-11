import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateFilePermissions,
  ensureTeamDirPermissions,
  safeJoin,
  writeJsonAtomic,
} from "../io/index.js";
import { startTeamdHttpServer } from "./server.js";
import { TeamdStore } from "./store.js";

const SCHEMA_VERSION = "1.0.0";
const VERSION = "1.0.0";

export interface StartTeamdOptions {
  teamId: string;
  workspaceRoot?: string;
  token?: string;
  port?: number;
  defaultLeaseTtlMs?: number;
}

export interface TeamdHandle {
  url: string;
  token: string;
  teamId: string;
  pid: number;
  runtimeFile: string;
  close(): Promise<void>;
}

interface TeamdLockHandle {
  release(): Promise<void>;
}

function defaultWorkspaceRoot(): string {
  return join(homedir(), ".pi", "teams");
}

function createToken(): string {
  return randomBytes(32).toString("hex");
}

function assertTeamId(teamId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(teamId)) {
    throw new Error("teamId must match [a-zA-Z0-9._-]+.");
  }

  return teamId;
}

async function acquireLock(lockPath: string): Promise<TeamdLockHandle> {
  let lockHandle: FileHandle | null = null;

  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION })}\n`,
      "utf8",
    );
    await lockHandle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    let lockInfo = "unknown";
    try {
      lockInfo = (await fs.readFile(lockPath, "utf8")).trim() || "unknown";
    } catch {
      lockInfo = "unknown";
    }

    throw new Error(
      `teamd is already running for this team (lock file exists: ${lockPath}, holder: ${lockInfo}).`,
    );
  }

  return {
    release: async () => {
      if (lockHandle) {
        await lockHandle.close();
      }
      await fs.rm(lockPath, { force: true });
    },
  };
}

export async function startTeamd(options: StartTeamdOptions): Promise<TeamdHandle> {
  const teamId = assertTeamId(options.teamId);
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot();
  const token = options.token ?? createToken();

  await fs.mkdir(workspaceRoot, { recursive: true });
  const teamDir = await safeJoin(workspaceRoot, teamId);
  await ensureTeamDirPermissions(teamDir);

  const lockPath = await safeJoin(teamDir, ".teamd.lock");
  const lock = await acquireLock(lockPath);

  const store = await TeamdStore.create({
    workspaceRoot,
    teamId,
    defaultLeaseTtlMs: options.defaultLeaseTtlMs,
  });

  let server = null as Awaited<ReturnType<typeof startTeamdHttpServer>> | null;
  try {
    server = await startTeamdHttpServer({
      store,
      teamId,
      token,
      host: "127.0.0.1",
      port: options.port ?? 0,
      version: VERSION,
    });

    const runtimeFile = await safeJoin(await store.getTeamDir(), "runtime.json");
    await writeJsonAtomic(runtimeFile, {
      url: server.url,
      token,
      pid: process.pid,
      schemaVersion: SCHEMA_VERSION,
    });
    await ensurePrivateFilePermissions(runtimeFile);

    let isClosed = false;
    return {
      url: server.url,
      token,
      teamId,
      pid: process.pid,
      runtimeFile,
      close: async () => {
        if (isClosed) {
          return;
        }
        isClosed = true;
        await server?.close();
        await lock.release();
      },
    };
  } catch (error) {
    if (server) {
      await server.close();
    }
    await lock.release();
    throw error;
  }
}
