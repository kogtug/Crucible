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
  private readonly pending = new Map<
    string | number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();

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

    this.child.once("exit", (code) => {
      const err = new Error(`Target process exited unexpectedly (code ${code}) with pending requests`);
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
        // stdout that isn't a valid MCP message. A malformed line here is
        // itself a conformance problem, not something for us to swallow -
        // but Phase 2's checks don't yet assert on it directly, so we just
        // drop it rather than crash the whole scan. Revisit in the chaos
        // engine (Phase 3), which cares specifically about this kind of
        // malformed-output resilience.
        continue;
      }

      const waiter = parsed.id !== null && parsed.id !== undefined ? this.pending.get(parsed.id) : undefined;
      if (waiter) {
        this.pending.delete(parsed.id as string | number);
        waiter.resolve(parsed);
      }
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

  async close(): Promise<void> {
    if (!this.child) return;
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
