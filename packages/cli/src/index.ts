#!/usr/bin/env node

import { Command } from "commander";
import { McpHarness, RawJsonRpcClient, probeServerEra } from "@cruciblemcp/core";
import type { Target } from "@cruciblemcp/core";

import { runChecks, runModernChecks } from "@cruciblemcp/conformance";
import type { CheckResult } from "@cruciblemcp/conformance";

import { runChaosScenarios } from "@cruciblemcp/chaos";
import type { ChaosResult, ResilienceVerdict } from "@cruciblemcp/chaos";

/**
 * The modern MCP protocol version Crucible prefers when probing.
 *
 * If the server supports this version, Crucible uses it.
 * If the server is modern but only advertises older supported versions,
 * Crucible negotiates the first version advertised by the server.
 */
const PREFERRED_MODERN_VERSION = "2026-07-28";

/**
 * Parse a target from CLI arguments.
 *
 * A single HTTP/HTTPS argument is treated as an HTTP MCP endpoint.
 * Everything else is treated as a stdio command.
 *
 * Examples:
 *
 *   crucible scan http://localhost:8080/mcp
 *
 *   crucible scan node server.js
 *
 *   crucible chaos node server.js
 */
function parseTarget(commandParts: string[]): Target {
  if (commandParts.length === 1 && /^https?:\/\//i.test(commandParts[0])) {
    return {
      kind: "http",
      url: commandParts[0],
    };
  }

  const [command, ...args] = commandParts;

  if (!command) {
    throw new Error("No target command or URL was provided.");
  }

  return {
    kind: "stdio",
    command,
    args,
  };
}

function describeTarget(target: Target): string {
  if (target.kind === "http") {
    return target.url;
  }

  return [target.command, ...(target.args ?? [])].join(" ");
}

const STATUS_ICON: Record<CheckResult["status"], string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
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

  if (report.note) {
    console.log(report.note);
  }

  console.log("");

  for (const result of report.results) {
    console.log(`${STATUS_ICON[result.status]} [${result.status.toUpperCase()}] ${result.title}`);

    console.log(`   ${result.message}`);

    if (result.specRef) {
      console.log(`   spec: ${result.specRef}`);
    }

    console.log("");
  }

  const summary = summarize(report.results);

  console.log(
    `Summary: ${summary.pass} passed, ${summary.fail} failed, ` +
      `${summary.warn} warned (${summary.total} total).`,
  );
}

function printJsonReport(report: ScanReport): void {
  console.log(
    JSON.stringify(
      {
        ...report,
        summary: summarize(report.results),
      },
      null,
      2,
    ),
  );
}

/**
 * Select the MCP version to use for modern protocol checks.
 */
function negotiateVersion(supportedVersions: string[]): string {
  if (supportedVersions.includes(PREFERRED_MODERN_VERSION)) {
    return PREFERRED_MODERN_VERSION;
  }

  return supportedVersions[0] ?? PREFERRED_MODERN_VERSION;
}

const VERDICT_ICON: Record<ResilienceVerdict, string> = {
  resilient: "✅",
  degraded: "⚠️",
  hung: "⏳",
  crashed: "💥",
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
    console.log(
      `${VERDICT_ICON[result.verdict]} ` + `[${result.verdict.toUpperCase()}] ${result.title}`,
    );

    console.log(`   ${result.message}`);

    if (result.specRef) {
      console.log(`   spec: ${result.specRef}`);
    }

    console.log("");
  }

  const summary = summarizeChaos(report.results);

  console.log(
    `Summary: ${summary.resilient} resilient, ` +
      `${summary.degraded} degraded, ` +
      `${summary.hung} hung, ` +
      `${summary.crashed} crashed ` +
      `(${summary.total} total).`,
  );
}

function printChaosJsonReport(report: ChaosReport): void {
  console.log(
    JSON.stringify(
      {
        ...report,
        summary: summarizeChaos(report.results),
      },
      null,
      2,
    ),
  );
}

async function runChaos(target: Target): Promise<ChaosReport> {
  const targetLabel = describeTarget(target);

  if (target.kind === "http") {
    throw new Error(
      "Chaos testing over HTTP isn't implemented yet. " +
        "Only stdio targets are supported for 'chaos'. " +
        "Use 'scan' for HTTP conformance checks.",
    );
  }

  const client = new RawJsonRpcClient(target);

  await client.connect();

  try {
    const results = await runChaosScenarios(client);

    return {
      target: targetLabel,
      results,
    };
  } finally {
    await client.close();
  }
}

async function runLegacyScan(target: Target): Promise<CheckResult[]> {
  const harness = new McpHarness(target);

  try {
    await harness.connect();

    return await runChecks(harness);
  } finally {
    await harness.close();
  }
}

