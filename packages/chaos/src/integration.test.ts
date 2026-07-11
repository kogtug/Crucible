import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RawJsonRpcClient } from "@crucible/core";
import { runChaosScenarios } from "./engine.js";
import type { ChaosResult } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const statelessServerEntry = path.resolve(here, "../../fixtures/stateless-server/dist/index.js");

async function runChaosAgainst(breakMode?: string): Promise<ChaosResult[]> {
  const client = new RawJsonRpcClient({
    command: "node",
    args: [statelessServerEntry],
    env: breakMode ? { CRUCIBLE_BREAK: breakMode } : undefined,
  });
  await client.connect();
  try {
    return await runChaosScenarios(client);
  } finally {
    await client.close();
  }
}

test("both scenarios report 'resilient' against the well-behaved stateless fixture", async () => {
  const results = await runChaosAgainst();
  for (const r of results) {
    assert.equal(r.verdict, "resilient", `expected ${r.id} to be resilient, got ${r.verdict}: ${r.message}`);
  }
  assert.equal(results.length, 2);
});

test("CRUCIBLE_BREAK=crash-on-malformed is reported as 'crashed', without affecting the unrelated break mode", async () => {
  const results = await runChaosAgainst("crash-on-malformed");
  const malformed = results.find((r) => r.id === "malformed-json-resilience");
  assert.equal(malformed?.verdict, "crashed");
});

test("CRUCIBLE_BREAK=hang-on-unknown-method is reported as 'degraded', not 'hung'", async () => {
  const results = await runChaosAgainst("hang-on-unknown-method");
  const malformed = results.find((r) => r.id === "malformed-json-resilience");
  const unknownMethod = results.find((r) => r.id === "unknown-method-resilience");

  // This is "degraded", specifically NOT "hung": the server ignores this one
  // bad request but is still perfectly responsive to everything else,
  // including the malformed-JSON scenario that runs right after it in the
  // same suite. "hung" is reserved for when the *whole process* stops
  // responding to anything - see the freeze-on-unknown-method test below.
  assert.equal(unknownMethod?.verdict, "degraded");
  assert.equal(malformed?.verdict, "resilient");
});

test("CRUCIBLE_BREAK=freeze-on-unknown-method is reported as 'hung'", async () => {
  const results = await runChaosAgainst("freeze-on-unknown-method");
  const unknownMethod = results.find((r) => r.id === "unknown-method-resilience");
  assert.equal(unknownMethod?.verdict, "hung");
});
