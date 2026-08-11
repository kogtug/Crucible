import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  /** Extra `_meta` entries to attach to `params._meta`. */
  meta?: Record<string, unknown>;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * HTTP targets only, ignored for stdio: overrides specific request
   * headers after they're otherwise computed correctly.
   */
  headerOverrides?: Record<string, string>;
  /**
   * HTTP targets only, ignored for stdio: sets the `Mcp-Name` header.
   */
  mcpName?: string;
}

/**
 * A deliberately low-level MCP client: it speaks JSON-RPC 2.0 directly, over
 * either stdio or Streamable HTTP, with no `initialize` handshake and no
 * schema validation.
 */
export class RawJsonRpcClient {
  private nextId = 1;

  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  private readonly pending = new Map<
    string | number,
    {
      resolve: (r: JsonRpcResponse) => void;
      reject: (e: Error) => void;
    }
  >();

  private readonly unmatchedWaiters: ((r: JsonRpcResponse) => void)[] = [];

  constructor(private readonly target: Target) {}

  getTarget(): Target {
    return this.target;
  }

  async connect(): Promise<void> {
    if (this.target.kind === "http") {
      return;
    }

    const stdioTarget = this.target;

    this.child = spawn(stdioTarget.command, stdioTarget.args ?? [], {
      env: { ...process.env, ...stdioTarget.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.onStdoutData(chunk);
    });

    this.child.once("error", (err) => {
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };

      const err = new Error(
        `Target process exited unexpectedly (code ${code}, signal ${signal}) with pending requests`,
      );

      for (const { reject } of this.pending.values()) {
        reject(err);
      }

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
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      const waiter =
        parsed.id !== null && parsed.id !== undefined ? this.pending.get(parsed.id) : undefined;

      if (waiter) {
        this.pending.delete(parsed.id!);
        waiter.resolve(parsed);
        continue;
      }

      const unmatchedWaiter = this.unmatchedWaiters.shift();

      if (unmatchedWaiter) {
        unmatchedWaiter(parsed);
      }
    }
  }

  private buildMessage(method: string, options: RawRequestOptions): JsonRpcRequestMessage {
    const id = this.nextId++;
    const params: Record<string, unknown> = {
      ...(options.params ?? {}),
    };

    if (options.meta) {
      params._meta = {
        ...(params._meta as Record<string, unknown> | undefined),
        ...options.meta,
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
  }

  async request(method: string, options: RawRequestOptions = {}): Promise<JsonRpcResponse> {
    if (this.target.kind === "http") {
      return this.requestHttp(this.target, method, options);
    }

    return this.requestStdio(method, options);
  }

  private async requestStdio(method: string, options: RawRequestOptions): Promise<JsonRpcResponse> {
    if (!this.child) {
      throw new Error("RawJsonRpcClient.connect() must be called before request()");
    }

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

  private async requestHttp(
    target: HttpTarget,
    method: string,
    options: RawRequestOptions,
  ): Promise<JsonRpcResponse> {
    const message = this.buildMessage(method, options);
    const timeoutMs = options.timeoutMs ?? 5000;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": method,
    };

    if (options.mcpName !== undefined) {
      headers["Mcp-Name"] = options.mcpName;
    }

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
        throw new Error(`Timed out after ${timeoutMs}ms waiting for a response to '${method}'`, {
          cause: err,
        });
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

  writeRawLine(line: string): void {
    if (this.target.kind === "http") {
      throw new Error(
        "writeRawLine() is stdio-only; chaos testing over HTTP isn't implemented yet.",
      );
    }

    if (!this.child) {
      throw new Error("RawJsonRpcClient.connect() must be called before writeRawLine()");
    }

    this.child.stdin.write(line + "\n");
  }

  async waitForNextRawResponse(timeoutMs = 3000): Promise<JsonRpcResponse | null> {
    if (this.target.kind === "http") {
      throw new Error(
        "waitForNextRawResponse() is stdio-only; chaos testing over HTTP isn't implemented yet.",
      );
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs);

      this.unmatchedWaiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  isAlive(): boolean {
    if (this.target.kind === "http") {
      return true;
    }

    return this.child !== undefined && this.exitInfo === undefined;
  }

  getExitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exitInfo;
  }

  async close(): Promise<void> {
    if (this.target.kind === "http") {
      return;
    }

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = undefined;

    if (this.exitInfo) {
      return;
    }

    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed by a crashed target.
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;

        settled = true;
        clearTimeout(forceKill);
        resolve();
      };

      const forceKill = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {
            finish();
          });
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already be gone.
          }

          finish();
        }
      }, 500);

      child.once("exit", finish);

      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {
          finish();
        });
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      }
    });
  }
}
