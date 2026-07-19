import type { ModernCheck, ModernCheckContext } from "../types.js";
import { validateCacheableResult } from "../cacheableResult.js";
import type { CheckResult } from "../../types.js";

export const discoverConformance: ModernCheck = {
  id: "discover-conformance",
  title: "server/discover returns a schema-valid, cacheable DiscoverResult",
  specRef: "MCP draft spec: server/discover (SEP-2575), CacheableResult (SEP-2549)",

  async run(ctx: ModernCheckContext): Promise<CheckResult> {
    const result = ctx.discoverResult;
    const problems = validateCacheableResult(result);

    if (!Array.isArray(result.supportedVersions) || result.supportedVersions.length === 0) {
      problems.push(
        "supportedVersions is missing or empty - clients have nothing to negotiate against",
      );
    }
    if (typeof result.capabilities !== "object" || result.capabilities === null) {
      problems.push("capabilities is missing or not an object");
    }
    const serverInfo = result.serverInfo as { name?: unknown; version?: unknown } | undefined;
    if (
      !serverInfo ||
      typeof serverInfo.name !== "string" ||
      typeof serverInfo.version !== "string"
    ) {
      problems.push("serverInfo is missing a string name/version");
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
      message: `server/discover reports support for ${(result.supportedVersions as string[]).join(", ")}, with a valid resultType/ttlMs/cacheScope.`,
      specRef: this.specRef,
    };
  },
};
