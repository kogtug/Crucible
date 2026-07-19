/**
 * The Streamable HTTP entry point for the basic (legacy, SDK-based)
 * fixture - same echo tool as index.ts (stdio), via the shared
 * createEchoServer.ts, bound to the official SDK's
 * StreamableHTTPServerTransport instead of StdioServerTransport.
 *
 * Stateless mode (`sessionIdGenerator: undefined`), with a fresh
 * McpServer + transport pair per request: there's no session to keep
 * alive across requests in stateless mode, so reusing one pair across
 * requests would just be extra shared state with nothing to justify it.
 *
 * This fixture is deliberately "classic" - the stable (non-draft) protocol
 * still uses the `initialize` handshake, and its Streamable HTTP transport
 * has none of the new `Mcp-Method`/`MCP-Protocol-Version` header
 * requirements (those are draft-only, SEP-2243) - so unlike
 * stateless-server's HTTP entry, this one needs no custom header
 * validation. It exists to prove McpHarness's HTTP path works against a
 * real Streamable HTTP server, using the same SDK a real server author
 * would.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pathToFileURL } from "node:url";
import { createEchoServer } from "./createEchoServer.js";

/** Exported so tests can start this in-process on an OS-assigned port (`.listen(0)`) instead of spawning a child process. */
export function createEchoHttpServer(): Server {
  // node:http's request-handler type is (req, res) => void - it never
  // awaits whatever the callback returns, so an async function passed
  // directly here would leave its own rejections unhandled. Keeping the
  // callback itself synchronous and explicitly handling the promise (with
  // a real fallback response) means a failure here is a 500, not a
  // silently hung connection.
  return createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
          },
        }),
      );
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createEchoServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// Runnable directly (`node dist/httpServer.js`), mirroring
// stateless-server/httpServer.ts's same pattern.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8081);
  createEchoHttpServer().listen(port, () => {
    console.error(`crucible-fixture-basic (HTTP) listening on http://localhost:${port}/`);
  });
}
