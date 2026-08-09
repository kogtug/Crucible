import type { McpHarness, Runnable } from "@cruciblemcp/core";

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  /** Stable machine-readable id, e.g. "handshake-conformance". */
  id: string;
  /** Short human-readable title. */
  title: string;
  status: CheckStatus;
  /** Explanation of what was found, written for a developer reading a CI log. */
  message: string;
  /** Pointer into the MCP spec this check is derived from. */
  specRef?: string;
}

/** Runs against an already-connected harness and returns a single result. */
export type Check = Runnable<McpHarness, CheckResult>;
