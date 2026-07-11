import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TargetServerCommand } from "./harness.js";

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
}

/**
 * A deliberately low-level MCP client: it speaks newline-delimited JSON-RPC
 * 2.0 over stdio and nothing else - no `initialize` handshake, no schema
 * validation, no assumptions about which protocol era the target speaks.
 *
 * @crucible/core's other export, {@link McpHarness}, wraps the official SDK
 * and is the right choice for anything that behaves like a "classic"
 * (initialize-based) MCP server. This class exists because the 2026-07-28
 * draft removes that handshake entirely in favor of per-request `_meta` and
 * a `server/discover` probe (see docs/architecture.md, "Two protocol eras")
 * - and the official SDK, as of 1.29.0, has no concept of that yet. Talking
 * raw JSON-RPC is the only way to exercise it today.
 */
export class RawJsonRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly pending = new Map<
    string | number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private readonly unmatchedWaiters: Array<(r: JsonRpcResponse) => void> = [];

  constructor(private readonly target: TargetServerCommand) {}

  async connect(): Promise<void> {
    this.child = spawn(this.target.command, this.target.args ?? [], {
      env: { ...process.env, ...this.target.env },
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

  /** Sends a single JSON-RPC request and resolves with the raw response (success or error), unparsed against any schema. */
  async request(method: string, options: RawRequestOptions = {}): Promise<JsonRpcResponse> {
    if (!this.child) throw new Error("RawJsonRpcClient.connect() must be called before request()");

    const id = this.nextId++;
    const params: Record<string, unknown> = { ...(options.params ?? {}) };
    if (options.meta) {
      params._meta = { ...(params._meta as Record<string, unknown> | undefined), ...options.meta };
    }

    const message: JsonRpcRequestMessage = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a response to '${method}'`));
      }, timeoutMs);

      this.pending.set(id, {
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
   * Writes an arbitrary line directly to the target's stdin, bypassing
   * request()'s well-formed-message construction entirely. This exists for
   * the chaos engine (packages/chaos), which needs to send input that is
   * NOT valid JSON-RPC on purpose - request() can't do that by design.
   */
  writeRawLine(line: string): void {
    if (!this.child) throw new Error("RawJsonRpcClient.connect() must be called before writeRawLine()");
    this.child.stdin.write(line + "\n");
  }

  /**
   * Resolves with the next response that doesn't match any pending
   * request().  Needed for reading the reaction to writeRawLine(): a
   * well-formed parse-error response carries `id: null` per JSON-RPC 2.0,
   * so it can never be correlated to a specific outgoing request the way
   * request()'s own responses are. Resolves to null if nothing arrives
   * within the timeout.
   */
  async waitForNextRawResponse(timeoutMs = 3000): Promise<JsonRpcResponse | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.unmatchedWaiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  /** True if the process is still running (hasn't exited or been killed). */
  isAlive(): boolean {
    return this.child !== undefined && this.exitInfo === undefined;
  }

  /** Populated once the process has exited; undefined while it's still running. */
  getExitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exitInfo;
  }

  async close(): Promise<void> {
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