/**
 * Scan an MCP target.
 *
 * Crucible first probes server/discover.
 *
 * If the target is legacy:
 *   close probe connection
 *   create a fresh SDK/McpHarness connection
 *   run legacy checks
 *
 * If the target is modern:
 *   keep the raw connection
 *   negotiate the protocol version
 *   run modern checks
 *
 * If the target is modern but doesn't support our preferred version:
 *   report the mismatch without incorrectly falling back to legacy.
 */
async function scan(target: Target): Promise<ScanReport> {
  const targetLabel = describeTarget(target);

  const probeClient = new RawJsonRpcClient(target);

  await probeClient.connect();

  let probe;

  try {
    probe = await probeServerEra(probeClient, PREFERRED_MODERN_VERSION);
  } catch (error) {
    await probeClient.close();
    throw error;
  }

  if (probe.era === "legacy") {
    await probeClient.close();

    const results = await runLegacyScan(target);

    return {
      target: targetLabel,
      era: "legacy",
      results,
    };
  }

  if (probe.era === "modern-version-mismatch") {
    await probeClient.close();

    return {
      target: targetLabel,
      era: "modern-version-mismatch",
      results: [],
      note:
        `server/discover reports this server only supports ` +
        `[${probe.supportedVersions.join(", ")}], not ` +
        `${PREFERRED_MODERN_VERSION}. ` +
        `Per spec, Crucible does not fall back to ` +
        `"initialize" once a server has identified itself as modern.`,
    };
  }

  try {
    const negotiatedVersion = negotiateVersion(probe.supportedVersions);

    const results = await runModernChecks(probeClient, probe.discoverResult, negotiatedVersion);

    return {
      target: targetLabel,
      era: "modern",
      results,
    };
  } finally {
    await probeClient.close();
  }
}

type OutputFormat = "human" | "json";

function parseFormat(raw: string): OutputFormat | null {
  if (raw === "human" || raw === "json") {
    return raw;
  }

  return null;
}

/**
 * Shared command execution wrapper.
 *
 * Handles:
 * - --format validation
 * - execution
 * - human/json output
 * - exit codes
 * - connection/runtime failures
 */
async function runCommand<Report>(
  rawFormat: string,
  target: Target,
  execute: (target: Target) => Promise<Report>,
  print: Record<OutputFormat, (report: Report) => void>,
  exitCodeFor: (report: Report) => number,
  failureLabel: string,
): Promise<void> {
  const format = parseFormat(rawFormat);

  if (!format) {
    console.error(`Unknown --format '${rawFormat}': ` + `expected 'human' or 'json'.`);

    process.exitCode = 2;
    return;
  }

  try {
    const report = await execute(target);

    print[format](report);

    process.exitCode = exitCodeFor(report);
  } catch (error) {
    const message =
      `Crucible could not complete the ${failureLabel}: ` +
      `${error instanceof Error ? error.message : String(error)}`;

    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            target: describeTarget(target),
            error: message,
          },
          null,
          2,
        ),
      );
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
  .version("0.1.5");

program
  .command("scan")
  .description(
    "Run Crucible's conformance checks against a target MCP server. " +
      "Automatically detects whether the target speaks the classic " +
      "initialize-based protocol or the draft 2026-07-28 " +
      "stateless/discover-based one, and runs the matching check family.",
  )
  .option("--format <type>", "output format: 'human' or 'json'", "human")
  .argument(
    "<command...>",
    "a command that launches the target server over stdio " +
      "(e.g. `node server.js`), or a single MCP endpoint URL " +
      "(e.g. `http://localhost:8080/mcp`)",
  )
  .action((commandParts: string[], options: { format: string }) => {
    return runCommand(
      options.format,
      parseTarget(commandParts),
      scan,
      {
        human: printHumanReport,
        json: printJsonReport,
      },
      (report) => (report.results.some((result) => result.status === "fail") ? 1 : 0),
      "scan",
    );
  });

program
  .command("chaos")
  .description(
    "Send a target MCP server a battery of deliberately " +
      "adversarial inputs (malformed JSON, unrecognized methods) " +
      "and score how gracefully it degrades: resilient, degraded, " +
      "hung, or crashed. Stdio targets only for now.",
  )
  .option("--format <type>", "output format: 'human' or 'json'", "human")
  .argument(
    "<command...>",
    "the command that launches the target server over stdio, " + "e.g. `node server.js`",
  )
  .action((commandParts: string[], options: { format: string }) => {
    return runCommand(
      options.format,
      parseTarget(commandParts),
      runChaos,
      {
        human: printChaosHumanReport,
        json: printChaosJsonReport,
      },
      (report) => (report.results.some((result) => result.verdict !== "resilient") ? 1 : 0),
      "chaos run",
    );
  });

await program.parseAsync(process.argv);
