import type { RawJsonRpcClient } from "@crucible/core";
import type { ResilienceVerdict } from "./types.js";

/**
 * Sends a harmless server/discover request and reports whether ANY
 * response comes back - success or a JSON-RPC error both count, since both
 * prove the target is still reading stdin and writing well-formed replies.
 * Only a timeout (or the process being dead) counts as unresponsive.
 *
 * server/discover specifically (rather than tools/list or anything else)
 * because it's the one method every era of server in this repo answers
 * somehow: modern fixtures implement it directly, and legacy/SDK-based
 * ones at least return a clean error for it - either way, a real response
 * proves the process is alive and parsing input correctly.
 */
export async function probeLiveness(client: RawJsonRpcClient, timeoutMs = 3000): Promise<boolean> {
  if (!client.isAlive()) return false;
  try {
    await client.request("server/discover", { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export interface FaultOutcome {
  /** Whether the target's immediate reaction to the fault was the spec-correct one. */
  immediateResponseAcceptable: boolean;
  /** Human-readable detail about what was actually observed, folded into the final message. */
  detail: string;
}

/**
 * Every scenario in this package ends by calling this: it checks whether
 * the process is still alive, then whether it's still responsive, and
 * combines that with whatever the scenario itself observed about the
 * immediate reaction to produce one of the four verdicts in types.ts.
 * Centralizing this means every scenario's notion of "resilient" is
 * consistent, rather than each one inventing its own bar.
 */
export async function classifyResilience(
  client: RawJsonRpcClient,
  outcome: FaultOutcome,
): Promise<{ verdict: ResilienceVerdict; message: string }> {
  if (!client.isAlive()) {
    const exitInfo = client.getExitInfo();
    return {
      verdict: "crashed",
      message: `Process exited (code ${exitInfo?.code ?? "unknown"}, signal ${exitInfo?.signal ?? "none"}) as a direct result of this input. ${outcome.detail}`,
    };
  }

  const stillResponsive = await probeLiveness(client);
  if (!stillResponsive) {
    return {
      verdict: "hung",
      message: `Process is still running but did not respond to a follow-up request within the timeout. ${outcome.detail}`,
    };
  }

  if (!outcome.immediateResponseAcceptable) {
    return {
      verdict: "degraded",
      message: `Process recovered and is still responsive, but its immediate reaction to the fault wasn't spec-correct. ${outcome.detail}`,
    };
  }

  return {
    verdict: "resilient",
    message: `Handled correctly and remained responsive afterward. ${outcome.detail}`,
  };
}
