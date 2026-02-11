import { createTeamdClient, type InboxEvent, type TeamdClient } from "./teamd-client.js";

export interface ToolCallEventLike {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ExtensionContextLike {
  hasUI: boolean;
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (payload: unknown) => void,
    ctx: ExtensionContextLike,
  ) => Promise<unknown>;
}

export interface ExtensionAPILike {
  registerTool(definition: ToolDefinition): void;
  on(eventName: string, handler: (...args: unknown[]) => unknown): void;
  sendMessage(message: { content: string; customType?: string; display?: boolean }, options?: Record<string, unknown>): void;
}

export interface TeamCoordinationOptions {
  inboxPollIntervalMs?: number;
  teamdClient?: TeamdClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: typeof import("node:fs/promises").readFile;
}

interface ToolCallBlockResult {
  block: true;
  reason: string;
}

const GUARDED_TOOL_NAMES = new Set(["write", "edit", "bash"]);
const DEFAULT_INBOX_POLL_INTERVAL_MS = 15_000;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => asString(item)).filter(Boolean);
}

function resultText(value: unknown): string {
  return JSON.stringify(value);
}

function buildToolResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [{ type: "text", text: resultText(value) }],
    details: value,
  };
}

function extractTargetPath(event: ToolCallEventLike): string {
  if (event.toolName === "write" || event.toolName === "edit") {
    return asString(event.input.filePath) || asString(event.input.path) || ".";
  }

  if (event.toolName === "bash") {
    return asString(event.input.path) || ".";
  }

  return ".";
}

function summarizeInboxEvent(event: InboxEvent): string {
  const ref = event.taskId || event.threadId || "";
  const actor = event.actor ? ` by ${event.actor}` : "";
  const summary = `INBOX: ${event.type}${ref ? ` ${ref}` : ""}${actor}`;
  return summary.replace(/\s+/g, " ").replace(/[\r\n]+/g, " ").trim();
}

function resolveToolCallArgs(args: unknown[]): { ctx: ExtensionContextLike | null; event: ToolCallEventLike | null } {
  const [first, second] = args;
  if (first && typeof first === "object" && "toolName" in (first as Record<string, unknown>)) {
    return {
      event: first as ToolCallEventLike,
      ctx: (second as ExtensionContextLike | undefined) ?? null,
    };
  }

  if (second && typeof second === "object" && "toolName" in (second as Record<string, unknown>)) {
    return {
      event: second as ToolCallEventLike,
      ctx: (first as ExtensionContextLike | undefined) ?? null,
    };
  }

  return {
    event: null,
    ctx: null,
  };
}

function resolveContext(args: unknown[]): ExtensionContextLike {
  const first = args[0] as ExtensionContextLike | undefined;
  const second = args[1] as ExtensionContextLike | undefined;
  if (first && typeof first.hasUI === "boolean") {
    return first;
  }
  if (second && typeof second.hasUI === "boolean") {
    return second;
  }
  return { hasUI: false };
}

function notifyIfPossible(ctx: ExtensionContextLike | null, message: string): void {
  if (!ctx?.hasUI) {
    return;
  }
  ctx.ui?.notify(message, "warning");
}

function blocked(reason: string): ToolCallBlockResult {
  return {
    block: true,
    reason,
  };
}

function registerTools(pi: ExtensionAPILike, client: TeamdClient): void {
  pi.registerTool({
    name: "team.tasks.create",
    description: "Create a team task.",
    parameters: {
      title: "string",
      description: "string?",
      deps: "string[]?",
      resources: "string[]?",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.createTask({
        title: asString(params.title),
        description: asString(params.description),
        deps: asStringArray(params.deps),
        resources: asStringArray(params.resources),
      });
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.tasks.claim",
    description: "Claim a team task lease.",
    parameters: {
      taskId: "string",
      ttlMs: "number?",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.claimTask(asString(params.taskId), asNumber(params.ttlMs) || undefined);
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.tasks.complete",
    description: "Complete a claimed task.",
    parameters: {
      taskId: "string",
      epoch: "number",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.completeTask(asString(params.taskId), asNumber(params.epoch));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.tasks.fail",
    description: "Fail a claimed task.",
    parameters: {
      taskId: "string",
      epoch: "number",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.failTask(asString(params.taskId), asNumber(params.epoch));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.tasks.list",
    description: "List team tasks.",
    parameters: {},
    execute: async () => {
      const result = await client.listTasks();
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.threads.start",
    description: "Start a team thread.",
    parameters: {
      title: "string?",
      participants: "string[]?",
      taskId: "string?",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.startThread({
        title: asString(params.title),
        participants: asStringArray(params.participants),
        taskId: asString(params.taskId),
      });
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.threads.post",
    description: "Post a message into a team thread.",
    parameters: {
      threadId: "string",
      message: "string",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.postThreadMessage(asString(params.threadId), {
        message: asString(params.message),
      });
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.threads.readTail",
    description: "Read thread tail.",
    parameters: {
      threadId: "string",
      limit: "number?",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.readThreadTail(asString(params.threadId), asNumber(params.limit) || undefined);
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.threads.search",
    description: "Search team threads.",
    parameters: {
      query: "string",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.searchThreads(asString(params.query));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team.threads.linkToTask",
    description: "Link a thread to a task.",
    parameters: {
      threadId: "string",
      taskId: "string",
    },
    execute: async (_toolCallId, params) => {
      const result = await client.linkThreadToTask(asString(params.threadId), asString(params.taskId));
      return buildToolResult(result);
    },
  });
}

export function registerTeamCoordinationExtension(pi: ExtensionAPILike, options: TeamCoordinationOptions = {}): void {
  const client =
    options.teamdClient ??
    createTeamdClient({
      env: options.env,
      fetchImpl: options.fetchImpl,
      readFileImpl: options.readFileImpl,
    });

  registerTools(pi, client);

  let sinceCursor: string | undefined;
  const pollIntervalMs = options.inboxPollIntervalMs ?? DEFAULT_INBOX_POLL_INTERVAL_MS;

  const pollInbox = async (): Promise<void> => {
    const inbox = await client.fetchInbox(sinceCursor);
    if (!inbox.events.length) {
      if (inbox.nextSince) {
        sinceCursor = inbox.nextSince;
      }
      return;
    }

    for (const event of inbox.events) {
      const summary = summarizeInboxEvent(event);
      pi.sendMessage(
        {
          customType: "team-inbox",
          content: summary,
          display: true,
        },
        {
          deliverAs: "steer",
        },
      );
    }

    sinceCursor = inbox.nextSince ?? sinceCursor;
  };

  pi.on("session_start", async (...args: unknown[]) => {
    resolveContext(args);
    await pollInbox();
    setInterval(() => {
      void pollInbox();
    }, pollIntervalMs);
  });

  pi.on("tool_call", async (...args: unknown[]) => {
    const { ctx, event } = resolveToolCallArgs(args);
    if (!ctx || !event || !GUARDED_TOOL_NAMES.has(event.toolName)) {
      return;
    }

    if (!ctx.hasUI) {
      return blocked("Write blocked: conservative mode requires UI and active lease.");
    }

    const path = extractTargetPath(event);
    const permission = await client.canWrite(path);
    if (permission.allow) {
      return;
    }

    const reason = `Write blocked: active lease required (${permission.reason}).`;
    notifyIfPossible(ctx, reason);
    return blocked(reason);
  });
}
