import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createStatelessHttpServer } from "@crucible/fixture-stateless-server/dist/httpServer.js";
import { createEchoHttpServer } from "@crucible/fixture-basic-server/dist/httpServer.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "index.js");
const legacyServerEntry = path.resolve(here, "../../fixtures/basic-server/dist/index.js");
const statelessServerEntry = path.resolve(here, "../../fixtures/stateless-server/dist/index.js");

interface CliRunResult {
  stdout: string;
  exitCode: number;
}

interface ScanReportJson {
  era?: string;
  results: { id: string; status: string }[];
  summary: { pass: number; fail: number; warn: number; total: number };
}

interface ChaosReportJson {
  results: { id: string; verdict: string }[];
  summary: { resilient: number; degraded: number; hung: number; crashed: number; total: number };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRunResult> {
  try {
    const { stdout } = await execFileAsync("node", [cliEntry, ...args], {
      env: { ...process.env, ...env },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", exitCode: failure.code ?? 1 };
  }
}

test("crucible scan detects the legacy fixture, passes, and exits 0", async () => {
  const { stdout, exitCode } = await runCli([
    "scan",
    "--format",
    "json",
    "--",
    "node",
    legacyServerEntry,
  ]);
  const report = JSON.parse(stdout) as ScanReportJson;
  assert.equal(report.era, "legacy");
  assert.equal(report.summary.fail, 0);
  assert.equal(exitCode, 0);
});

test("crucible scan detects the modern fixture, passes, and exits 0", async () => {
  const { stdout, exitCode } = await runCli([
    "scan",
    "--format",
    "json",
    "--",
    "node",
    statelessServerEntry,
  ]);
  const report = JSON.parse(stdout) as ScanReportJson;
  assert.equal(report.era, "modern");
  assert.equal(report.summary.fail, 0);
  assert.equal(exitCode, 0);
});

test("crucible scan exits 1 and reports failures for a broken modern fixture", async () => {
  const { stdout, exitCode } = await runCli(
    ["scan", "--format", "json", "--", "node", statelessServerEntry],
    { CRUCIBLE_BREAK: "negative-ttl" },
  );
  const report = JSON.parse(stdout) as ScanReportJson;
  assert.equal(report.era, "modern");
  assert.ok(report.summary.fail > 0, "expected at least one failing check");
  assert.equal(exitCode, 1);
});

test("crucible chaos reports all-resilient against the well-behaved stateless fixture", async () => {
  const { stdout, exitCode } = await runCli([
    "chaos",
    "--format",
    "json",
    "--",
    "node",
    statelessServerEntry,
  ]);
  const report = JSON.parse(stdout) as ChaosReportJson;
  assert.equal(report.summary.resilient, 2);
  assert.equal(exitCode, 0);
});

test("crucible chaos reports 'crashed' and exits 1 against CRUCIBLE_BREAK=crash-on-malformed", async () => {
  const { stdout, exitCode } = await runCli(
    ["chaos", "--format", "json", "--", "node", statelessServerEntry],
    { CRUCIBLE_BREAK: "crash-on-malformed" },
  );
  const report = JSON.parse(stdout) as ChaosReportJson;
  assert.equal(report.summary.crashed, 2);
  assert.equal(exitCode, 1);
});

test("crucible chaos works era-agnostically against the legacy SDK-based fixture, and exits 1 there too", async () => {
  // Real finding, verified against primary sources before being treated as
  // one - see FINDINGS.md. Short version: the official SDK's stdio
  // transport doesn't send a JSON-RPC error for malformed input (traced to
  // an unguarded JSON.parse in shared/stdio.js), which is a real
  // robustness gap relative to JSON-RPC 2.0 convention, but is NOT a clean
  // MCP specification violation - the spec is more silent on this exact
  // case than that framing would suggest. That's why this is 'degraded',
  // not something stronger.
  const { stdout, exitCode } = await runCli([
    "chaos",
    "--format",
    "json",
    "--",
    "node",
    legacyServerEntry,
  ]);
  const report = JSON.parse(stdout) as ChaosReportJson;
  const malformed = report.results.find((r) => r.id === "malformed-json-resilience");
  assert.equal(malformed?.verdict, "degraded");
  assert.equal(exitCode, 1);
});

test("crucible scan rejects an unknown --format value with exit code 2", async () => {
  const { exitCode } = await runCli(["scan", "--format", "xml", "--", "node", legacyServerEntry]);
  assert.equal(exitCode, 2);
});

test("crucible scan <url> works against a real HTTP server for both fixtures", async () => {
  const modernServer = createStatelessHttpServer();
  const legacyServer = createEchoHttpServer();
  await new Promise<void>((resolve) => modernServer.listen(0, resolve));
  await new Promise<void>((resolve) => legacyServer.listen(0, resolve));
  const modernPort = (modernServer.address() as AddressInfo).port;
  const legacyPort = (legacyServer.address() as AddressInfo).port;

  try {
    const modern = await runCli(["scan", "--format", "json", `http://localhost:${modernPort}/`]);
    const modernReport = JSON.parse(modern.stdout) as ScanReportJson;
    assert.equal(modernReport.era, "modern");
    assert.equal(modernReport.summary.fail, 0);
    assert.equal(modern.exitCode, 0);

    const legacy = await runCli(["scan", "--format", "json", `http://localhost:${legacyPort}/`]);
    const legacyReport = JSON.parse(legacy.stdout) as ScanReportJson;
    assert.equal(legacyReport.era, "legacy");
    assert.equal(legacyReport.summary.fail, 0);
    assert.equal(legacy.exitCode, 0);
  } finally {
    modernServer.close();
    legacyServer.close();
  }
});

test("crucible chaos rejects an HTTP target with a clear error and exit code 2", async () => {
  const server = createStatelessHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const { exitCode } = await runCli(["chaos", `http://localhost:${port}/`]);
    assert.equal(exitCode, 2);
  } finally {
    server.close();
  }
});
