#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * The simplest possible well-behaved MCP server: one tool, one capability,
 * no surprises. Crucible uses this as its first fixture so that Phase 1's
 * checks have a known-good target to validate against. Deliberately broken
 * targets, for proving a check also catches a real violation, live on the
 * *other* fixture (`../stateless-server`) as `CRUCIBLE_BREAK` modes rather
 * than as separate fixture packages - see that file's own doc comment.
 */
const server = new McpServer({
  name: "crucible-fixture-basic",
  version: "0.1.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo",
    description:
      "Returns the given message unchanged. Used as Crucible's minimal conformance fixture.",
    inputSchema: {
      message: z.string().describe("Text to echo back"),
    },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
