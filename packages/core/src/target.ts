/**
 * Describes an MCP server to connect to - either a local process to spawn
 * and speak stdio with, or an already-running HTTP endpoint to POST to.
 *
 * This replaces what used to be a single stdio-only `TargetServerCommand`
 * shape once both {@link McpHarness} and {@link RawJsonRpcClient} needed to
 * support a second transport. The two variants are deliberately kept
 * separate fields on a discriminated union rather than one shape with
 * optional fields for both: a target is either a command or a URL, never
 * partially either, and the type should say so.
 */
export interface StdioTarget {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpTarget {
  kind: "http";
  /** The full MCP endpoint URL, e.g. "http://localhost:8080/mcp". */
  url: string;
}

export type Target = StdioTarget | HttpTarget;
