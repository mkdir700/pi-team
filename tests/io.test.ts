import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  appendJsonl,
  ensurePrivateFilePermissions,
  ensureTeamDirPermissions,
  readJsonlSafe,
  safeJoin,
  writeJsonAtomic,
} from "../src/io/index.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-team-io-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("io library", () => {
  it("writes JSON atomically and keeps target valid despite stray partial temp file", async () => {
    const root = await createTempDir();
    const filePath = join(root, "runtime.json");
    await writeFile(filePath, JSON.stringify({ schemaVersion: "1.0.0", ok: true }) + "\n", "utf8");
    await writeFile(join(root, "runtime.json.partial.tmp"), "{\"broken\":", "utf8");

    await writeJsonAtomic(filePath, { schemaVersion: "1.0.0", ok: false });

    const raw = await readFile(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ schemaVersion: "1.0.0", ok: false });
  });

  it("appends JSONL as single-line records with trailing newline", async () => {
    const root = await createTempDir();
    const filePath = join(root, "audit", "events.jsonl");

    await appendJsonl(filePath, { id: 1, type: "created" });
    await appendJsonl(filePath, { id: 2, type: "updated" });

    const raw = await readFile(filePath, "utf8");
    expect(raw).toBe('{"id":1,"type":"created"}\n{"id":2,"type":"updated"}\n');
    const parsed = await readJsonlSafe(filePath);
    expect(parsed).toEqual([
      { id: 1, type: "created" },
      { id: 2, type: "updated" },
    ]);
  });

  it("ignores trailing truncated JSONL line", async () => {
    const root = await createTempDir();
    const filePath = join(root, "threads", "t-001.jsonl");
    await mkdir(join(root, "threads"), { recursive: true });
    await writeFile(filePath, '{"id":1}\n{"id":2}\n{"id":3', "utf8");

    const parsed = await readJsonlSafe(filePath);

    expect(parsed).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("rejects path traversal outside team root", async () => {
    const root = await createTempDir();

    await expect(safeJoin(root, `..${sep}outside.json`)).rejects.toMatchObject({ code: "PATH_TRAVERSAL" });
  });

  it("rejects symlink escape outside team root", async () => {
    const root = await createTempDir();
    const outside = await createTempDir();
    await symlink(outside, join(root, "evil"));

    await expect(safeJoin(root, "evil/secret.txt")).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
  });

  it("applies expected permissions for team dir and private files", async () => {
    const root = await createTempDir();
    const teamDir = join(root, "team");
    const runtimeFile = join(teamDir, "runtime.json");

    await ensureTeamDirPermissions(teamDir);
    await writeFile(runtimeFile, "{}\n", "utf8");
    await ensurePrivateFilePermissions(runtimeFile);

    const teamMode = (await stat(teamDir)).mode & 0o777;
    const runtimeMode = (await stat(runtimeFile)).mode & 0o777;

    expect(teamMode).toBe(0o700);
    expect(runtimeMode).toBe(0o600);
  });
});
