import { isJsonRpcError } from "@crucible/core";
import type { ChaosScenario, ChaosContext, ChaosResult } from "../types.js";
import { classifyResilience } from "../liveness.js";

export const malformedJsonResilience: ChaosScenario = {
  id: "malformed-json-resilience",
  title: "Handles a syntactically invalid JSON-RPC message without crashing or hanging",
  specRef:
    "JSON-RPC 2.0 spec, Section 5 (\"the Server MUST reply... except Notifications\") and the worked parse-error example in Section 7. NOT an MCP-specific requirement - see FINDINGS.md for why the MCP stdio transport's 'MUST NOT write invalid output' line doesn't apply here, and for the confidence level behind this check.",

  async run({ client }: ChaosContext): Promise<ChaosResult> {
    client.writeRawLine('{"jsonrpc": "2.0", "id": 1, method: tools/list, this is not valid json}');
    const response = await client.waitForNextRawResponse(3000);

    const immediateResponseAcceptable =
      response !== null && isJsonRpcError(response) && response.error.code === -32700;

    const detail = !client.isAlive()
      ? "Sent one syntactically invalid line."
      : response === null
        ? "Sent one syntactically invalid line; got no response at all (JSON-RPC 2.0 convention calls for a -32700 error here - see FINDINGS.md for the full spec analysis behind that expectation)."
        : immediateResponseAcceptable
          ? "Correctly responded with a -32700 parse error, matching JSON-RPC 2.0's own worked example for this case."
          : `Responded, but not with a -32700 parse error: ${JSON.stringify(response)}`;

    const { verdict, message } = await classifyResilience(client, {
      immediateResponseAcceptable,
      detail,
    });
    return { id: this.id, title: this.title, verdict, message, specRef: this.specRef };
  },
};
