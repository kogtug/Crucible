import { isJsonRpcError } from "@crucible/core";
import type { ModernCheck, ModernCheckContext } from "../types.js";
import { validateCacheableResult } from "../cacheableResult.js";
import type { CheckResult } from "../../types.js";

export const statelessToolsListConformance: ModernCheck = {
  id: "stateless-tools-list-conformance",
  title: "tools/list works statelessly and returns a cacheable result",
  specRef: "MCP draft spec: stateless core (SEP-2567), CacheableResult (SEP-2549)",

  async run(ctx: ModernCheckContext): Promise<CheckResult> {
    // Deliberately a *fresh* request carrying only per-request _meta - no
    // initialize ever happened on this connection. That's the entire point
    // of "stateless": this call has to succeed on its own.
    const response = await ctx.client.request("tools/list", {
      meta: { "io.modelcontextprotocol/protocolVersion": ctx.negotiatedVersion },
      timeoutMs: 5000,
    });

    if (isJsonRpcError(response)) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `tools/list returned a JSON-RPC error even though server/discover confirmed support for ${ctx.negotiatedVersion}: ${response.error.message} (code ${response.error.code}).`,
        specRef: this.specRef,
      };
    }

    const problems = validateCacheableResult(response.result);
    if (!Array.isArray(response.result.tools)) {
      problems.push("'tools' is missing or not an array");
    }

    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Found ${problems.length} problem(s): ${problems.join("; ")}.`,
        specRef: this.specRef,
      };
    }

    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message: `tools/list returned ${(response.result.tools as unknown[]).length} tool(s) with a valid resultType/ttlMs/cacheScope, using only per-request _meta.`,
      specRef: this.specRef,
    };
  },
};
