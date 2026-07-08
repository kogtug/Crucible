import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Describes how to launch the MCP server under test.
 *
 * Phase 1 only supports the stdio transport (spawning a local child process),
 * because that is enough to validate the harness architecture end-to-end.
 * Streamable HTTP support (needed to reach remote MCP servers, and required
 * for several of the new 2026-07-28 spec checks) is planned for Phase 2 -
 * see docs/architecture.md.
 */
export interface TargetServerCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HarnessOptions {
  /** How this harness identifies itself to the target server during the initialize handshake. */
  clientInfo?: Implementation;
  /** Milliseconds to wait for the target process to respond before giving up. */
  timeoutMs?: number;
}

/**
 * A thin, well-typed wrapper around the official MCP client SDK.
 *
 * Every conformance check receives an already-connected McpHarness instance
 * rather than talking to the transport directly. That indirection is what
 * lets the same check run unmodified against stdio today and Streamable HTTP
 * once Phase 2 adds that transport.
 */
export class McpHarness {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;

  constructor(target: TargetServerCommand, options: HarnessOptions = {}) {
    this.transport = new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: target.env,
    });

    this.client = new Client(
      options.clientInfo ?? { name: "crucible-harness", version: "0.1.0" },
    );
  }

  /** Spawns the target process and performs the MCP initialize handshake. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Closes the connection and terminates the spawned child process. */
  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** The capabilities the target server advertised during initialize. */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  /** The name/version the target server reported during initialize. */
  getServerVersion(): Implementation | undefined {
    return this.client.getServerVersion();
  }

  /** Raw access to the underlying SDK client, for checks that need it directly. */
  raw(): Client {
    return this.client;
  }
}
