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

  if (result.resultType !== "complete" && result.resultType !== "input_required") {
    problems.push(`resultType is ${JSON.stringify(result.resultType)}, expected "complete" or "input_required"`);
  }

  if (typeof result.ttlMs !== "number" || result.ttlMs < 0) {
    problems.push(`ttlMs is ${JSON.stringify(result.ttlMs)}, expected a number >= 0`);
  }

  if (result.cacheScope !== "public" && result.cacheScope !== "private") {
    problems.push(`cacheScope is ${JSON.stringify(result.cacheScope)}, expected "public" or "private"`);
  }

  return problems;
}
