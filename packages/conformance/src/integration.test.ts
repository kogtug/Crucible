import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpHarness } from "@crucible/core";
import { runChecks } from "./engine.js";

// This is the one test in Phase 1 that exercises the real stdio transport and
// a real MCP initialize handshake - everything in engine.test.ts uses fake
// checks so it can run fast and deterministically, but this test is what
// actually proves the harness works end to end against a live process.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureServerEntry = path.resolve(here, "../../fixtures/basic-server/dist/index.js");

test("default checks all pass against the basic reference fixture server", async () => {
  const harness = new McpHarness({ kind: "stdio", command: "node", args: [fixtureServerEntry] });

  try {
    await harness.connect();
    const results = await runChecks(harness);
    const failed = results.filter((r) => r.status === "fail");

    assert.deepEqual(failed, [], `expected no failing checks, got: ${JSON.stringify(failed, null, 2)}`);
    assert.equal(results.length, 2);
  } finally {
    await harness.close();
  }
});
