import type { RawJsonRpcClient, Runnable } from "@cruciblemcp/core";

/**
 * Four-tier resilience verdict, deliberately richer than pass/fail:
 *
 * - "resilient": handled the fault correctly (or safely) AND stayed
 *   responsive to a follow-up request afterward.
 * - "degraded":  still alive and responsive afterward, but the immediate
 *   reaction to the fault wasn't the expected one for that specific
 *   scenario (e.g. silently swallowing malformed input instead of
 *   returning -32700). Note that "expected" is scenario-specific, and not
 *   always backed by an unambiguous MUST in the spec text - see each
 *   scenario's own specRef, and FINDINGS.md for a case where it isn't.
 * - "hung":      the process is still alive but stopped responding to
 *   anything, including the follow-up liveness check.
 * - "crashed":   the process exited as a direct result of the fault.
 *
 * "degraded" and "hung" both matter as distinct outcomes from "crashed":
 * a client integrating against a target that goes quietly wrong is often
 * a worse day than one that fails loudly and immediately.
 */
export type ResilienceVerdict = "resilient" | "degraded" | "hung" | "crashed";

export interface ChaosResult {
  id: string;
  title: string;
  verdict: ResilienceVerdict;
  message: string;
  specRef?: string;
}

export interface ChaosContext {
  client: RawJsonRpcClient;
}

export type ChaosScenario = Runnable<ChaosContext, ChaosResult>;
