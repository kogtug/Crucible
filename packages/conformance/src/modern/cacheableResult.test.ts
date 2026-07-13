import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCacheableResult } from "./cacheableResult.js";

test("accepts a fully valid CacheableResult", () => {
  const problems = validateCacheableResult({ resultType: "complete", ttlMs: 1000, cacheScope: "public" });
  assert.deepEqual(problems, []);
});

test("accepts 'input_required' as a resultType", () => {
  const problems = validateCacheableResult({ resultType: "input_required", ttlMs: 0, cacheScope: "private" });
  assert.deepEqual(problems, []);
});

test("accepts an extension-defined resultType value, not just the two core literals", () => {
  // resultType's own type is "complete" | "input_required" | string -
  // deliberately open so extensions can define their own values (e.g. the
  // Tasks extension's "task"). A value this function doesn't recognize by
  // name is not, by itself, a conformance problem.
  const problems = validateCacheableResult({ resultType: "task", ttlMs: 1000, cacheScope: "public" });
  assert.deepEqual(problems, []);
});

test("flags an empty-string resultType", () => {
  const problems = validateCacheableResult({ resultType: "", ttlMs: 1000, cacheScope: "public" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resultType/);
});

test("flags a missing resultType", () => {
  const problems = validateCacheableResult({ ttlMs: 1000, cacheScope: "public" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resultType/);
});

test("flags a negative ttlMs", () => {
  const problems = validateCacheableResult({ resultType: "complete", ttlMs: -1, cacheScope: "public" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ttlMs/);
});

test("flags an invalid cacheScope", () => {
  const problems = validateCacheableResult({ resultType: "complete", ttlMs: 1000, cacheScope: "shared" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cacheScope/);
});

test("reports every problem at once rather than stopping at the first", () => {
  const problems = validateCacheableResult({ ttlMs: -1, cacheScope: "shared" });
  assert.equal(problems.length, 3);
});
