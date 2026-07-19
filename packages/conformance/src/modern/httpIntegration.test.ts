import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RawJsonRpcClient, probeServerEra } from "@crucible/core";
import { createStatelessHttpServer } from "@crucible/fixture-stateless-server/dist/httpServer.js";
import { createEchoHttpServer } from "@crucible/fixture-basic-server/dist/httpServer.js";
import { runModernChecks } from "./engine.js";
import type { CheckResult } from "../types.js";

function portOf(server: { address(): unknown }): number {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("expected a bound TCP address");
  return (address as { port: number }).port;
}

async function scanStatelessHttp(breakMode = ""): Promise<CheckResult[]> {
  const server = createStatelessHttpServer(breakMode);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const client = new RawJsonRpcClient({ kind: "http", url: `http://localhost:${portOf(server)}/` });

  try {
    await client.connect();
    const probe = await probeServerEra(client, "2026-07-28");
    assert.equal(probe.era, "modern", `expected modern era, got: ${JSON.stringify(probe)}`);
    if (probe.era !== "modern") throw new Error("unreachable");
    return await runModernChecks(client, probe.discoverResult, "2026-07-28");
  } finally {
    await client.close();
    server.close();
  }
}

test("modern checks all pass against the stateless fixture's default mode, over HTTP", async () => {
  const results = await scanStatelessHttp();
  const failed = results.filter((r) => r.status === "fail");
  assert.deepEqual(failed, [], `expected no failures, got: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(results.length, 5); // discover, tools/list, http-header-conformance, task-creation, task-capability
});

test("http-header-conformance fails when the server skips header validation", async () => {
  const results = await scanStatelessHttp("skip-header-validation");
  const headerCheck = results.find((r) => r.id === "http-header-conformance");
  assert.equal(headerCheck?.status, "fail");
  // Everything else about the response is still correct in this break mode -
  // only header validation should be affected.
  assert.equal(results.find((r) => r.id === "discover-conformance")?.status, "pass");
  assert.equal(results.find((r) => r.id === "stateless-tools-list-conformance")?.status, "pass");
});

test("http-header-conformance reports 'warn' (not applicable) over stdio", async () => {
  // Reuses the existing stdio fixture rather than starting an HTTP server,
  // to prove the check correctly recognizes it doesn't apply here instead
  // of silently passing or crashing.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const statelessServerEntry = path.resolve(
    here,
    "../../../fixtures/stateless-server/dist/index.js",
  );

  const client = new RawJsonRpcClient({
    kind: "stdio",
    command: "node",
    args: [statelessServerEntry],
  });
  try {
    await client.connect();
    const probe = await probeServerEra(client, "2026-07-28");
    if (probe.era !== "modern") throw new Error("expected modern era over stdio");
    const results = await runModernChecks(client, probe.discoverResult, "2026-07-28");
    assert.equal(results.find((r) => r.id === "http-header-conformance")?.status, "warn");
  } finally {
    await client.close();
  }
});

test("the probe correctly detects era over HTTP for both fixtures", async () => {
  const modernServer = createStatelessHttpServer();
  await new Promise<void>((resolve) => modernServer.listen(0, resolve));
  const modernClient = new RawJsonRpcClient({
    kind: "http",
    url: `http://localhost:${portOf(modernServer)}/`,
  });
  await modernClient.connect();

  const legacyServer = createEchoHttpServer();
  await new Promise<void>((resolve) => legacyServer.listen(0, resolve));
  const legacyClient = new RawJsonRpcClient({
    kind: "http",
    url: `http://localhost:${portOf(legacyServer)}/`,
  });
  await legacyClient.connect();

  try {
    const modernProbe = await probeServerEra(modernClient, "2026-07-28");
    assert.equal(modernProbe.era, "modern");

    const legacyProbe = await probeServerEra(legacyClient, "2026-07-28");
    assert.equal(legacyProbe.era, "legacy");
  } finally {
    await modernClient.close();
    await legacyClient.close();
    modernServer.close();
    legacyServer.close();
  }
});
