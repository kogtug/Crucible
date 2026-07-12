import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Target, HttpTarget } from "./target.js";

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function isJsonRpcError(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return "error" in response;
}

export interface RawRequestOptions {
  /** Extra `_meta` entries to attach to `params._meta` (e.g. the new spec's
   * `io.modelcontextprotocol/protocolVersion` family of keys). */
  meta?: Record<string, unknown>;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * HTTP targets only, ignored for stdio: overrides specific request
   * headers after they're otherwise computed correctly. This exists for
   * one purpose - deliberately sending a *mismatched* `Mcp-Method` (or
   * similar) to prove a server's header-validation conformance check
   * actually catches a violation, the same true-positive/true-negative
   * discipline every other check in this repo follows. It is not a general
   * chaos-testing facility; see @crucible/chaos and "Deferred, on purpose"
   * in docs/architecture.md for why HTTP chaos testing is a separate,
   * not-yet-built thing.
   */
  headerOverrides?: Record<string, string>;
}

/**
 * A deliberately low-level MCP client: it speaks JSON-RPC 2.0 directly, over
 * either stdio or Streamable HTTP, with no `initialize` handshake and no
 * schema validation - see docs/architecture.md, "Two protocol eras", for
 * why this exists alongside {@link McpHarness}.
 *
 * HTTP support is deliberately partial: `request()` works fully (that's
 * what every conformance check needs), but the chaos-testing primitives
 * (`writeRawLine`, `waitForNextRawResponse`, `isAlive`) remain stdio-only
 * and throw a clear error otherwise - chaos-over-HTTP has transport-specific
 * questions (what does "malformed input" even mean for a single self
 * -contained POST versus a persistent stream?) that deserve their own pass
 * rather than a same-day retrofit. See "Deferred, on purpose".
 */
export class RawJsonRpcClient {
  private nextId = 1;

  // stdio-only state
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly pending = new Map<
    string | number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private readonly unmatchedWaiters: Array<(r: JsonRpcResponse) => void> = [];

  constructor(private readonly target: Target) {}

  /** The target this client was constructed with - lets callers (like modern checks) branch on transport kind. */
  getTarget(): Target {
    return this.target;
  }

  async connect(): Promise<void> {
    if (this.target.kind === "http") {
      // Streamable HTTP has no persistent connection to establish up front -
      // every request is its own independent POST. Nothing to do here.
      return;
    }

    const stdioTarget = this.target;
    this.child = spawn(stdioTarget.command, stdioTarget.args ?? [], {
      env: { ...process.env, ...stdioTarget.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdoutData(chunk));

    this.child.once("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const err = new Error(`Target process exited unexpectedly (code ${code}, signal ${signal}) with pending requests`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Per the stdio transport spec, a server MUST NOT write anything to
        // stdout that isn't a valid MCP message - so strictly, seeing this
        // at all means the target already violated that. This is the same
        // code path (and the same underlying gap) as upstream issue
        // modelcontextprotocol/typescript-sdk#244: a client's deserializer
        // has no graceful handling for a malformed line, here or there.
        // @crucible/chaos's malformed-JSON scenario deliberately exercises
        // the *other* direction - a server's resilience to malformed input
        // from a client, via writeRawLine() below - not this one. Testing
        // Crucible's own resilience to a malformed *server* is a real gap,
        // not yet covered by any phase; dropping the line here rather than
        // crashing the whole scan is a deliberate stopgap, not a fix.
        continue;
      }

      const waiter = parsed.id !== null && parsed.id !== undefined ? this.pending.get(parsed.id) : undefined;
      if (waiter) {
        this.pending.delete(parsed.id as string | number);
        waiter.resolve(parsed);
        continue;
      }

      const unmatchedWaiter = this.unmatchedWaiters.shift();
      if (unmatchedWaiter) unmatchedWaiter(parsed);
      // Else: a response nothing is currently waiting for. Most commonly
      // this is a stray or duplicate message; there's no pending caller to
      // hand it to, so there's nothing useful to do but drop it.
    }
  }

  private buildMessage(method: string, options: RawRequestOptions): JsonRpcRequestMessage {
    const id = this.nextId++;
    const params: Record<string, unknown> = { ...(options.params ?? {}) };
    if (options.meta) {
      params._meta = { ...(params._meta as Record<string, unknown> | undefined), ...options.meta };
    }
    return { jsonrpc: "2.0", id, method, params };
  }

  /** Sends a single JSON-RPC request and resolves with the raw response (success or error), unparsed against any schema. */
  async request(method: string, options: RawRequestOptions = {}): Promise<JsonRpcResponse> {
    if (this.target.kind === "http") {
      return this.requestHttp(this.target, method, options);
    }
    return this.requestStdio(method, options);
  }

  private async requestStdio(method: string, options: RawRequestOptions): Promise<JsonRpcResponse> {
    if (!this.child) throw new Error("RawJsonRpcClient.connect() must be called before request()");

    const message = this.buildMessage(method, options);
    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a response to '${method}'`));
      }, timeoutMs);

      this.pending.set(message.id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.child!.stdin.write(JSON.stringify(message) + "\n");
    });
  }

  /**
   * POSTs one JSON-RPC message per the draft Streamable HTTP transport:
   * `Content-Type: application/json`, an `Accept` header listing both JSON
   * and SSE (even though this client only ever handles a JSON response -
   * Crucible's fixtures never need to stream one), and the two header/body
   * pairs the new spec requires (`Mcp-Method` mirrors `method`;
   * `MCP-Protocol-Version` mirrors the `_meta` protocol version, when one
   * was given). The response body is read as plain JSON regardless of HTTP
   * status: per spec, even a 400 (HeaderMismatch, UnsupportedProtocolVersion)
   * carries a JSON-RPC error body, not just a bare status code.
   */
  private async requestHttp(target: HttpTarget, method: string, options: RawRequestOptions): Promise<JsonRpcResponse> {
    const message = this.buildMessage(method, options);
    const timeoutMs = options.timeoutMs ?? 5000;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": method,
    };
    const protocolVersion = options.meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof protocolVersion === "string") {
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    Object.assign(headers, options.headerOverrides);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for a response to '${method}'`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `Expected a 'application/json' response from the MCP endpoint but got '${contentType || "(none)"}' (status ${response.status})`,
      );
    }

