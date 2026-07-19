import { isJsonRpcError } from "@crucible/core";
import type { ChaosScenario, ChaosContext, ChaosResult } from "../types.js";
import { classifyResilience } from "../liveness.js";

const UNKNOWN_METHOD_NAME = "crucible/this-method-does-not-exist";

export const unknownMethodResilience: ChaosScenario = {
  id: "unknown-method-resilience",
  title: "Rejects an unrecognized method cleanly instead of hanging or crashing",
  specRef: "JSON-RPC 2.0: Method not found (-32601)",

  async run({ client }: ChaosContext): Promise<ChaosResult> {
    let response;
    try {
      response = await client.request(UNKNOWN_METHOD_NAME, { timeoutMs: 3000 });
    } catch {
      response = null; // timed out
    }

    const immediateResponseAcceptable =
      response !== null && isJsonRpcError(response) && response.error.code === -32601;

    const detail =
      response === null
        ? `Called an unrecognized method ('${UNKNOWN_METHOD_NAME}') and got no response within the timeout.`
        : immediateResponseAcceptable
          ? "Correctly responded with a -32601 method-not-found error."
          : `Responded, but not with -32601: ${JSON.stringify(response)}`;

    const { verdict, message } = await classifyResilience(client, {
      immediateResponseAcceptable,
      detail,
    });
    return { id: this.id, title: this.title, verdict, message, specRef: this.specRef };
  },
};
