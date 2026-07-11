#!/usr/bin/env node
import { Command } from "commander";
import { McpHarness, RawJsonRpcClient, probeServerEra } from "@crucible/core";
import { runChecks, runModernChecks } from "@crucible/conformance";
import type { CheckResult } from "@crucible/conformance";
import { runChaosScenarios } from "@crucible/chaos";
import type { ChaosResult, ResilienceVerdict } from "@crucible/chaos";

/** The version Crucible asks for when probing. If a target only supports
 * older modern versions in the future, we fall back to its own advertised
 * list rather than insisting on this one - see negotiateVersion() below. */
const PREFERRED_MODERN_VERSION = "2026-07-28";

const STATUS_ICON: Record<CheckResult["status"], string> = {
  pass: "\u2705",
  fail: "\u274c",
  warn: "\u26a0\ufe0f ",
};

interface ScanReport {
  target: string;
  era: "legacy" | "modern" | "modern-version-mismatch";
  results: CheckResult[];
  note?: string;
}

function summarize(results: CheckResult[]) {
  return {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    warn: results.filter((r) => r.status === "warn").length,
    total: results.length,
  };
}

function printHumanReport(report: ScanReport): void {
  console.log(`\nCrucible: scanning ${report.target}`);
  console.log(`Detected protocol era: ${report.era}`);
  if (report.note) console.log(report.note);
  console.log("");

  for (const result of report.results) {
    console.log(`${STATUS_ICON[result.status]} [${result.status.toUpperCase()}] ${result.title}`);
    console.log(`   ${result.message}`);
    if (result.specRef) console.log(`   spec: ${result.specRef}`);
    console.log("");
  }

  const s = summarize(report.results);
  console.log(`Summary: ${s.pass} passed, ${s.fail} failed, ${s.warn} warned (${s.total} total).`);
}

function printJsonReport(report: ScanReport): void {
  console.log(JSON.stringify({ ...report, summary: summarize(report.results) }, null, 2));
}

function negotiateVersion(supportedVersions: string[]): string {
  return supportedVersions.includes(PREFERRED_MODERN_VERSION)
    ? PREFERRED_MODERN_VERSION
    : (supportedVersions[0] ?? PREFERRED_MODERN_VERSION);
}

const VERDICT_ICON: Record<ResilienceVerdict, string> = {
  resilient: "\u2705",
  degraded: "\u26a0\ufe0f ",
  hung: "\u23f3",
  crashed: "\ud83d\udca5",
};

interface ChaosReport {
  target: string;
  results: ChaosResult[];
}

function summarizeChaos(results: ChaosResult[]) {
  return {
    resilient: results.filter((r) => r.verdict === "resilient").length,
    degraded: results.filter((r) => r.verdict === "degraded").length,
    hung: results.filter((r) => r.verdict === "hung").length,
    crashed: results.filter((r) => r.verdict === "crashed").length,
    total: results.length,
  };
}

function printChaosHumanReport(report: ChaosReport): void {
  console.log(`\nCrucible chaos: attacking ${report.target}\n`);

  for (const result of report.results) {
    console.log(`${VERDICT_ICON[result.verdict]} [${result.verdict.toUpperCase()}] ${result.title}`);
    console.log(`   ${result.message}`);
    if (result.specRef) console.log(`   spec: ${result.specRef}`);
    console.log("");
  }

  const s = summarizeChaos(report.results);
  console.log(
    `Summary: ${s.resilient} resilient, ${s.degraded} degraded, ${s.hung} hung, ${s.crashed} crashed (${s.total} total).`,
  );
}

function printChaosJsonReport(report: ChaosReport): void {
  console.log(JSON.stringify({ ...report, summary: summarizeChaos(report.results) }, null, 2));
}

async function runChaos(command: string, args: string[]): Promise<ChaosReport> {
  const target = [command, ...args].join(" ");
  const client = new RawJsonRpcClient({ command, args });
  await client.connect();
  try {
    const results = await runChaosScenarios(client);
    return { target, results };
  } finally {
    await client.close();
  }
}

async function runLegacyScan(command: string, args: string[]): Promise<CheckResult[]> {
  const harness = new McpHarness({ command, args });
  try {
    await harness.connect();
    return await runChecks(harness);
  } finally {
    await harness.close();
  }
}

