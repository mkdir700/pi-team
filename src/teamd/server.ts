import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { TeamdStore, TeamdStoreError, type TeamRecord } from "./store.js";

const SCHEMA_VERSION = "1.0.0";

export interface TeamdHttpServerOptions {
  store: TeamdStore;
  teamId: string;
  token: string;
  host: string;
  port: number;
  version: string;
}

export interface TeamdHttpServerHandle {
  url: string;
  close(): Promise<void>;
}

type JsonBody = Record<string, unknown>;

interface HttpErrorLike {
  statusCode: number;
  code: string;
  message: string;
}

function sendJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TeamdStoreError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  return parsed as JsonBody;
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [kind, value] = header.split(" ");
  if (kind !== "Bearer" || !value) {
    return null;
  }

  return value;
}

function toStoreError(error: unknown): HttpErrorLike {
  if (error instanceof TeamdStoreError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return {
      statusCode: 400,
      code: "INVALID_JSON",
      message: error.message,
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Unexpected server error.",
  };
}

function bodyString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bodyNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bodyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const mapped = value.map((item) => bodyString(item).trim()).filter(Boolean);
  return mapped;
}

export async function startTeamdHttpServer(options: TeamdHttpServerOptions): Promise<TeamdHttpServerHandle> {
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://${options.host}`);
    const pathName = requestUrl.pathname;

    try {
      if (method === "GET" && pathName === "/healthz") {
        sendJson(response, 200, {
          status: "ok",
          version: options.version,
        });
        return;
      }

      if (pathName.startsWith("/v1/")) {
        const token = parseBearerToken(request.headers.authorization);
        if (token !== options.token) {
          sendJson(response, 401, {
            error: {
              code: "UNAUTHORIZED",
              message: "Missing or invalid bearer token.",
            },
          });
          return;
        }
      }

      if (method === "GET" && pathName === "/v1/teams") {
        const teams = await options.store.listTeams();
        sendJson(response, 200, { teams });
        return;
      }

      if (method === "POST" && pathName === "/v1/teams") {
        const body = await readJsonBody(request);
        const teamId = bodyString(body.teamId).trim() || options.teamId;
        const agents = Array.isArray(body.agents)
          ? body.agents
              .filter((agent) => agent && typeof agent === "object")
              .map((agent) => {
                const record = agent as Record<string, unknown>;
                return {
                  id: bodyString(record.id),
                  role: bodyString(record.role),
                  model: bodyString(record.model) || undefined,
                };
              })
              .filter((agent) => agent.id && agent.role)
          : [];

        const team = await options.store.createTeam({
          schemaVersion: SCHEMA_VERSION,
          teamId,
          agents,
        } satisfies TeamRecord);
        sendJson(response, 201, { team });
        return;
      }

      if (method === "GET" && pathName.startsWith("/v1/teams/")) {
        const teamId = decodeURIComponent(pathName.slice("/v1/teams/".length));
        const team = await options.store.getTeam(teamId);
        sendJson(response, 200, { team });
        return;
      }

      if (method === "GET" && pathName === "/v1/tasks") {
        const teamId = requestUrl.searchParams.get("teamId") ?? "";
        const tasks = await options.store.listTasks(teamId);
        sendJson(response, 200, { tasks });
        return;
      }

      if (method === "POST" && pathName === "/v1/tasks") {
        const body = await readJsonBody(request);
        const teamId = bodyString(body.teamId);
        const idempotencyKey = request.headers["idempotency-key"];
        const idempotencyHeader = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;

        const result = await options.store.createTask(
          teamId,
          {
            title: bodyString(body.title),
            description: bodyString(body.description) || undefined,
            deps: bodyStringArray(body.deps),
            resources: bodyStringArray(body.resources),
          },
          idempotencyHeader,
        );

        sendJson(response, result.created ? 201 : 200, {
          task: result.task,
        });
        return;
      }

      if (method === "GET" && pathName.startsWith("/v1/tasks/")) {
        const taskId = decodeURIComponent(pathName.slice("/v1/tasks/".length));
        const teamId = requestUrl.searchParams.get("teamId") ?? "";
        const task = await options.store.getTask(teamId, taskId);
        sendJson(response, 200, { task });
        return;
      }

      const claimMatch = /^\/v1\/tasks\/([^/]+)\/(claim|renew|complete|fail)$/.exec(pathName);
      if (claimMatch && method === "POST") {
        const taskId = decodeURIComponent(claimMatch[1] ?? "");
        const action = claimMatch[2] ?? "";
        const body = await readJsonBody(request);
        const teamId = bodyString(body.teamId);
        const agentId = bodyString(body.agentId);

        if (action === "claim") {
          const result = await options.store.claimTask(teamId, {
            taskId,
            agentId,
            ttlMs: bodyNumber(body.ttlMs),
          });
          sendJson(response, 200, {
            task: result.task,
            lease: result.lease,
          });
          return;
        }

        if (action === "renew") {
          const result = await options.store.renewTask(teamId, {
            taskId,
            agentId,
            epoch: bodyNumber(body.epoch) ?? -1,
            ttlMs: bodyNumber(body.ttlMs),
          });
          sendJson(response, 200, {
            task: result.task,
            lease: result.lease,
          });
          return;
        }

        if (action === "complete") {
          const result = await options.store.completeTask(teamId, {
            taskId,
            agentId,
            epoch: bodyNumber(body.epoch) ?? -1,
          });
          sendJson(response, 200, { task: result.task });
          return;
        }

        if (action === "fail") {
          const result = await options.store.failTask(teamId, {
            taskId,
            agentId,
            epoch: bodyNumber(body.epoch) ?? -1,
          });
          sendJson(response, 200, { task: result.task });
          return;
        }
      }

      if (method === "GET" && pathName === "/v1/inbox") {
        const teamId = requestUrl.searchParams.get("teamId") ?? "";
        const agentId = requestUrl.searchParams.get("agentId") ?? "";
        const since = requestUrl.searchParams.get("since") ?? undefined;
        const result = await options.store.fetchInbox(teamId, agentId, since);
        sendJson(response, 200, result);
        return;
      }

      if (method === "POST" && pathName === "/v1/threads") {
        const body = await readJsonBody(request);
        const teamId = bodyString(body.teamId) || options.teamId;
        const result = await options.store.startThread(teamId, {
          title: bodyString(body.title) || undefined,
          participants: bodyStringArray(body.participants),
          taskId: bodyString(body.taskId) || undefined,
          agentId: bodyString(body.agentId) || undefined,
        });
        sendJson(response, 201, result);
        return;
      }

      if (method === "GET" && pathName === "/v1/threads/search") {
        const teamId = requestUrl.searchParams.get("teamId") ?? options.teamId;
        const query = requestUrl.searchParams.get("q") ?? "";
        const result = await options.store.searchThreads(teamId, query);
        sendJson(response, 200, result);
        return;
      }

      const threadMatch = /^\/v1\/threads\/([^/]+)\/(messages|tail|link)$/.exec(pathName);
      if (threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1] ?? "");
        const action = threadMatch[2] ?? "";

        if (action === "messages" && method === "POST") {
          const body = await readJsonBody(request);
          const teamId = bodyString(body.teamId) || options.teamId;
          const result = await options.store.postThreadMessage(teamId, {
            threadId,
            agentId: bodyString(body.agentId) || "system",
            message: bodyString(body.message),
          });
          sendJson(response, 201, result);
          return;
        }

        if (action === "tail" && method === "GET") {
          const teamId = requestUrl.searchParams.get("teamId") ?? options.teamId;
          const limit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "20", 10);
          const result = await options.store.readThreadTail(teamId, threadId, Number.isFinite(limit) ? limit : 20);
          sendJson(response, 200, result);
          return;
        }

        if (action === "link" && method === "POST") {
          const body = await readJsonBody(request);
          const teamId = bodyString(body.teamId) || options.teamId;
          const result = await options.store.linkThreadToTask(teamId, {
            threadId,
            taskId: bodyString(body.taskId),
          });
          sendJson(response, 200, result);
          return;
        }
      }

      if (method === "GET" && pathName === "/v1/can-write") {
        const teamId = requestUrl.searchParams.get("teamId") ?? "";
        const agentId = requestUrl.searchParams.get("agentId") ?? "";
        const targetPath = requestUrl.searchParams.get("path") ?? "";
        const result = await options.store.canWrite(teamId, agentId, targetPath);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: `Route not found: ${method} ${pathName}`,
        },
      });
    } catch (error) {
      const storeError = toStoreError(error);
      sendJson(response, storeError.statusCode, {
        error: {
          code: storeError.code,
          message: storeError.message,
        },
      });
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine teamd listen address.");
  }

  return {
    url: `http://${address.address}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    },
  };
}
