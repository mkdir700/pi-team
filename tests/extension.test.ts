import { afterEach, describe, expect, it, vi } from "vitest";
import * as extensionModule from "../src/extension/index.js";

type BlockResult = { block: true; reason: string } | void;

interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

interface InboxEvent {
  type: string;
  taskId?: string;
  threadId?: string;
  actor?: string;
  summary?: string;
  content?: string;
}

interface TestContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level?: string): void;
  };
}

type ToolCallEventEnvelope = ToolCallEvent & { type?: "tool_call"; toolCallId?: string };
type SessionStartHandler = (event: { type: "session_start" }, ctx: TestContext) => Promise<void>;
type ToolCallHandler = (event: ToolCallEventEnvelope, ctx: TestContext) => Promise<BlockResult>;

class FakePi {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly tools = new Map<string, unknown>();
  readonly notifications: Array<{ content: string; options?: Record<string, unknown> }> = [];

  registerTool(definition: { name: string }): void {
    this.tools.set(definition.name, definition);
  }

  on(eventName: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(eventName, handler);
  }

  sendMessage(message: { content: string }, options?: Record<string, unknown>): void {
    this.notifications.push({ content: message.content, options });
  }
}

function makeContext(hasUI: boolean): TestContext {
  return {
    hasUI,
    ui: {
      notify: vi.fn(),
    },
  };
}

function setTeamEnv(): void {
  process.env.PI_TEAM_ID = "team-test";
  process.env.PI_AGENT_ID = "worker-a";
  process.env.PI_TEAMD_URL = "http://teamd.local";
  process.env.PI_TEAMD_TOKEN = "token-test";
}

function installExtension(pi: FakePi, options: Record<string, unknown> = {}): void {
  const registerExtension = (extensionModule as Record<string, unknown>).default;
  expect(typeof registerExtension).toBe("function");
  (registerExtension as (api: FakePi, opts?: Record<string, unknown>) => void)(pi, options);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_TEAM_ID;
  delete process.env.PI_AGENT_ID;
  delete process.env.PI_TEAMD_URL;
  delete process.env.PI_TEAMD_TOKEN;
  delete process.env.PI_TEAMD_TOKEN_FILE;
});

describe("team-coordination extension", () => {
  it("blocks write when lease is missing", async () => {
    setTeamEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ allow: false, reason: "no_active_lease_for_path" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const pi = new FakePi();
    installExtension(pi);
    const handler = pi.handlers.get("tool_call") as ToolCallHandler;
    const ctx = makeContext(true);

    const result = await handler(
      {
      toolName: "write",
      input: { filePath: "src/x.ts", content: "x" },
      },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: expect.stringMatching(/lease/i) });
  });

  it("blocks edit when lease is missing", async () => {
    setTeamEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ allow: false, reason: "no_active_lease_for_path" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const pi = new FakePi();
    installExtension(pi);
    const handler = pi.handlers.get("tool_call") as ToolCallHandler;
    const ctx = makeContext(true);

    const result = await handler(
      {
      toolName: "edit",
      input: { filePath: "src/x.ts", oldText: "a", newText: "b" },
      },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: expect.stringMatching(/lease/i) });
  });

  it("blocks bash when lease is missing", async () => {
    setTeamEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ allow: false, reason: "no_active_lease_for_path" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const pi = new FakePi();
    installExtension(pi);
    const handler = pi.handlers.get("tool_call") as ToolCallHandler;
    const ctx = makeContext(true);

    const result = await handler(
      {
      toolName: "bash",
      input: { command: "touch src/x.ts" },
      },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: expect.stringMatching(/lease/i) });
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("injects one-line inbox summaries only", async () => {
    setTeamEnv();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (!url.includes("/v1/inbox")) {
          return new Response(JSON.stringify({ allow: true, reason: "lease_active_for_resource" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            nextSince: "7",
            events: [
              {
                type: "task_completed",
                taskId: "task-001",
                actor: "worker_a",
                content: "full thread dump line 1\nline 2\nline 3",
              } satisfies InboxEvent,
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const pi = new FakePi();
    installExtension(pi, { inboxPollIntervalMs: 5000 });
    const sessionStart = pi.handlers.get("session_start") as SessionStartHandler;

    await sessionStart({ type: "session_start" }, makeContext(true));

    expect(pi.notifications).toHaveLength(1);
    expect(pi.notifications[0]?.content).toMatch(/^INBOX: task_completed task-001 by worker_a$/);
    expect(pi.notifications[0]?.content).not.toContain("\n");
    expect(pi.notifications[0]?.content).not.toContain("full thread dump");
    expect(pi.notifications[0]?.options).toMatchObject({ deliverAs: "steer" });

    vi.useRealTimers();
  });

  it("blocks write conservatively when UI is unavailable", async () => {
    setTeamEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ allow: true, reason: "lease_active_for_resource" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const pi = new FakePi();
    installExtension(pi);
    const handler = pi.handlers.get("tool_call") as ToolCallHandler;

    const result = await handler(
      {
      toolName: "write",
      input: { filePath: "src/x.ts", content: "x" },
      },
      makeContext(false),
    );

    expect(result).toEqual({ block: true, reason: expect.stringMatching(/ui|lease|conservative/i) });
  });
});
