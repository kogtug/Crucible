import type { RawJsonRpcClient } from "@crucible/core";
import { runEngine } from "@crucible/core";
import type { ChaosResult, ChaosScenario } from "./types.js";
import { malformedJsonResilience } from "./scenarios/malformedJson.js";
import { unknownMethodResilience } from "./scenarios/unknownMethod.js";

export const defaultScenarios: ChaosScenario[] = [malformedJsonResilience, unknownMethodResilience];

/**
 * Runs each scenario in sequence against the same connection, via the same
 * shared `runEngine` loop `@crucible/conformance`'s two engines use (see
 * `@crucible/core`'s runEngine). Sequence matters here in a way it doesn't
 * for conformance checks: scenarios are not independent, so if one crashes
 * the process, every scenario after it will correctly observe "crashed"
 * too (the connection doesn't magically heal between scenarios) rather
 * than throwing and aborting the whole run. That cascading behavior is
 * itself useful information, not a bug to hide - a report where scenario 1
 * crashed the server and scenario 2 reports "crashed" as a result is more
 * honest than one that stops at the first crash.
 */
export async function runChaosScenarios(
  client: RawJsonRpcClient,
  scenarios: ChaosScenario[] = defaultScenarios,
): Promise<ChaosResult[]> {
  return runEngine({ client }, scenarios, (scenario, err) => ({
    id: scenario.id,
    title: scenario.title,
    verdict: "degraded",
    message: `Crucible's own scenario code threw an unexpected error - this is not a confirmed statement about the target's behavior, just that this particular check couldn't complete: ${err instanceof Error ? err.message : String(err)}`,
    specRef: scenario.specRef,
  }));
}

