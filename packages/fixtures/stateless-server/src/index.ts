#!/usr/bin/env node
/**
 * A hand-rolled reference implementation of the draft 2026-07-28 protocol
 * era: no `initialize` handshake, `server/discover` for capability
 * discovery, and `resultType` / `ttlMs` / `cacheScope` on every result.
 *
 * This deliberately does NOT use @modelcontextprotocol/sdk: as of SDK
 * 1.29.0 it has no concept of any of the above, so there is nothing to
 * build on top of yet. See docs/architecture.md ("Two protocol eras") for
 * why Crucible has both an SDK-mediated harness (packages/core/harness.ts)
 * and this raw, hand-written path.
 *
 * Set CRUCIBLE_BREAK to one of the following to deliberately violate a
 * single rule, for regression-testing the check meant to catch exactly
 * that violation - everything else about the response stays spec-correct
 * so each check is exercised in isolation:
 *   - "missing-result-type"      omit `resultType` from every result
 *   - "bad-cache-scope"          use an invalid `cacheScope` value
 *   - "negative-ttl"             use a negative `ttlMs`
 *   - "crash-on-malformed"       exit(1) on unparseable input instead of
 *                                 ignoring it (for the chaos engine)
 *   - "hang-on-unknown-method"   never respond to an unrecognized method,
 *                                 but keep processing everything else
 *                                 normally (for the chaos engine)
 *   - "freeze-on-unknown-method" block the entire event loop forever on an
 *                                 unrecognized method, so the process stops
 *                                 responding to *everything*, not just that
 *                                 one request (for the chaos engine)
 */

const PROTOCOL_VERSION = "2026-07-28";
const BREAK_MODE = process.env.CRUCIBLE_BREAK ?? "";
const SERVER_INFO = { name: "crucible-fixture-stateless", version: "0.1.0" };

interface IncomingMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function cacheFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (BREAK_MODE !== "missing-result-type") fields.resultType = "complete";
  fields.ttlMs = BREAK_MODE === "negative-ttl" ? -1000 : 3_600_000;
  fields.cacheScope = BREAK_MODE === "bad-cache-scope" ? "shared" : "public";
  return fields;
}

function writeMessage(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function writeResult(id: string | number, result: Record<string, unknown>): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: string | number | null, code: number, message: string, data?: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function handleDiscover(id: string | number): void {
  writeResult(id, {
    ...cacheFields(),
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: "Crucible's fixture for the draft 2026-07-28 stateless/discover-based protocol era.",
  });
}

function handleToolsList(id: string | number, params: Record<string, unknown> | undefined): void {
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const requested = meta["io.modelcontextprotocol/protocolVersion"];

  if (requested !== PROTOCOL_VERSION) {
    writeError(id, -32022, "Unsupported protocol version", {
      supported: [PROTOCOL_VERSION],
      requested: requested ?? "(none provided)",
    });
    return;
  }

  writeResult(id, {
    ...cacheFields(),
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
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    let message: IncomingMessage;
    try {
      message = JSON.parse(line);
    } catch {
      if (BREAK_MODE === "crash-on-malformed") {
        process.exit(1);
      }
      // Per JSON-RPC 2.0, a parse error is reported with id: null, since a
      // request that couldn't be parsed can't reliably have its id read.
      writeError(null, -32700, "Parse error: input was not valid JSON");
      continue;
    }

    if (message.id === undefined) continue; // Notification: no response expected.

    switch (message.method) {
      case "server/discover":
        handleDiscover(message.id);
        break;
      case "tools/list":
        handleToolsList(message.id, message.params);
        break;
      default:
        if (BREAK_MODE === "freeze-on-unknown-method") {
          // Deliberately block the entire event loop forever: unlike
          // "hang-on-unknown-method" below, this makes the process stop
          // responding to *everything*, not just this one request - a
          // genuine total-freeze, for testing that distinction.
          while (true) {
            /* busy-wait forever, on purpose */
          }
        }
        if (BREAK_MODE !== "hang-on-unknown-method") {
          writeError(message.id, -32601, `Method not found: ${message.method}`);
        }
        // In "hang-on-unknown-method" mode, deliberately never respond to
        // *this* request, but keep processing everything else normally.
    }
  }
});

process.stdin.on("end", () => process.exit(0));
