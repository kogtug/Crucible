/**
 * The actual "what does this server say" logic for the stateless fixture,
 * factored out from both entry points (`index.ts` for stdio, `httpServer.ts`
 * for Streamable HTTP) so the two transports can't quietly drift into
 * answering `server/discover` or `tools/list` differently. Everything here
 * is transport-agnostic on purpose: no stdout writes, no HTTP responses,
 * just plain objects describing a JSON-RPC result or error.
 *
 * Chaos-testing break modes that are about *not responding at all*
 * (hang-on-unknown-method, freeze-on-unknown-method) deliberately live in
 * the stdio entry point instead of here - those are about how a specific
 * transport loop behaves, not about what the server would say if it did
 * answer, and chaos-over-HTTP isn't implemented yet (see
 * docs/architecture.md, "Deferred, on purpose").
 *
 * createDispatcher() (rather than a single module-level dispatch function)
 * exists because the Tasks extension (below) needs a task store, and that
 * store has to be scoped per logical server instance, not per process: the
 * HTTP entry point creates a fresh instance per test via
 * createStatelessHttpServer(), and without its own store each instance
 * would otherwise share task state with every other instance created in
 * the same Node process - invisible in production (one process really is
 * one server there) but a real cross-test leak in exactly the kind of
 * test this repo runs constantly.
 */
import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = "2026-07-28";
export const SERVER_INFO = { name: "crucible-fixture-stateless", version: "0.1.0" };
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

const TASK_TTL_MS = 60_000;
const TASK_POLL_INTERVAL_MS = 50;

export interface HandlerResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface TaskRecord {
  status: "working" | "completed" | "failed";
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export function cacheFields(breakMode: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (breakMode !== "missing-result-type") fields.resultType = "complete";
  fields.ttlMs = breakMode === "negative-ttl" ? -1000 : 3_600_000;
  fields.cacheScope = breakMode === "bad-cache-scope" ? "shared" : "public";
  return fields;
}

export function isKnownMethod(method: string | undefined): boolean {
  return (
    method === "server/discover" ||
    method === "tools/list" ||
    method === "tools/call" ||
    method === "tasks/get"
  );
}

function checkProtocolVersion(
  params: Record<string, unknown> | undefined,
): HandlerResult | undefined {
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const requested = meta["io.modelcontextprotocol/protocolVersion"];
  if (requested !== PROTOCOL_VERSION) {
    return {
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [PROTOCOL_VERSION], requested: requested ?? "(none provided)" },
      },
    };
  }
  return undefined;
}

function clientDeclaresTasksExtension(params: Record<string, unknown> | undefined): boolean {
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const clientCapabilities = (meta["io.modelcontextprotocol/clientCapabilities"] ?? {}) as Record<
    string,
    unknown
  >;
  const extensions = (clientCapabilities.extensions ?? {}) as Record<string, unknown>;
  return TASKS_EXTENSION in extensions;
}

function handleDiscover(breakMode: string): HandlerResult {
  return {
    result: {
      ...cacheFields(breakMode),
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
      serverInfo: SERVER_INFO,
      instructions:
        "Crucible's fixture for the draft 2026-07-28 stateless/discover-based protocol era.",
    },
  };
}

function handleToolsList(
  breakMode: string,
  params: Record<string, unknown> | undefined,
): HandlerResult {
  const versionError = checkProtocolVersion(params);
  if (versionError) return versionError;

  return {
    result: {
      ...cacheFields(breakMode),
      tools: [
        {
          name: "echo",
          description: "Returns the given message unchanged.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        {
          name: "slow_echo",
          description:
            "Returns the given message after a delay. May be task-augmented (see the Tasks extension, io.modelcontextprotocol/tasks) if the client declares support.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
              delayMs: {
                type: "number",
                description: "How long to wait before completing. Defaults to 50.",
              },
            },
            required: ["message"],
          },
        },
      ],
    },
  };
}

