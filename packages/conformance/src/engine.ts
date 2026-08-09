import type { McpHarness } from "@cruciblemcp/core";
import { runEngine } from "@cruciblemcp/core";
import type { Check, CheckResult } from "./types.js";
import { handshakeConformance } from "./checks/handshake.js";
import { toolsListSchema } from "./checks/toolsList.js";

/** The full set of checks Phase 1 ships with. Later phases append to this list. */
export const defaultChecks: Check[] = [handshakeConformance, toolsListSchema];

/**
 * Runs every check against an already-connected harness. A single check
 * throwing is treated as a failure of that check, not a crash of the whole
 * scan - one misbehaving server should never take down the report for the
 * checks that did run cleanly. See @cruciblemcp/core's runEngine for the
 * shared loop this and the modern engine both build on.
 */
export async function runChecks(
  harness: McpHarness,
  checks: Check[] = defaultChecks,
): Promise<CheckResult[]> {
  return runEngine(harness, checks, (check, err) => ({
    id: check.id,
    title: check.title,
    status: "fail",
    message: `Check threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    specRef: check.specRef,
  }));
}
