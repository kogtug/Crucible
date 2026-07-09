import type { RawJsonRpcClient } from "@crucible/core";
import type { CheckResult } from "../types.js";
import type { ModernCheck } from "./types.js";
import { discoverConformance } from "./checks/discover.js";
import { statelessToolsListConformance } from "./checks/toolsList.js";

export const defaultModernChecks: ModernCheck[] = [discoverConformance, statelessToolsListConformance];

/**
 * Mirrors {@link ../engine.js}'s runChecks, for the modern check family.
 * A separate function (rather than a generic shared with the legacy engine)
 * because the two families run against fundamentally different connection
 * types - see docs/architecture.md, "Two protocol eras" - and forcing them
 * through one generic today would mean designing that abstraction before
 * there are two real, working call sites to design it from.
 */
export async function runModernChecks(
  client: RawJsonRpcClient,
  discoverResult: Record<string, unknown>,
  negotiatedVersion: string,
  checks: ModernCheck[] = defaultModernChecks,
): Promise<CheckResult[]> {
  const ctx = { client, negotiatedVersion, discoverResult };
  const results: CheckResult[] = [];

  for (const check of checks) {
    try {
      results.push(await check.run(ctx));
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        status: "fail",
        message: `Check threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        specRef: check.specRef,
      });
    }
  }

  return results;
}
