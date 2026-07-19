/**
 * The Streamable HTTP entry point for the stateless fixture - same
 * server/discover and tools/list logic as index.ts (stdio), via the shared
 * handlers.ts, plus the HTTP-specific header validation the draft spec
 * requires (SEP-2243): every POST must carry an `Mcp-Method` header
 * mirroring the body's `method`, an `MCP-Protocol-Version` header
 * mirroring the body's `_meta` protocol version, and - for `tools/call`
 * and (per the Tasks extension, SEP-2663) `tasks/get` - an `Mcp-Name`
 * header mirroring the tool name or taskId respectively. A mismatch is a
 * `HeaderMismatch` (-32020) error, not something to silently let through.
 *
 * Only the single-JSON-response path is implemented - the draft spec also
 * allows a server to respond with an SSE stream, but nothing in this repo
 * yet needs one (no long-running or subscription-style calls), so building
 * that would be speculative rather than something a check drives. See
 * docs/architecture.md, "Deferred, on purpose".
 *
 * CRUCIBLE_BREAK=skip-header-validation disables the header checks
 * described above (everything else about the response stays correct), so
 * httpHeaderConformance has a real negative case to catch, not just a
 * positive one. The conformance and Tasks break modes from handlers.ts
 * work here too, via the same shared dispatcher.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createDispatcher } from "./handlers.js";

const HEADER_MISMATCH = -32020;

interface RpcRequestBody {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function writeHeaderMismatch(
  res: ServerResponse,
  id: string | number | null,
  detail: string,
): void {
  writeJson(res, 400, {
    jsonrpc: "2.0",
    id,
    error: { code: HEADER_MISMATCH, message: `Header mismatch: ${detail}` },
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The Mcp-Name header's expected value for this request, or undefined if the method doesn't need one. Per SEP-2243 (tools/call) and SEP-2663 (tasks/get, mirrored for consistency even though this fixture doesn't implement tasks/update or tasks/cancel). */
function expectedMcpName(
  method: string | undefined,
  params: Record<string, unknown> | undefined,
): string | undefined {
  if (method === "tools/call") return typeof params?.name === "string" ? params.name : undefined;
  if (method === "tasks/get") return typeof params?.taskId === "string" ? params.taskId : undefined;
  return undefined;
}

/**
 * Exported so tests can start this in-process on an OS-assigned port
 * (`.listen(0)`) instead of spawning a child process. `breakMode` is a
 * real parameter, not read from `process.env` internally, on purpose: a
 * module-level `const BREAK_MODE = process.env.CRUCIBLE_BREAK` would be
 * evaluated once at import time, which works fine for the standalone
 * -script path below (a fresh process per break mode) but silently breaks
 * in-process tests that construct this server more than once with
 * different modes in the same process - found by actually testing that
 * exact scenario, not by inspection.
 *
 * Each call gets its own dispatcher (and so its own Tasks extension task
 * store, via createDispatcher() in handlers.ts) - tests routinely create
 * more than one of these in the same process, and a shared, module-level
 * store would otherwise leak task state between what are meant to be
 * independent server instances.
 */
export function createStatelessHttpServer(
  breakMode: string = process.env.CRUCIBLE_BREAK ?? "",
): Server {
  const dispatch = createDispatcher();

  // node:http's request-handler type is (req, res) => void - it never
  // awaits whatever the callback returns, so an async function passed
  // directly here would leave its own rejections unhandled if something
  // threw after the point a response should have been sent (the request
  // would just hang forever, silently). This wrapper keeps the actual
  // callback synchronous and explicit about handling that promise itself,
  // with a real fallback response instead of a silently unhandled one.
  return createServer((req, res) => {
    void handleRequest(req, res, breakMode, dispatch).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeJson(res, 500, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  breakMode: string,
  dispatch: ReturnType<typeof createDispatcher>,
): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "Only POST is supported on this endpoint" },
    });
    return;
  }

  let body: RpcRequestBody;
  try {
    // Explicit assertion, not validation: this fixture is only as strict
    // about its own input as the check it's built to support requires -
    // a genuinely malformed body here just becomes a JSON-RPC -32700
    // below via checkProtocolVersion et al. having nothing sensible to
    // read, not a crash.
    body = JSON.parse(await readBody(req)) as RpcRequestBody;
  } catch {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: request body was not valid JSON" },
    });
    return;
  }

  const id = body.id ?? null;

  if (breakMode !== "skip-header-validation") {
    const mcpMethod = headerValue(req, "Mcp-Method");
    if (mcpMethod !== body.method) {
      writeHeaderMismatch(
        res,
        id,
        `Mcp-Method header ('${mcpMethod ?? "(missing)"}') does not match the request body's method ('${body.method ?? "(missing)"}')`,
      );
      return;
    }

    const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
    const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
    const headerVersion = headerValue(req, "MCP-Protocol-Version");
    if (headerVersion !== bodyVersion) {
      writeHeaderMismatch(
        res,
        id,
        `MCP-Protocol-Version header ('${headerVersion ?? "(missing)"}') does not match the request body's _meta protocol version (${JSON.stringify(bodyVersion ?? null)})`,
      );
      return;
    }

    const wantedName = expectedMcpName(body.method, body.params);
    if (wantedName !== undefined) {
      const mcpName = headerValue(req, "Mcp-Name");
      if (mcpName !== wantedName) {
        writeHeaderMismatch(
          res,
          id,
          `Mcp-Name header ('${mcpName ?? "(missing)"}') does not match the expected value ('${wantedName}')`,
        );
        return;
      }
    }
  }

  if (id === null) {
    // A notification: no response body expected, but still a real HTTP
    // response per the transport spec (202 Accepted, empty body).
    res.writeHead(202).end();
    return;
  }

  const { result, error } = await dispatch(breakMode, body.method, body.params);
  if (error) {
    writeJson(res, 200, { jsonrpc: "2.0", id, error });
  } else {
    writeJson(res, 200, { jsonrpc: "2.0", id, result });
  }
}

// Runnable directly (`node dist/httpServer.js`), for manual use and for the
// CLI to point at - as opposed to createStatelessHttpServer() above, which
// tests import directly to get an in-process server on a dynamic port.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  createStatelessHttpServer().listen(port, () => {
    console.error(`crucible-fixture-stateless (HTTP) listening on http://localhost:${port}/`);
  });
}
