import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RawJsonRpcClient, probeServerEra } from "@cruciblemcp/core";
import { runModernChecks } from "./engine.js";
import type { CheckResult } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const statelessServerEntry = path.resolve(here, "../../../fixtures/stateless-server/dist/index.js");
const legacyServerEntry = path.resolve(here, "../../../fixtures/basic-server/dist/index.js");

async function scanStatelessFixture(breakMode?: string): Promise<CheckResult[]> {
  const client = new RawJsonRpcClient({
    kind: "stdio",
    command: "node",
    args: [statelessServerEntry],
    env: breakMode ? { CRUCIBLE_BREAK: breakMode } : undefined,
  });

  await client.connect();
  try {
    const probe = await probeServerEra(client, "2026-07-28");
    assert.equal(
      probe.era,
      "modern",
      `expected the stateless fixture to probe as modern, got: ${JSON.stringify(probe)}`,
    );
    if (probe.era !== "modern") throw new Error("unreachable"); // narrows the type for what follows
    return await runModernChecks(client, probe.discoverResult, "2026-07-28");
  } finally {
    await client.close();
  }
}

const CACHEABLE_RESULT_CHECK_IDS = ["discover-conformance", "stateless-tools-list-conformance"];

test("modern checks all pass or warn (never fail) against the stateless fixture's default (non-broken) mode", async () => {
  const results = await scanStatelessFixture();
  const failed = results.filter((r) => r.status === "fail");
  assert.deepEqual(failed, [], `expected no failures, got: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(results.length, 5); // discover, tools/list, http-header, task-creation, task-capability
  // http-header-conformance doesn't apply over stdio - see its own test in
  // httpIntegration.test.ts for the case where it actually runs.
  assert.equal(results.find((r) => r.id === "http-header-conformance")?.status, "warn");
  assert.equal(results.find((r) => r.id === "task-creation-conformance")?.status, "pass");
  assert.equal(results.find((r) => r.id === "task-capability-conformance")?.status, "pass");
});

test("CRUCIBLE_BREAK=missing-result-type is caught by the two checks it applies to, and no others", async () => {
  const results = await scanStatelessFixture("missing-result-type");
  const affected = results.filter((r) => CACHEABLE_RESULT_CHECK_IDS.includes(r.id));
  assert.equal(affected.length, 2);
  for (const r of affected) {
    assert.equal(r.status, "fail");
    assert.match(r.message, /resultType/);
  }
  // This break mode only touches server/discover and tools/list's own
  // cache fields - the Tasks checks build their results differently and
  // shouldn't be affected just because an unrelated check is broken.
  assert.equal(results.find((r) => r.id === "task-creation-conformance")?.status, "pass");
  assert.equal(results.find((r) => r.id === "task-capability-conformance")?.status, "pass");
});

test("CRUCIBLE_BREAK=bad-cache-scope is caught by the two checks it applies to, and no others", async () => {
  const results = await scanStatelessFixture("bad-cache-scope");
  const affected = results.filter((r) => CACHEABLE_RESULT_CHECK_IDS.includes(r.id));
  assert.equal(affected.length, 2);
  for (const r of affected) {
    assert.equal(r.status, "fail");
    assert.match(r.message, /cacheScope/);
  }
  assert.equal(results.find((r) => r.id === "task-creation-conformance")?.status, "pass");
});

test("CRUCIBLE_BREAK=negative-ttl is caught by the two checks it applies to, and no others", async () => {
  const results = await scanStatelessFixture("negative-ttl");
  const affected = results.filter((r) => CACHEABLE_RESULT_CHECK_IDS.includes(r.id));
  assert.equal(affected.length, 2);
  for (const r of affected) {
    assert.equal(r.status, "fail");
    assert.match(r.message, /ttlMs/);
  }
  assert.equal(results.find((r) => r.id === "task-creation-conformance")?.status, "pass");
});

test("CRUCIBLE_BREAK=task-without-capability is caught by task-capability-conformance, and no others", async () => {
  const results = await scanStatelessFixture("task-without-capability");
  assert.equal(results.find((r) => r.id === "task-capability-conformance")?.status, "fail");
  assert.equal(results.find((r) => r.id === "task-creation-conformance")?.status, "pass");
  assert.equal(results.find((r) => r.id === "discover-conformance")?.status, "pass");
  assert.equal(results.find((r) => r.id === "stateless-tools-list-conformance")?.status, "pass");
});

test("CRUCIBLE_BREAK=task-resulttype-not-complete is caught by task-creation-conformance, and no others", async () => {
  const results = await scanStatelessFixture("task-resulttype-not-complete");
  const creation = results.find((r) => r.id === "task-creation-conformance");
  assert.equal(creation?.status, "fail");
  assert.match(creation.message, /resultType/);
  assert.equal(results.find((r) => r.id === "task-capability-conformance")?.status, "pass");
});

test("the probe classifies the Phase 1 SDK-based fixture as legacy, not modern", async () => {
  const client = new RawJsonRpcClient({
    kind: "stdio",
    command: "node",
    args: [legacyServerEntry],
  });
  await client.connect();
  try {
    const probe = await probeServerEra(client, "2026-07-28");
    assert.equal(probe.era, "legacy");
  } finally {
    await client.close();
  }
});
