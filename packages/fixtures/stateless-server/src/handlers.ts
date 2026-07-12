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
 */

export const PROTOCOL_VERSION = "2026-07-28";
export const SERVER_INFO = { name: "crucible-fixture-stateless", version: "0.1.0" };

export interface HandlerResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export function cacheFields(breakMode: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (breakMode !== "missing-result-type") fields.resultType = "complete";
  fields.ttlMs = breakMode === "negative-ttl" ? -1000 : 3_600_000;
  fields.cacheScope = breakMode === "bad-cache-scope" ? "shared" : "public";
  return fields;
}

export function isKnownMethod(method: string | undefined): boolean {
  return method === "server/discover" || method === "tools/list";
}

function handleDiscover(breakMode: string): HandlerResult {
  return {
    result: {
      ...cacheFields(breakMode),
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: "Crucible's fixture for the draft 2026-07-28 stateless/discover-based protocol era.",
    },
  };
}

function handleToolsList(breakMode: string, params: Record<string, unknown> | undefined): HandlerResult {
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
      ],
    },
  };
}

/** Routes a parsed JSON-RPC method/params to the right handler, or a -32601 for anything else. */
export function dispatch(
  breakMode: string,
  method: string | undefined,
  params: Record<string, unknown> | undefined,
): HandlerResult {
  switch (method) {
    case "server/discover":
      return handleDiscover(breakMode);
    case "tools/list":
      return handleToolsList(breakMode, params);
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
