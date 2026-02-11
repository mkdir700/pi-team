import { readFile } from "node:fs/promises";

export interface TeamdClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: typeof readFile;
}

export interface CanWriteResult {
  allow: boolean;
  reason: string;
}

export interface InboxEvent {
  type: string;
  taskId?: string;
  threadId?: string;
  actor?: string;
  summary?: string;
  content?: string;
}

export interface InboxResponse {
  events: InboxEvent[];
  nextSince?: string;
}

interface DiscoveryData {
  teamId: string;
  agentId: string;
  baseUrl: string;
  token: string;
}

interface TokenFileData {
  token?: string;
  url?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  requireAgent?: boolean;
}

interface TeamdErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

interface TeamdClient {
  canWrite(path: string): Promise<CanWriteResult>;
  fetchInbox(since?: string): Promise<InboxResponse>;
  createTask(input: {
    title: string;
    description?: string;
    deps?: string[];
    resources?: string[];
  }): Promise<unknown>;
  claimTask(taskId: string, ttlMs?: number): Promise<unknown>;
  completeTask(taskId: string, epoch: number): Promise<unknown>;
  failTask(taskId: string, epoch: number): Promise<unknown>;
  listTasks(): Promise<unknown>;
  startThread(input: { title?: string; participants?: string[]; taskId?: string }): Promise<unknown>;
  postThreadMessage(threadId: string, input: { message: string }): Promise<unknown>;
  readThreadTail(threadId: string, limit?: number): Promise<unknown>;
  searchThreads(query: string): Promise<unknown>;
  linkThreadToTask(threadId: string, taskId: string): Promise<unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => asString(item)).filter(Boolean);
}

function normalizeUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

async function parseTokenFile(tokenFilePath: string, reader: typeof readFile): Promise<TokenFileData> {
  const raw = (await reader(tokenFilePath, "utf8")).trim();
  if (!raw) {
    return {};
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        token: asString(parsed.token),
        url: asString(parsed.url),
      };
    } catch {
      return {};
    }
  }

  const token = raw.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return token ? { token } : {};
}

