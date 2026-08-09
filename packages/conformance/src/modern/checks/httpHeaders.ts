import { isJsonRpcError } from "@cruciblemcp/core";
import type { ModernCheck, ModernCheckContext } from "../types.js";
import type { CheckResult } from "../../types.js";

/** Reserved for the MCP specification per the draft's error code allocation policy. Assigned to HeaderMismatchError. */
const HEADER_MISMATCH = -32020;

/**
 * HTTP-only: the draft spec requires every POST to carry an `Mcp-Method`
 * header mirroring the JSON-RPC body's `method` field, and a server MUST
 * reject a mismatch with a -32020 HeaderMismatchError rather than silently
 * trusting the body (or the header). Deliberately sends a request with a
 * header that doesn't match its own body to prove the server actually
 * enforces this, rather than just checking that a *correct* request works
 * (which discoverConformance and statelessToolsListConformance already do,
 * incidentally, every time they succeed at all over HTTP).
 */
export const httpHeaderConformance: ModernCheck = {
  id: "http-header-conformance",
  title: "Rejects a mismatched Mcp-Method header with a HeaderMismatch error",
  specRef:
    "MCP draft spec: Streamable HTTP transport, Standard Request Headers + Server Validation (SEP-2243)",

  async run(ctx: ModernCheckContext): Promise<CheckResult> {
    if (ctx.client.getTarget().kind !== "http") {
      return {
        id: this.id,
        title: this.title,
        status: "warn",
        message:
          "Target is not an HTTP endpoint - this check only applies to the Streamable HTTP transport.",
        specRef: this.specRef,
      };
    }

    const response = await ctx.client.request("tools/list", {
      meta: { "io.modelcontextprotocol/protocolVersion": ctx.negotiatedVersion },
      headerOverrides: { "Mcp-Method": "this/does-not-match-the-body" },
      timeoutMs: 5000,
    });

    const gotHeaderMismatch = isJsonRpcError(response) && response.error.code === HEADER_MISMATCH;

    if (!gotHeaderMismatch) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Sent 'tools/list' with an Mcp-Method header that didn't match the body, expecting a -32020 HeaderMismatch error back. Got instead: ${JSON.stringify(response)}`,
        specRef: this.specRef,
      };
    }

    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message:
        "Correctly rejected a mismatched Mcp-Method header with a -32020 HeaderMismatch error.",
      specRef: this.specRef,
    };
  },
};