/**
 * slow_echo is the one tool that supports task augmentation, per SEP-2663:
 * a server MAY return CreateTaskResult in lieu of the standard result, at
 * its own discretion, but MUST NOT do so for a client that didn't declare
 * the extension capability on this request. CRUCIBLE_BREAK=task-without-capability
 * violates that MUST NOT on purpose, so taskCapabilityConformance (in
 * @crucible/conformance) has a real negative case to catch.
 */
async function handleToolsCall(
  breakMode: string,
  taskStore: Map<string, TaskRecord>,
  params: Record<string, unknown> | undefined,
): Promise<HandlerResult> {
  const versionError = checkProtocolVersion(params);
  if (versionError) return versionError;

  const name = params?.name;
  if (name !== "slow_echo" && name !== "echo") {
    return { error: { code: -32602, message: `Invalid params: unknown tool '${String(name)}'` } };
  }

  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const message = typeof args.message === "string" ? args.message : "";
  const toolResult = { content: [{ type: "text", text: message }] };

  if (name === "echo") {
    return { result: { resultType: "complete", ...toolResult } };
  }

  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 50;
  const clientWantsTasks = clientDeclaresTasksExtension(params);
  const shouldCreateTask =
    breakMode === "task-without-capability" || (clientWantsTasks && breakMode !== "never-use-task");

  if (!shouldCreateTask) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { result: { resultType: "complete", ...toolResult } };
  }

  const taskId = randomUUID();
  const createdAt = new Date().toISOString();
  taskStore.set(taskId, {
    status: "working",
    createdAt,
    lastUpdatedAt: createdAt,
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  });

  setTimeout(() => {
    const record = taskStore.get(taskId);
    if (!record) return; // e.g. evicted - not implemented, but defensive
    record.status = "completed";
    record.lastUpdatedAt = new Date().toISOString();
    record.result = toolResult;
  }, delayMs);

  return {
    result: {
      resultType: "task",
      taskId,
      status: "working",
      createdAt,
      lastUpdatedAt: createdAt,
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
    },
  };
}

/**
 * CRUCIBLE_BREAK=task-resulttype-not-complete leaves resultType as "task"
 * on a terminal (completed) response instead of switching it to "complete"
 * - violating the explicit MUST in SEP-2663 ("The resultType field MUST be
 * set to 'complete' on this object as it is the standard result shape for
 * the tasks/get request") - so taskCreationConformance (which polls this
 * method to completion) has a real negative case for this specific,
 * easy-to-get-backwards rule.
 */
function handleTasksGet(
  breakMode: string,
  taskStore: Map<string, TaskRecord>,
  params: Record<string, unknown> | undefined,
): HandlerResult {
  const versionError = checkProtocolVersion(params);
  if (versionError) return versionError;

  const taskId = params?.taskId;
  const record = typeof taskId === "string" ? taskStore.get(taskId) : undefined;
  if (!record) {
    return {
      error: { code: -32602, message: `Invalid params: unknown taskId '${String(taskId)}'` },
    };
  }

  const resultType = breakMode === "task-resulttype-not-complete" ? "task" : "complete";
  const base = {
    resultType,
    taskId,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: record.ttlMs,
    pollIntervalMs: record.pollIntervalMs,
  };

  if (record.status === "completed") {
    return { result: { ...base, result: record.result } };
  }
  if (record.status === "failed") {
    return { result: { ...base, error: record.error } };
  }
  return { result: base }; // working
}

/** Creates a dispatcher with its own task store - see the module doc comment for why this is a factory, not a bare function. */
export function createDispatcher() {
  const taskStore = new Map<string, TaskRecord>();

  return async function dispatch(
    breakMode: string,
    method: string | undefined,
    params: Record<string, unknown> | undefined,
  ): Promise<HandlerResult> {
    switch (method) {
      case "server/discover":
        return handleDiscover(breakMode);
      case "tools/list":
        return handleToolsList(breakMode, params);
      case "tools/call":
        return handleToolsCall(breakMode, taskStore, params);
      case "tasks/get":
        return handleTasksGet(breakMode, taskStore, params);
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };
}
