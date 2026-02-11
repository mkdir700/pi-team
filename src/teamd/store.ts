import { promises as fs } from "node:fs";
import { normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { appendJsonl, ensureTeamDirPermissions, readJsonlSafe, safeJoin, writeJsonAtomic } from "../io/index.js";

const SCHEMA_VERSION = "1.0.0";

export type TaskStatus = "pending" | "blocked" | "in_progress" | "completed" | "failed" | "canceled";

export interface TaskLease {
  holder: string;
  epoch: number;
  expiresAt: string;
}

export interface TaskRecord {
  schemaVersion: string;
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  deps: string[];
  resources: string[];
  lease: TaskLease | null;
  epoch: number;
  timestamps: {
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
  };
}

export interface TeamRecord {
  schemaVersion: string;
  teamId: string;
  agents: Array<{ id: string; role: string; model?: string }>;
  budget?: {
    maxTokens?: number;
    hardLimit?: boolean;
  };
}

export interface ThreadRecord {
  schemaVersion: string;
  id: string;
  title: string;
  participants: string[];
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessageRecord {
  schemaVersion: string;
  id: string;
  threadId: string;
  from: string;
  body: string;
  ts: string;
}

export interface InboxEventRecord {
  schemaVersion: string;
  id: string;
  cursor: number;
  type: string;
  teamId: string;
  agentId: string;
  taskId?: string;
  threadId?: string;
  actor?: string;
  summary?: string;
  content?: string;
  ts: string;
}

interface ThreadIndexState {
  schemaVersion: string;
  threads: ThreadRecord[];
}

interface InboxState {
  schemaVersion: string;
  nextCursor: number;
  events: InboxEventRecord[];
}

interface CreateTaskIdempotencyState {
  schemaVersion: string;
  entries: Record<string, { taskId: string; createdAt: string }>;
}

export interface TeamdStoreOptions {
  workspaceRoot: string;
  teamId: string;
  defaultLeaseTtlMs?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  deps?: string[];
  resources?: string[];
}

export interface StartThreadInput {
  title?: string;
  participants?: string[];
  taskId?: string;
  agentId?: string;
}

export interface PostThreadMessageInput {
  threadId: string;
  agentId: string;
  message: string;
}

export interface LinkThreadToTaskInput {
  threadId: string;
  taskId: string;
}

export interface ClaimTaskInput {
  taskId: string;
  agentId: string;
  ttlMs?: number;
}

export interface RenewTaskInput {
  taskId: string;
  agentId: string;
  epoch: number;
  ttlMs?: number;
}

export interface FinalizeTaskInput {
  taskId: string;
  agentId: string;
  epoch: number;
}

export interface TeamdStoreErrorShape {
  statusCode: number;
  code: string;
}

export class TeamdStoreError extends Error implements TeamdStoreErrorShape {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "TeamdStoreError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePathPrefix(pathValue: string): string {
  const normalized = normalize(pathValue).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.replace(/\/+$/, "");
}

function resourceMatchesPath(resource: string, target: string): boolean {
  if (resource === "") {
    return true;
  }

  return target === resource || target.startsWith(`${resource}/`);
}

function parseTaskNumericId(taskId: string): number {
  const match = /^task-(\d+)$/.exec(taskId);
  if (!match) {
    return 0;
  }

  return Number.parseInt(match[1] ?? "0", 10);
}

function buildTaskId(taskNumber: number): string {
  return `task-${String(taskNumber).padStart(4, "0")}`;
}

function parseThreadNumericId(threadId: string): number {
  const match = /^thread-(\d+)$/u.exec(threadId);
  if (!match) {
    return 0;
  }

  return Number.parseInt(match[1] ?? "0", 10);
}

function buildThreadId(threadNumber: number): string {
  return `thread-${String(threadNumber).padStart(4, "0")}`;
}

function ensureTeamId(teamId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(teamId)) {
    throw new TeamdStoreError(400, "INVALID_TEAM_ID", "teamId must match [a-zA-Z0-9._-]+.");
  }

  return teamId;
}

function ensureAgentId(agentId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(agentId)) {
    throw new TeamdStoreError(400, "INVALID_AGENT_ID", "agentId must match [a-zA-Z0-9._-]+.");
  }

  return agentId;
}

