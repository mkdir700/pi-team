import { createTeamdClient, type InboxEvent, type TeamdClient } from "./teamd-client.js";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";

export type ToolCallEventLike = ToolCallEvent;

export type ExtensionContextLike = ExtensionContext;

interface LocalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((payload: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

export type ExtensionAPILike = Pick<ExtensionAPI, "on" | "sendMessage"> & {
  registerTool(definition: LocalToolDefinition): void;
};

export interface TeamCoordinationOptions {
  inboxPollIntervalMs?: number;
  teamdClient?: TeamdClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: typeof import("node:fs/promises").readFile;
}

const GUARDED_TOOL_NAMES = new Set(["write", "edit", "bash"]);
const DEFAULT_INBOX_POLL_INTERVAL_MS = 15_000;

interface ToolCallBlockResult {
  block: true;
  reason: string;
}

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
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "write" || event.toolName === "edit") {
    return asString(input.filePath) || asString(input.path) || ".";
  }

  if (event.toolName === "bash") {
    return asString(input.path) || ".";
  }

  return ".";
}

function summarizeInboxEvent(event: InboxEvent): string {
  const ref = event.taskId || event.threadId || "";
  const actor = event.actor ? ` by ${event.actor}` : "";
  const summary = `INBOX: ${event.type}${ref ? ` ${ref}` : ""}${actor}`;
  return summary.replace(/\s+/g, " ").replace(/[\r\n]+/g, " ").trim();
}

function notifyIfPossible(ctx: ExtensionContextLike, message: string): void {
  if (!ctx.hasUI) {
    return;
  }
  ctx.ui.notify(message, "warning");
}

function blocked(reason: string): ToolCallBlockResult {
  return {
    block: true,
    reason,
  };
}

function schemaString(): Record<string, unknown> {
  return { type: "string" };
}

function schemaNumber(): Record<string, unknown> {
  return { type: "number" };
}

function schemaStringArray(): Record<string, unknown> {
  return { type: "array", items: { type: "string" } };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false } {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function registerTools(pi: ExtensionAPILike, client: TeamdClient): void {
  pi.registerTool({
    name: "team_tasks_create",
    label: "team_tasks_create",
    description: "Create a team task.",
    parameters: objectSchema(
      {
        title: schemaString(),
        description: schemaString(),
        deps: schemaStringArray(),
        resources: schemaStringArray(),
      },
      ["title"],
    ),
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
    name: "team_tasks_claim",
    label: "team_tasks_claim",
    description: "Claim a team task lease.",
    parameters: objectSchema(
      {
        taskId: schemaString(),
        ttlMs: schemaNumber(),
      },
      ["taskId"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.claimTask(asString(params.taskId), asNumber(params.ttlMs) || undefined);
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_tasks_complete",
    label: "team_tasks_complete",
    description: "Complete a claimed task.",
    parameters: objectSchema(
      {
        taskId: schemaString(),
        epoch: schemaNumber(),
      },
      ["taskId", "epoch"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.completeTask(asString(params.taskId), asNumber(params.epoch));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_tasks_fail",
    label: "team_tasks_fail",
    description: "Fail a claimed task.",
    parameters: objectSchema(
      {
        taskId: schemaString(),
        epoch: schemaNumber(),
      },
      ["taskId", "epoch"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.failTask(asString(params.taskId), asNumber(params.epoch));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_tasks_list",
    label: "team_tasks_list",
    description: "List team tasks.",
    parameters: objectSchema({}),
    execute: async () => {
      const result = await client.listTasks();
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_threads_start",
    label: "team_threads_start",
    description: "Start a team thread.",
    parameters: objectSchema({
      title: schemaString(),
      participants: schemaStringArray(),
      taskId: schemaString(),
    }),
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
    name: "team_threads_post",
    label: "team_threads_post",
    description: "Post a message into a team thread.",
    parameters: objectSchema(
      {
        threadId: schemaString(),
        message: schemaString(),
      },
      ["threadId", "message"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.postThreadMessage(asString(params.threadId), {
        message: asString(params.message),
      });
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_threads_read_tail",
    label: "team_threads_read_tail",
    description: "Read thread tail.",
    parameters: objectSchema(
      {
        threadId: schemaString(),
        limit: schemaNumber(),
      },
      ["threadId"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.readThreadTail(asString(params.threadId), asNumber(params.limit) || undefined);
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_threads_search",
    label: "team_threads_search",
    description: "Search team threads.",
    parameters: objectSchema(
      {
        query: schemaString(),
      },
      ["query"],
    ),
    execute: async (_toolCallId, params) => {
      const result = await client.searchThreads(asString(params.query));
      return buildToolResult(result);
    },
  });

  pi.registerTool({
    name: "team_threads_link_to_task",
    label: "team_threads_link_to_task",
    description: "Link a thread to a task.",
    parameters: objectSchema(
      {
        threadId: schemaString(),
        taskId: schemaString(),
      },
      ["threadId", "taskId"],
    ),
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

  pi.on("session_start", async () => {
    await pollInbox();
    setInterval(() => {
      void pollInbox();
    }, pollIntervalMs);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED_TOOL_NAMES.has(event.toolName)) {
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