/**
 * Probes the target once via `server/discover` and, based on the outcome,
 * either runs the modern (stateless, discover-based) checks on that same
 * connection, or - for legacy servers - closes it and opens a fresh
 * McpHarness connection, since the SDK's initialize-based Client manages
 * its own transport and can't take over a connection that already had raw
 * traffic written to it. See docs/architecture.md, "Two protocol eras".
 */
async function scan(command: string, args: string[]): Promise<ScanReport> {
  const target = [command, ...args].join(" ");
  const probeClient = new RawJsonRpcClient({ command, args });
  await probeClient.connect();

  const probe = await probeServerEra(probeClient, PREFERRED_MODERN_VERSION);

  if (probe.era === "legacy") {
    await probeClient.close();
    const results = await runLegacyScan(command, args);
    return { target, era: "legacy", results };
  }

  if (probe.era === "modern-version-mismatch") {
    await probeClient.close();
    return {
      target,
      era: "modern-version-mismatch",
      results: [],
      note: `server/discover reports this server only supports [${probe.supportedVersions.join(", ")}], not ${PREFERRED_MODERN_VERSION}. Per spec, Crucible does not fall back to 'initialize' once a server has identified itself as modern.`,
    };
  }

  try {
    const negotiatedVersion = negotiateVersion(probe.supportedVersions);
    const results = await runModernChecks(probeClient, probe.discoverResult, negotiatedVersion);
    return { target, era: "modern", results };
  } finally {
    await probeClient.close();
  }
}

type OutputFormat = "human" | "json";

function parseFormat(raw: string): OutputFormat | null {
  return raw === "human" || raw === "json" ? raw : null;
}

/**
 * Both `scan` and `chaos`'s actions were the same wrapper around a
 * different `execute`/print pair: validate --format, run, print with the
 * right printer, set an exit code from the report - or, on a connection
 * -level failure, print an error in the matching format and exit 2. That
 * wrapper is now here once; `execute`, `print`, and `exitCodeFor` are the
 * only things specific to either command.
 */
async function runCommand<Report>(
  rawFormat: string,
  command: string,
  args: string[],
  execute: (command: string, args: string[]) => Promise<Report>,
  print: Record<OutputFormat, (report: Report) => void>,
  exitCodeFor: (report: Report) => number,
  failureLabel: string,
): Promise<void> {
  const format = parseFormat(rawFormat);
  if (!format) {
    console.error(`Unknown --format '${rawFormat}': expected 'human' or 'json'.`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await execute(command, args);
    print[format](report);
    process.exitCode = exitCodeFor(report);
  } catch (err) {
    const message = `Crucible could not complete the ${failureLabel}: ${err instanceof Error ? err.message : String(err)}`;
    if (format === "json") {
      console.log(JSON.stringify({ target: [command, ...args].join(" "), error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 2;
  }
}

const program = new Command();

program
  .name("crucible")
  .description("Conformance and resilience testing harness for the Model Context Protocol.")
  .version("0.1.0");

program
  .command("scan")
  .description(
    "Run Crucible's conformance checks against a target MCP server. Automatically detects " +
      "whether the target speaks the classic initialize-based protocol or the draft 2026-07-28 " +
      "stateless/discover-based one, and runs the matching check family.",
  )
  .option("--format <type>", "output format: 'human' or 'json'", "human")
  .argument("<command...>", "the command that launches the target server over stdio, e.g. `node server.js`")
  .action((commandParts: string[], options: { format: string }) => {
    const [command, ...args] = commandParts;
    return runCommand(
      options.format,
      command,
      args,
      scan,
      { human: printHumanReport, json: printJsonReport },
      (report) => (report.results.some((r) => r.status === "fail") ? 1 : 0),
      "scan",
    );
  });

program
  .command("chaos")
  .description(
    "Send a target MCP server a battery of deliberately adversarial inputs (malformed JSON, " +
      "unrecognized methods) and score how gracefully it degrades: resilient, degraded, hung, or crashed.",
  )
  .option("--format <type>", "output format: 'human' or 'json'", "human")
  .argument("<command...>", "the command that launches the target server over stdio, e.g. `node server.js`")
  .action((commandParts: string[], options: { format: string }) => {
    const [command, ...args] = commandParts;
    return runCommand(
      options.format,
      command,
      args,
      runChaos,
      { human: printChaosHumanReport, json: printChaosJsonReport },
      (report) => (report.results.some((r) => r.verdict !== "resilient") ? 1 : 0),
      "chaos run",
    );
  });

await program.parseAsync(process.argv);

