import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Returns a brand new McpServer with the same tool registered every time.
 * A factory rather than a shared singleton because the HTTP entry point
 * (httpServer.ts) needs a fresh server+transport pair per request in
 * stateless mode - there's no session to keep one alive across requests,
 * unlike the stdio entry point (index.ts), which connects one instance
 * once and keeps it for the life of the process.
 */
export function createEchoServer(): McpServer {
  const server = new McpServer({
    name: "crucible-fixture-basic",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the given message unchanged. Used as Crucible's minimal conformance fixture.",
      inputSchema: {
        message: z.string().describe("Text to echo back"),
      },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    }),
  );

  return server;
}
