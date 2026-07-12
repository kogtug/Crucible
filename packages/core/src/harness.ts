import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Target } from "./target.js";

export interface HarnessOptions {
  /** How this harness identifies itself to the target server during the initialize handshake. */
  clientInfo?: Implementation;
  /** Milliseconds to wait for the target process to respond before giving up. */
  timeoutMs?: number;
}

function buildTransport(target: Target): Transport {
  if (target.kind === "stdio") {
    return new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: target.env,
    });
  }
  return new StreamableHTTPClientTransport(new URL(target.url));
}

/**
 * A thin, well-typed wrapper around the official MCP client SDK.
 *
 * Every conformance check receives an already-connected McpHarness instance
 * rather than talking to the transport directly. That indirection is what
 * lets the same check run unmodified against either transport `Target`
 * describes - the SDK's Client class already speaks both stdio and
 * Streamable HTTP identically from the caller's side; this class just picks
 * which underlying Transport to hand it.
 */
export class McpHarness {
  private readonly client: Client;
  private readonly transport: Transport;
  private connected = false;

  constructor(target: Target, options: HarnessOptions = {}) {
    this.transport = buildTransport(target);
    this.client = new Client(
      options.clientInfo ?? { name: "crucible-harness", version: "0.1.0" },
    );
  }

  /** Connects to the target (spawning it, for stdio) and performs the MCP initialize handshake. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Closes the connection (and terminates the spawned child process, for stdio). */
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