    return (await response.json()) as JsonRpcResponse;
  }

  /**
   * Writes an arbitrary line directly to the target's stdin, bypassing
   * request()'s well-formed-message construction entirely. This exists for
   * the chaos engine (packages/chaos), which needs to send input that is
   * NOT valid JSON-RPC on purpose - request() can't do that by design.
   * Stdio only - see the class doc comment.
   */
  writeRawLine(line: string): void {
    if (this.target.kind === "http") {
      throw new Error("writeRawLine() is stdio-only; chaos testing over HTTP isn't implemented yet.");
    }
    if (!this.child) throw new Error("RawJsonRpcClient.connect() must be called before writeRawLine()");
    this.child.stdin.write(line + "\n");
  }

  /**
   * Resolves with the next response that doesn't match any pending
   * request().  Needed for reading the reaction to writeRawLine(): a
   * well-formed parse-error response carries `id: null` per JSON-RPC 2.0,
   * so it can never be correlated to a specific outgoing request the way
   * request()'s own responses are. Resolves to null if nothing arrives
   * within the timeout. Stdio only - see the class doc comment.
   */
  async waitForNextRawResponse(timeoutMs = 3000): Promise<JsonRpcResponse | null> {
    if (this.target.kind === "http") {
      throw new Error("waitForNextRawResponse() is stdio-only; chaos testing over HTTP isn't implemented yet.");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.unmatchedWaiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  /**
   * True if the target is still usable: for stdio, the process hasn't
   * exited or been killed. For HTTP, there's no persistent connection to
   * hold open in the first place - each request is independent - so this
   * always reports true. That makes it meaningless as a liveness signal
   * for HTTP targets, which is exactly why the chaos engine (the only
   * caller that relies on it) doesn't support HTTP yet.
   */
  isAlive(): boolean {
    if (this.target.kind === "http") return true;
    return this.child !== undefined && this.exitInfo === undefined;
  }

  /** Populated once a stdio process has exited; always undefined for HTTP targets. */
  getExitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exitInfo;
  }

  async close(): Promise<void> {
    if (this.target.kind === "http") return; // no persistent connection to tear down
    if (!this.child) return;
    if (this.exitInfo) {
      // Already exited (e.g. a chaos scenario crashed it) - nothing to wait for.
      this.child = undefined;
      return;
    }
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const child = this.child!;
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = undefined;
  }
}

