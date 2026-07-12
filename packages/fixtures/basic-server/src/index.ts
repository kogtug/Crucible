#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEchoServer } from "./createEchoServer.js";

/**
 * The simplest possible well-behaved MCP server: one tool, one capability,
 * no surprises. Crucible uses this as its first fixture so that Phase 1's
 * checks have a known-good target to validate against. Deliberately broken
 * targets, for proving a check also catches a real violation, live on the
 * *other* fixture (`../stateless-server`) as `CRUCIBLE_BREAK` modes rather
 * than as separate fixture packages - see that file's own doc comment.
 *
 * The server definition itself lives in createEchoServer.ts, shared with
 * httpServer.ts, so the two transports can't drift into answering
 * differently.
 */
const server = createEchoServer();
const transport = new StdioServerTransport();
await server.connect(transport);
