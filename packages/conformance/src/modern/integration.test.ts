import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RawJsonRpcClient, probeServerEra } from "@crucible/core";
import { runModernChecks } from "./engine.js";
import type { CheckResult } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const statelessServerEntry = path.resolve(here, "../../../fixtures/stateless-server/dist/index.js");
const legacyServerEntry = path.resolve(here, "../../../fixtures/basic-server/dist/index.js");

async function scanStatelessFixture(breakMode?: string): Promise<CheckResult[]> {
  const client = new RawJsonRpcClient({
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

test("modern checks all pass against the stateless fixture's default (non-broken) mode", async () => {
  const results = await scanStatelessFixture();
  const failed = results.filter((r) => r.status === "fail");
  assert.deepEqual(failed, [], `expected no failures, got: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(results.length, 2);
});

test("CRUCIBLE_BREAK=missing-result-type is caught by both modern checks", async () => {
  const results = await scanStatelessFixture("missing-result-type");
  assert.equal(results.filter((r) => r.status === "fail").length, 2);
  for (const r of results) assert.match(r.message, /resultType/);
});

test("CRUCIBLE_BREAK=bad-cache-scope is caught by both modern checks", async () => {
  const results = await scanStatelessFixture("bad-cache-scope");
  assert.equal(results.filter((r) => r.status === "fail").length, 2);
  for (const r of results) assert.match(r.message, /cacheScope/);
});

test("CRUCIBLE_BREAK=negative-ttl is caught by both modern checks", async () => {
  const results = await scanStatelessFixture("negative-ttl");
  assert.equal(results.filter((r) => r.status === "fail").length, 2);
  for (const r of results) assert.match(r.message, /ttlMs/);
});

test("the probe classifies the Phase 1 SDK-based fixture as legacy, not modern", async () => {
  const client = new RawJsonRpcClient({ command: "node", args: [legacyServerEntry] });
  await client.connect();
  try {
    const probe = await probeServerEra(client, "2026-07-28");
    assert.equal(probe.era, "legacy");
  } finally {
    await client.close();
  }
});