export function createTeamdClient(options: TeamdClientOptions = {}): TeamdClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const readFileImpl = options.readFileImpl ?? readFile;

  async function discover(requireAgent: boolean): Promise<DiscoveryData | null> {
    let url = asString(env.PI_TEAMD_URL);
    let token = asString(env.PI_TEAMD_TOKEN);
    const teamId = asString(env.PI_TEAM_ID);
    const agentId = asString(env.PI_AGENT_ID);

    const tokenFile = asString(env.PI_TEAMD_TOKEN_FILE);
    if ((!token || !url) && tokenFile) {
      try {
        const fromFile = await parseTokenFile(tokenFile, readFileImpl);
        token ||= fromFile.token ?? "";
        url ||= fromFile.url ?? "";
      } catch {
        return null;
      }
    }

    if (!url || !token || !teamId) {
      return null;
    }
    if (requireAgent && !agentId) {
      return null;
    }

    return {
      baseUrl: normalizeUrl(url),
      token,
      teamId,
      agentId,
    };
  }

  async function requestJson(path: string, method: string, options: RequestOptions = {}): Promise<unknown> {
    const discovery = await discover(Boolean(options.requireAgent));
    if (!discovery) {
      throw new Error("missing_teamd_discovery");
    }

    const url = new URL(`${discovery.baseUrl}${path}`);
    const queryEntries = Object.entries(options.query ?? {});
    for (const [key, value] of queryEntries) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      let message = `${response.status}`;
      try {
        const payload = (await response.json()) as TeamdErrorPayload;
        message = payload.error?.message ?? payload.error?.code ?? message;
      } catch {
        message = `${response.status}`;
      }
      throw new Error(message);
    }

    return (await response.json()) as unknown;
  }

  async function teamdData(requireAgent = false): Promise<DiscoveryData | null> {
    return discover(requireAgent);
  }

  return {
    canWrite: async (path: string): Promise<CanWriteResult> => {
      const discovery = await teamdData(true);
      if (!discovery) {
        return {
          allow: false,
          reason: "missing_teamd_discovery",
        };
      }

      const query = {
        teamId: discovery.teamId,
        agentId: discovery.agentId,
        path,
      };

      try {
        const result = (await requestJson("/v1/can-write", "GET", {
          query,
          requireAgent: true,
        })) as Partial<CanWriteResult>;

        return {
          allow: result.allow === true,
          reason: asString(result.reason) || (result.allow === true ? "lease_active_for_resource" : "lease_required"),
        };
      } catch {
        return {
          allow: false,
          reason: "can_write_check_failed",
        };
      }
    },

    fetchInbox: async (since?: string): Promise<InboxResponse> => {
      const discovery = await teamdData(true);
      if (!discovery) {
        return { events: [] };
      }

      try {
        const payload = (await requestJson("/v1/inbox", "GET", {
          requireAgent: true,
          query: {
            teamId: discovery.teamId,
            agentId: discovery.agentId,
            since,
          },
        })) as {
          events?: unknown;
          nextSince?: unknown;
        };

        const events = Array.isArray(payload.events)
          ? payload.events
              .filter((item) => item && typeof item === "object")
              .map((item) => {
                const record = item as Record<string, unknown>;
                return {
                  type: asString(record.type) || "event",
                  taskId: asString(record.taskId) || undefined,
                  threadId: asString(record.threadId) || undefined,
                  actor: asString(record.actor) || undefined,
                  summary: asString(record.summary) || undefined,
                  content: asString(record.content) || undefined,
                } satisfies InboxEvent;
              })
          : [];

        return {
          events,
          nextSince: asString(payload.nextSince) || undefined,
        };
      } catch {
        return { events: [] };
      }
    },

    createTask: async (input): Promise<unknown> => {
      const discovery = await teamdData(false);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson("/v1/tasks", "POST", {
        body: {
          teamId: discovery.teamId,
          title: asString(input.title),
          description: asString(input.description),
          deps: asStringArray(input.deps),
          resources: asStringArray(input.resources),
        },
      });
    },

    claimTask: async (taskId, ttlMs): Promise<unknown> => {
      const discovery = await teamdData(true);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson(`/v1/tasks/${encodeURIComponent(taskId)}/claim`, "POST", {
        requireAgent: true,
        body: {
          teamId: discovery.teamId,
          agentId: discovery.agentId,
          ttlMs,
        },
      });
    },

    completeTask: async (taskId, epoch): Promise<unknown> => {
      const discovery = await teamdData(true);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson(`/v1/tasks/${encodeURIComponent(taskId)}/complete`, "POST", {
        requireAgent: true,
        body: {
          teamId: discovery.teamId,
          agentId: discovery.agentId,
          epoch,
        },
      });
    },

    failTask: async (taskId, epoch): Promise<unknown> => {
      const discovery = await teamdData(true);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson(`/v1/tasks/${encodeURIComponent(taskId)}/fail`, "POST", {
        requireAgent: true,
        body: {
          teamId: discovery.teamId,
          agentId: discovery.agentId,
          epoch,
        },
      });
    },

    listTasks: async (): Promise<unknown> => {
      const discovery = await teamdData(false);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson("/v1/tasks", "GET", {
        query: {
          teamId: discovery.teamId,
        },
      });
    },

    startThread: async (input): Promise<unknown> => {
      const discovery = await teamdData(false);
      if (!discovery) {
        throw new Error("missing_teamd_discovery");
      }

      return requestJson("/v1/threads", "POST", {
        body: {
          teamId: discovery.teamId,
          title: asString(input.title),
          participants: asStringArray(input.participants),
          taskId: asString(input.taskId),
        },
      });
    },

    postThreadMessage: async (threadId, input): Promise<unknown> => {
      return requestJson(`/v1/threads/${encodeURIComponent(threadId)}/messages`, "POST", {
        body: {
          message: asString(input.message),
        },
      });
    },

    readThreadTail: async (threadId, limit): Promise<unknown> => {
      return requestJson(`/v1/threads/${encodeURIComponent(threadId)}/tail`, "GET", {
        query: {
          limit,
        },
      });
    },

    searchThreads: async (query): Promise<unknown> => {
      return requestJson("/v1/threads/search", "GET", {
        query: {
          q: query,
        },
      });
    },

    linkThreadToTask: async (threadId, taskId): Promise<unknown> => {
      return requestJson(`/v1/threads/${encodeURIComponent(threadId)}/link`, "POST", {
        body: {
          taskId,
        },
      });
    },
  };
}

export type { TeamdClient };
