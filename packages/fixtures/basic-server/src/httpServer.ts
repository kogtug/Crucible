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
import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pathToFileURL } from "node:url";
import { createEchoServer } from "./createEchoServer.js";

/** Exported so tests can start this in-process on an OS-assigned port (`.listen(0)`) instead of spawning a child process. */
export function createEchoHttpServer(): Server {
  return createServer(async (req, res) => {
    const server = createEchoServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}

// Runnable directly (`node dist/httpServer.js`), mirroring
// stateless-server/httpServer.ts's same pattern.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8081);
  createEchoHttpServer().listen(port, () => {
    console.error(`crucible-fixture-basic (HTTP) listening on http://localhost:${port}/`);
  });
}
