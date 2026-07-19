import { test } from "node:test";
import assert from "node:assert/strict";
import { McpHarness } from "@crucible/core";
import { createEchoHttpServer } from "@crucible/fixture-basic-server/dist/httpServer.js";
import { runChecks } from "./engine.js";

test("legacy checks all pass against the basic fixture over Streamable HTTP", async () => {
  const server = createEchoHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("expected a bound TCP address");

  const harness = new McpHarness({ kind: "http", url: `http://localhost:${address.port}/` });

  try {
    await harness.connect();
    const results = await runChecks(harness);
    const failed = results.filter((r) => r.status === "fail");
    assert.deepEqual(failed, [], `expected no failures, got: ${JSON.stringify(failed, null, 2)}`);
    assert.equal(results.length, 2);
  } finally {
    await harness.close();
    server.close();
  }
});
