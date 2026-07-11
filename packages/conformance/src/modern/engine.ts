import type { RawJsonRpcClient } from "@crucible/core";
import { runEngine } from "@crucible/core";
import type { CheckResult } from "../types.js";
import type { ModernCheck } from "./types.js";
import { discoverConformance } from "./checks/discover.js";
import { statelessToolsListConformance } from "./checks/toolsList.js";

export const defaultModernChecks: ModernCheck[] = [discoverConformance, statelessToolsListConformance];

/**
 * Builds the modern check context and runs it through the same shared
 * `runEngine` loop the legacy engine (`../engine.js`) and the chaos engine
 * (`@crucible/chaos`) use. The context construction and the Result shape
 * on a thrown error are the only things specific to this engine; a
 * separate function from the legacy one still earns its keep for that
 * reason - see docs/architecture.md, "Two protocol eras" - but the loop
 * itself no longer needs to be copied to get that.
 */
export async function runModernChecks(
  client: RawJsonRpcClient,
  discoverResult: Record<string, unknown>,
  negotiatedVersion: string,
  checks: ModernCheck[] = defaultModernChecks,
): Promise<CheckResult[]> {
  const ctx = { client, negotiatedVersion, discoverResult };
  return runEngine(ctx, checks, (check, err) => ({
    id: check.id,
    title: check.title,
    status: "fail",
    message: `Check threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    specRef: check.specRef,
  }));
}

