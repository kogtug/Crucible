#!/usr/bin/env node
/**
 * The stdio entry point for the stateless fixture. See handlers.ts for the
 * actual request/response logic shared with httpServer.ts; this file is
 * just the stdio transport loop plus the chaos-testing break modes that
 * are specifically about *not responding* (which only make sense as a
 * concept for a persistent stream, not a one-shot HTTP POST).
 *
 * See docs/architecture.md ("Two protocol eras") for why Crucible has both
 * an SDK-mediated harness (packages/core/harness.ts) and this raw,
 * hand-written path.
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
import { dispatch, isKnownMethod } from "./handlers.js";

const BREAK_MODE = process.env.CRUCIBLE_BREAK ?? "";

interface IncomingMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
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

    if (!isKnownMethod(message.method)) {
      if (BREAK_MODE === "freeze-on-unknown-method") {
        // Deliberately block the entire event loop forever: unlike
        // "hang-on-unknown-method" below, this makes the process stop
        // responding to *everything*, not just this one request - a
        // genuine total-freeze, for testing that distinction.
        while (true) {
          /* busy-wait forever, on purpose */
        }
      }
      if (BREAK_MODE === "hang-on-unknown-method") {
        continue; // Deliberately never respond to *this* request, but keep processing everything else.
      }
    }

    const { result, error } = dispatch(BREAK_MODE, message.method, message.params);
    if (error) {
      writeError(message.id, error.code, error.message, error.data);
    } else {
      writeResult(message.id, result!);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
