/**
 * Shared validation for the fields the draft spec requires on results:
 * `resultType` on every {@link https://github.com/modelcontextprotocol/modelcontextprotocol Result}
 * (SEP-2322), and `ttlMs` + `cacheScope` on every `CacheableResult` - which
 * `server/discover`, `tools/list`, `resources/list`, `prompts/list`, and
 * `resources/read` all extend (SEP-2549). `discoverConformance` and
 * `statelessToolsListConformance` both call this rather than duplicating
 * the same three checks.
 */
export function validateCacheableResult(result: Record<string, unknown>): string[] {
  const problems: string[] = [];

  // resultType's own type in the schema is `"complete" | "input_required" | string`
  // - deliberately open-ended, so extensions (e.g. Tasks, which returns
  // resultType: "task") can define their own values without a core schema
  // change. Rejecting anything other than the two core-documented literals
  // would flag every extension-defined result as broken; the actual
  // requirement is just that the field is present and a real string.
  if (typeof result.resultType !== "string" || result.resultType.length === 0) {
    problems.push(
      `resultType is ${JSON.stringify(result.resultType)}, expected a non-empty string`,
    );
  }

  if (typeof result.ttlMs !== "number" || result.ttlMs < 0) {
    problems.push(`ttlMs is ${JSON.stringify(result.ttlMs)}, expected a number >= 0`);
  }

  if (result.cacheScope !== "public" && result.cacheScope !== "private") {
    problems.push(
      `cacheScope is ${JSON.stringify(result.cacheScope)}, expected "public" or "private"`,
    );
  }

  return problems;
}