function buildDefaultTeam(teamId: string): TeamRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    teamId,
    agents: [],
  };
}

function isLeaseExpired(lease: TaskLease): boolean {
  return Date.now() >= Date.parse(lease.expiresAt);
}

export class TeamdStore {
  private readonly workspaceRoot: string;
  private readonly teamId: string;
  private readonly defaultLeaseTtlMs: number;
  private teamDirPath: string | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: TeamdStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.teamId = ensureTeamId(options.teamId);
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 5 * 60 * 1000;
  }

  static async create(options: TeamdStoreOptions): Promise<TeamdStore> {
    const store = new TeamdStore(options);
    await store.initialize();
    return store;
  }

  async getTeamDir(): Promise<string> {
    return this.resolveTeamDir();
  }

  async createTeam(team: TeamRecord): Promise<TeamRecord> {
    this.assertTeamId(team.teamId);

    return this.enqueueMutation(async () => {
      const existing = await this.readTeam();
      if (existing) {
        return existing;
      }

      const payload: TeamRecord = {
        ...team,
        schemaVersion: SCHEMA_VERSION,
      };
      await this.writeTeam(payload);
      await this.appendAuditEvent({
        actor: "teamd",
        type: "team_created",
        refs: { teamId: this.teamId },
        data: { teamId: this.teamId },
      });
      return payload;
    });
  }

  async listTeams(): Promise<TeamRecord[]> {
    const team = await this.readTeam();
    if (!team) {
      return [];
    }
    return [team];
  }

  async getTeam(teamId: string): Promise<TeamRecord> {
    this.assertTeamId(teamId);
    const team = await this.readTeam();
    if (!team) {
      throw new TeamdStoreError(404, "TEAM_NOT_FOUND", `Team ${teamId} not found.`);
    }
    return team;
  }

  async createTask(
    teamId: string,
    input: CreateTaskInput,
    idempotencyKey?: string,
  ): Promise<{ task: TaskRecord; created: boolean }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const title = input.title?.trim();
      if (!title) {
        throw new TeamdStoreError(400, "INVALID_TASK", "title is required.");
      }

      const deps = [...new Set((input.deps ?? []).map((dep) => dep.trim()).filter(Boolean))];
      const resources = [...new Set((input.resources ?? []).map((resource) => normalizePathPrefix(resource)).filter(Boolean))];
      const idempotency = await this.readCreateTaskIdempotency();

      if (idempotencyKey && idempotency.entries[idempotencyKey]) {
        const existingTaskId = idempotency.entries[idempotencyKey].taskId;
        const existingTask = await this.readTask(existingTaskId);
        if (existingTask) {
          return {
            task: existingTask,
            created: false,
          };
        }
      }

      const existingTasks = await this.listTasksUnsafe();
      const nextTaskNumber = existingTasks.reduce((maxValue, task) => Math.max(maxValue, parseTaskNumericId(task.id)), 0) + 1;
      const taskId = buildTaskId(nextTaskNumber);
      const createdAt = nowIso();
      const areDepsComplete = deps.every((depId) => {
        const dep = existingTasks.find((task) => task.id === depId);
        return dep?.status === "completed";
      });

      const task: TaskRecord = {
        schemaVersion: SCHEMA_VERSION,
        id: taskId,
        title,
        description: input.description?.trim() ?? "",
        status: deps.length > 0 && !areDepsComplete ? "blocked" : "pending",
        owner: null,
        deps,
        resources,
        lease: null,
        epoch: 0,
        timestamps: {
          createdAt,
          startedAt: null,
          completedAt: null,
          failedAt: null,
        },
      };

      await this.writeTask(task);
      if (idempotencyKey) {
        idempotency.entries[idempotencyKey] = {
          taskId,
          createdAt,
        };
        await this.writeCreateTaskIdempotency(idempotency);
      }

      await this.appendAuditEvent({
        actor: "teamd",
        type: "task_created",
        refs: { taskId },
        data: { task },
      });

      return {
        task,
        created: true,
      };
    });
  }

  async listTasks(teamId: string): Promise<TaskRecord[]> {
    this.assertTeamId(teamId);
    const tasks = await this.listTasksUnsafe();
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getTask(teamId: string, taskId: string): Promise<TaskRecord> {
    this.assertTeamId(teamId);
    const task = await this.readTask(taskId);
    if (!task) {
      throw new TeamdStoreError(404, "TASK_NOT_FOUND", `Task ${taskId} not found.`);
    }
    return task;
  }

  async claimTask(teamId: string, input: ClaimTaskInput): Promise<{ task: TaskRecord; lease: TaskLease }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const task = await this.loadTaskOrThrow(input.taskId);
      const now = Date.now();

      if (task.status === "in_progress" && task.lease && isLeaseExpired(task.lease)) {
        task.status = "pending";
        task.owner = null;
        task.lease = null;
      }

      if (task.status !== "pending") {
        throw new TeamdStoreError(409, "TASK_NOT_CLAIMABLE", `Task ${task.id} is ${task.status}.`);
      }

      const ttlMs = input.ttlMs ?? this.defaultLeaseTtlMs;
      const nextEpoch = task.epoch + 1;
      const lease: TaskLease = {
        holder: input.agentId,
        epoch: nextEpoch,
        expiresAt: new Date(now + ttlMs).toISOString(),
      };

      task.status = "in_progress";
      task.owner = input.agentId;
      task.lease = lease;
      task.epoch = nextEpoch;
      task.timestamps.startedAt ??= nowIso();

      await this.writeTask(task);
      await this.appendAuditEvent({
        actor: input.agentId,
        type: "task_claimed",
        refs: { taskId: task.id },
        data: { lease },
      });
      await this.appendInboxEvent(await this.broadcastRecipients(), {
        type: "task_claimed",
        taskId: task.id,
        actor: input.agentId,
        summary: `Task ${task.id} claimed by ${input.agentId}`,
      });

      return { task, lease };
    });
  }

  async renewTask(teamId: string, input: RenewTaskInput): Promise<{ task: TaskRecord; lease: TaskLease }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const task = await this.loadTaskOrThrow(input.taskId);
      if (task.status !== "in_progress" || !task.lease) {
        throw new TeamdStoreError(409, "TASK_NOT_IN_PROGRESS", `Task ${task.id} is not in progress.`);
      }

      if (isLeaseExpired(task.lease)) {
        throw new TeamdStoreError(403, "LEASE_EXPIRED", `Lease for task ${task.id} has expired.`);
      }

      if (task.lease.holder !== input.agentId) {
        throw new TeamdStoreError(403, "LEASE_HOLDER_MISMATCH", `Task ${task.id} is held by another agent.`);
      }

      if (task.lease.epoch !== input.epoch) {
        throw new TeamdStoreError(409, "EPOCH_MISMATCH", `Epoch mismatch for task ${task.id}.`);
      }

      const ttlMs = input.ttlMs ?? this.defaultLeaseTtlMs;
      task.lease = {
        ...task.lease,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };

      await this.writeTask(task);
      await this.appendAuditEvent({
        actor: input.agentId,
        type: "task_renewed",
        refs: { taskId: task.id },
        data: { lease: task.lease },
      });

      return { task, lease: task.lease };
    });
  }

  async completeTask(teamId: string, input: FinalizeTaskInput): Promise<{ task: TaskRecord }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const task = await this.finalizeTask(input, "completed");
      await this.unlockDependents(task.id, input.agentId);
      return { task };
    });
  }

  async failTask(teamId: string, input: FinalizeTaskInput): Promise<{ task: TaskRecord }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const task = await this.finalizeTask(input, "failed");
      return { task };
    });
  }

  async startThread(teamId: string, input: StartThreadInput): Promise<{ thread: ThreadRecord }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const title = input.title?.trim() || "Thread";
      const participants = [...new Set((input.participants ?? []).map((id) => id.trim()).filter(Boolean))];
      if (input.agentId?.trim()) {
        participants.push(input.agentId.trim());
      }

      const uniqueParticipants = [...new Set(participants)].map((agentId) => ensureAgentId(agentId));
      const index = await this.readThreadIndex();
      const nextThreadNumber = index.threads.reduce((maxValue, thread) => {
        return Math.max(maxValue, parseThreadNumericId(thread.id));
      }, 0) + 1;
      const threadId = buildThreadId(nextThreadNumber);
      const createdAt = nowIso();

      if (input.taskId?.trim()) {
        await this.loadTaskOrThrow(input.taskId.trim());
      }

      const thread: ThreadRecord = {
        schemaVersion: SCHEMA_VERSION,
        id: threadId,
        title,
        participants: uniqueParticipants,
        taskId: input.taskId?.trim() || null,
        createdAt,
        updatedAt: createdAt,
      };

      index.threads.push(thread);
      await this.writeThreadIndex(index);
      await this.appendAuditEvent({
        actor: input.agentId?.trim() || "teamd",
        type: "thread_started",
        refs: { threadId },
        data: { thread },
      });

      return { thread };
    });
  }

  async postThreadMessage(teamId: string, input: PostThreadMessageInput): Promise<{ message: ThreadMessageRecord }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      const author = ensureAgentId(input.agentId.trim());
      const body = input.message.trim();
      if (!body) {
        throw new TeamdStoreError(400, "INVALID_THREAD_MESSAGE", "message is required.");
      }

      const index = await this.readThreadIndex();
      const thread = index.threads.find((item) => item.id === input.threadId);
      if (!thread) {
        throw new TeamdStoreError(404, "THREAD_NOT_FOUND", `Thread ${input.threadId} not found.`);
      }

      const message: ThreadMessageRecord = {
        schemaVersion: SCHEMA_VERSION,
        id: `msg-${randomUUID()}`,
        threadId: thread.id,
        from: author,
        body,
        ts: nowIso(),
      };

      await appendJsonl(await this.threadFilePath(thread.id), message);
      thread.updatedAt = message.ts;
      await this.writeThreadIndex(index);

      await this.appendAuditEvent({
        actor: author,
        type: "thread_message",
        refs: { threadId: thread.id },
        data: { messageId: message.id },
      });

      const recipients = thread.participants.filter((participant) => participant !== author);
      await this.appendInboxEvent(recipients, {
        type: "thread_message",
        threadId: thread.id,
        actor: author,
        summary: body.slice(0, 120),
        content: body,
      });

      return { message };
    });
  }

  async readThreadTail(teamId: string, threadId: string, limit = 20): Promise<{ thread: ThreadRecord; messages: ThreadMessageRecord[] }> {
    this.assertTeamId(teamId);

    const index = await this.readThreadIndex();
    const thread = index.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new TeamdStoreError(404, "THREAD_NOT_FOUND", `Thread ${threadId} not found.`);
    }

    const records = (await readJsonlSafe(await this.threadFilePath(thread.id))).filter(
      (value): value is ThreadMessageRecord => Boolean(value && typeof value === "object"),
    );
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 20;
    const messages = records.slice(-normalizedLimit);

    return { thread, messages };
  }

  async searchThreads(teamId: string, query: string): Promise<{ threads: ThreadRecord[] }> {
    this.assertTeamId(teamId);

    const needle = query.trim().toLowerCase();
    const index = await this.readThreadIndex();
    if (!needle) {
      return { threads: index.threads };
    }

    return {
      threads: index.threads.filter((thread) => {
        if (thread.title.toLowerCase().includes(needle)) {
          return true;
        }
        if (thread.taskId?.toLowerCase().includes(needle)) {
          return true;
        }
        return thread.participants.some((participant) => participant.toLowerCase().includes(needle));
      }),
    };
  }

  async linkThreadToTask(teamId: string, input: LinkThreadToTaskInput): Promise<{ thread: ThreadRecord }> {
    this.assertTeamId(teamId);

    return this.enqueueMutation(async () => {
      await this.loadTaskOrThrow(input.taskId);

      const index = await this.readThreadIndex();
      const thread = index.threads.find((item) => item.id === input.threadId);
      if (!thread) {
        throw new TeamdStoreError(404, "THREAD_NOT_FOUND", `Thread ${input.threadId} not found.`);
      }

      thread.taskId = input.taskId;
      thread.updatedAt = nowIso();
      await this.writeThreadIndex(index);
      await this.appendAuditEvent({
        actor: "teamd",
        type: "thread_linked_task",
        refs: { threadId: thread.id, taskId: input.taskId },
      });

      return { thread };
    });
  }

  async fetchInbox(teamId: string, agentId: string, since?: string): Promise<{ events: InboxEventRecord[]; nextSince: string }> {
    this.assertTeamId(teamId);
    const normalizedAgentId = ensureAgentId(agentId.trim());
    const state = await this.readInbox(normalizedAgentId, true);
    const sinceCursor = Number.parseInt(since ?? "0", 10);
    const cursorFloor = Number.isFinite(sinceCursor) && sinceCursor > 0 ? sinceCursor : 0;
    const events = state.events.filter((event) => event.cursor > cursorFloor);
    const nextSince = String(events.length > 0 ? events[events.length - 1]!.cursor : Math.max(cursorFloor, state.nextCursor));

    return {
      events,
      nextSince,
    };
  }

  async canWrite(teamId: string, agentId: string, requestedPath: string): Promise<{ allow: boolean; reason: string }> {
    this.assertTeamId(teamId);

    const safePath = normalizePathPrefix(requestedPath);
    if (!safePath) {
      return { allow: false, reason: "invalid_path" };
    }

    const teamDir = await this.resolveTeamDir();
    try {
      await safeJoin(teamDir, safePath);
    } catch {
      return { allow: false, reason: "path_traversal_denied" };
    }

    const tasks = await this.listTasksUnsafe();
    const now = Date.now();
    for (const task of tasks) {
      if (task.status !== "in_progress" || !task.lease) {
        continue;
      }

      if (task.lease.holder !== agentId) {
        continue;
      }

      if (Date.parse(task.lease.expiresAt) <= now) {
        continue;
      }

      for (const resource of task.resources) {
        if (resourceMatchesPath(resource, safePath)) {
          return {
            allow: true,
            reason: "lease_active_for_resource",
          };
        }
      }
    }

    return {
      allow: false,
      reason: "no_active_lease_for_path",
    };
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
    const teamDir = await this.resolveTeamDir();
    await ensureTeamDirPermissions(teamDir);
    await Promise.all([
      fs.mkdir(await safeJoin(teamDir, "tasks"), { recursive: true }),
      fs.mkdir(await safeJoin(teamDir, "threads"), { recursive: true }),
      fs.mkdir(await safeJoin(teamDir, "inboxes"), { recursive: true }),
      fs.mkdir(await safeJoin(teamDir, "audit"), { recursive: true }),
      fs.mkdir(await safeJoin(teamDir, "artifacts"), { recursive: true }),
      fs.mkdir(await safeJoin(teamDir, "idempotency"), { recursive: true }),
    ]);

    const existingTeam = await this.readTeam();
    if (!existingTeam) {
      await this.writeTeam(buildDefaultTeam(this.teamId));
    }
  }

  private assertTeamId(teamId: string): void {
    if (teamId !== this.teamId) {
      throw new TeamdStoreError(404, "TEAM_NOT_FOUND", `Team ${teamId} not managed by this daemon.`);
    }
  }

  private async resolveTeamDir(): Promise<string> {
    if (this.teamDirPath) {
      return this.teamDirPath;
    }

    const resolved = await safeJoin(this.workspaceRoot, this.teamId);
    this.teamDirPath = resolved;
    return resolved;
  }

  private async teamFilePath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "team.json");
  }

  private async tasksDirPath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "tasks");
  }

  private async taskFilePath(taskId: string): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), `tasks/${taskId}.json`);
  }

  private async threadIndexPath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "threads/index.json");
  }

  private async threadFilePath(threadId: string): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), `threads/${threadId}.jsonl`);
  }

  private async inboxesDirPath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "inboxes");
  }

  private async inboxFilePath(agentId: string): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), `inboxes/${agentId}.json`);
  }

  private async auditFilePath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "audit/events.jsonl");
  }

  private async createTaskIdempotencyPath(): Promise<string> {
    return safeJoin(await this.resolveTeamDir(), "idempotency/create-task.json");
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readTeam(): Promise<TeamRecord | null> {
    return this.readJsonFile<TeamRecord>(await this.teamFilePath());
  }

  private async writeTeam(team: TeamRecord): Promise<void> {
    await writeJsonAtomic(await this.teamFilePath(), team);
  }

  private async readTask(taskId: string): Promise<TaskRecord | null> {
    return this.readJsonFile<TaskRecord>(await this.taskFilePath(taskId));
  }

  private async loadTaskOrThrow(taskId: string): Promise<TaskRecord> {
    const task = await this.readTask(taskId);
    if (!task) {
      throw new TeamdStoreError(404, "TASK_NOT_FOUND", `Task ${taskId} not found.`);
    }
    return task;
  }

  private async writeTask(task: TaskRecord): Promise<void> {
    await writeJsonAtomic(await this.taskFilePath(task.id), task);
  }

  private async readThreadIndex(): Promise<ThreadIndexState> {
    const state = await this.readJsonFile<ThreadIndexState>(await this.threadIndexPath());
    if (state) {
      return {
        schemaVersion: SCHEMA_VERSION,
        threads: Array.isArray(state.threads) ? state.threads : [],
      };
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      threads: [],
    };
  }

  private async writeThreadIndex(state: ThreadIndexState): Promise<void> {
    await writeJsonAtomic(await this.threadIndexPath(), {
      schemaVersion: SCHEMA_VERSION,
      threads: state.threads,
    } satisfies ThreadIndexState);
  }

  private async readInbox(agentId: string, createIfMissing: boolean): Promise<InboxState> {
    const filePath = await this.inboxFilePath(agentId);
    const state = await this.readJsonFile<InboxState>(filePath);
    if (state) {
      return {
        schemaVersion: SCHEMA_VERSION,
        nextCursor: typeof state.nextCursor === "number" ? state.nextCursor : 0,
        events: Array.isArray(state.events) ? state.events : [],
      };
    }

    const initialState: InboxState = {
      schemaVersion: SCHEMA_VERSION,
      nextCursor: 0,
      events: [],
    };
    if (createIfMissing) {
      await this.writeInbox(agentId, initialState);
    }

    return initialState;
  }

  private async writeInbox(agentId: string, state: InboxState): Promise<void> {
    await writeJsonAtomic(await this.inboxFilePath(agentId), {
      schemaVersion: SCHEMA_VERSION,
      nextCursor: state.nextCursor,
      events: state.events,
    } satisfies InboxState);
  }

  private async listInboxAgents(): Promise<string[]> {
    const inboxesDir = await this.inboxesDirPath();
    const entries = await fs.readdir(inboxesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter(Boolean);
  }

  private async broadcastRecipients(): Promise<string[]> {
    const recipients = new Set<string>();
    const team = await this.readTeam();
    if (team) {
      for (const agent of team.agents) {
        if (agent.id) {
          recipients.add(agent.id);
        }
      }
    }
    for (const agentId of await this.listInboxAgents()) {
      recipients.add(agentId);
    }

    return [...recipients];
  }

  private async appendInboxEvent(
    recipients: string[],
    event: {
      type: string;
      taskId?: string;
      threadId?: string;
      actor?: string;
      summary?: string;
      content?: string;
    },
  ): Promise<void> {
    const uniqueRecipients = [...new Set(recipients.map((agentId) => agentId.trim()).filter(Boolean))];
    for (const rawAgentId of uniqueRecipients) {
      const agentId = ensureAgentId(rawAgentId);
      const state = await this.readInbox(agentId, true);
      const cursor = state.nextCursor + 1;
      const inboxEvent: InboxEventRecord = {
        schemaVersion: SCHEMA_VERSION,
        id: `inbox-${String(cursor).padStart(8, "0")}`,
        cursor,
        type: event.type,
        teamId: this.teamId,
        agentId,
        taskId: event.taskId,
        threadId: event.threadId,
        actor: event.actor,
        summary: event.summary,
        content: event.content,
        ts: nowIso(),
      };

      state.nextCursor = cursor;
      state.events.push(inboxEvent);
      await this.writeInbox(agentId, state);
    }
  }

  private async listTasksUnsafe(): Promise<TaskRecord[]> {
    const tasksDir = await this.tasksDirPath();
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
    const tasks = await Promise.all(
      files.map(async (fileName) => {
        const taskId = fileName.slice(0, -".json".length);
        return this.readTask(taskId);
      }),
    );

    return tasks.filter((task): task is TaskRecord => Boolean(task));
  }

  private async readCreateTaskIdempotency(): Promise<CreateTaskIdempotencyState> {
    const state = await this.readJsonFile<CreateTaskIdempotencyState>(await this.createTaskIdempotencyPath());
    if (state) {
      return state;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      entries: {},
    };
  }

  private async writeCreateTaskIdempotency(state: CreateTaskIdempotencyState): Promise<void> {
    await writeJsonAtomic(await this.createTaskIdempotencyPath(), state);
  }

  private async finalizeTask(input: FinalizeTaskInput, finalStatus: "completed" | "failed"): Promise<TaskRecord> {
    const task = await this.loadTaskOrThrow(input.taskId);
    if (task.status !== "in_progress" || !task.lease) {
      throw new TeamdStoreError(409, "TASK_NOT_IN_PROGRESS", `Task ${task.id} is not in progress.`);
    }

    if (isLeaseExpired(task.lease)) {
      throw new TeamdStoreError(403, "LEASE_EXPIRED", `Lease for task ${task.id} has expired.`);
    }

    if (task.lease.holder !== input.agentId) {
      throw new TeamdStoreError(403, "LEASE_HOLDER_MISMATCH", `Task ${task.id} is held by another agent.`);
    }

    if (task.lease.epoch !== input.epoch) {
      throw new TeamdStoreError(409, "EPOCH_MISMATCH", `Epoch mismatch for task ${task.id}.`);
    }

    task.status = finalStatus;
    task.lease = null;
    if (finalStatus === "completed") {
      task.timestamps.completedAt = nowIso();
    }
    if (finalStatus === "failed") {
      task.timestamps.failedAt = nowIso();
    }

    await this.writeTask(task);
    await this.appendAuditEvent({
      actor: input.agentId,
      type: finalStatus === "completed" ? "task_completed" : "task_failed",
      refs: { taskId: task.id },
      data: { epoch: input.epoch },
    });
    await this.appendInboxEvent(await this.broadcastRecipients(), {
      type: finalStatus === "completed" ? "task_completed" : "task_failed",
      taskId: task.id,
      actor: input.agentId,
      summary: `Task ${task.id} ${finalStatus} by ${input.agentId}`,
    });

    return task;
  }

  private async unlockDependents(completedTaskId: string, actor: string): Promise<void> {
    const tasks = await this.listTasksUnsafe();
    const completedTaskSet = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));

    for (const task of tasks) {
      if (task.status !== "blocked") {
        continue;
      }
      if (!task.deps.includes(completedTaskId)) {
        continue;
      }

      const allDepsComplete = task.deps.every((depId) => completedTaskSet.has(depId));
      if (!allDepsComplete) {
        continue;
      }

      task.status = "pending";
      await this.writeTask(task);
      await this.appendAuditEvent({
        actor,
        type: "task_unblocked",
        refs: { taskId: task.id },
        data: { deps: task.deps },
      });
    }
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async appendAuditEvent(event: {
    actor: string;
    type: string;
    refs?: Record<string, string>;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await appendJsonl(await this.auditFilePath(), {
      schemaVersion: SCHEMA_VERSION,
      id: `evt-${randomUUID()}`,
      actor: event.actor,
      type: event.type,
      refs: event.refs ?? {},
      data: event.data ?? {},
      ts: nowIso(),
    });
  }
}
