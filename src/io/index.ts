import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export type IoErrorCode = "PATH_TRAVERSAL" | "SYMLINK_ESCAPE" | "INVALID_JSONL_LINE";

export class IoError extends Error {
  readonly code: IoErrorCode;

  constructor(code: IoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IoError";
    this.code = code;
  }
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);
}

function assertNoTraversal(relative: string): void {
  if (isAbsolute(relative)) {
    throw new IoError("PATH_TRAVERSAL", `Absolute paths are not allowed: ${relative}`);
  }

  const normalized = normalize(relative);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    throw new IoError("PATH_TRAVERSAL", `Path traversal is not allowed: ${relative}`);
  }
}

async function fsyncDirBestEffort(dirPath: string): Promise<void> {
  try {
    const dirHandle = await fs.open(dirPath, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    return;
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dirPath = dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });

  const tempPath = join(
    dirPath,
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const payload = `${JSON.stringify(data)}\n`;

  try {
    const handle = await fs.open(tempPath, "w", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, filePath);
    await fsyncDirBestEffort(dirPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });

  const handle = await fs.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(obj)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonlSafe(filePath: string): Promise<unknown[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (!hasTrailingNewline) {
    lines.pop();
  }

  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }

    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      throw new IoError("INVALID_JSONL_LINE", `Invalid JSONL line in ${filePath}`, { cause: error });
    }
  }

  return parsed;
}

export async function safeJoin(teamRoot: string, relative: string): Promise<string> {
  assertNoTraversal(relative);

  const rootRealPath = await fs.realpath(teamRoot);
  const normalized = normalize(relative);
  const joined = resolve(rootRealPath, normalized);

  if (!isWithinRoot(rootRealPath, joined)) {
    throw new IoError("PATH_TRAVERSAL", `Path traversal is not allowed: ${relative}`);
  }

  const parts = normalized.split(sep).filter(Boolean);
  let current = rootRealPath;

  for (const part of parts) {
    const next = join(current, part);

    try {
      const st = await fs.lstat(next);
      if (st.isSymbolicLink()) {
        const linkTarget = await fs.realpath(next);
        if (!isWithinRoot(rootRealPath, linkTarget)) {
          throw new IoError("SYMLINK_ESCAPE", `Symlink escapes team root: ${relative}`);
        }
        current = linkTarget;
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }

    current = next;
  }

  return joined;
}

export async function ensureTeamDirPermissions(teamDir: string): Promise<void> {
  await fs.mkdir(teamDir, { recursive: true });
  await fs.chmod(teamDir, 0o700);
}

export async function ensurePrivateFilePermissions(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600);
}
