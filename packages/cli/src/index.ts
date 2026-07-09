#!/usr/bin/env node
import { Command } from "commander";
import { McpHarness, RawJsonRpcClient, probeServerEra } from "@crucible/core";
import { runChecks, runModernChecks } from "@crucible/conformance";
import type { CheckResult } from "@crucible/conformance";

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
  .action(async (commandParts: string[], options: { format: string }) => {
    if (options.format !== "human" && options.format !== "json") {
      console.error(`Unknown --format '${options.format}': expected 'human' or 'json'.`);
      process.exitCode = 2;
      return;
    }

    const [command, ...args] = commandParts;

    try {
      const report = await scan(command, args);
      if (options.format === "json") {
        printJsonReport(report);
      } else {
        printHumanReport(report);
      }
      process.exitCode = report.results.some((r) => r.status === "fail") ? 1 : 0;
    } catch (err) {
      const message = `Crucible could not complete the scan: ${err instanceof Error ? err.message : String(err)}`;
      if (options.format === "json") {
        console.log(JSON.stringify({ target: [command, ...args].join(" "), error: message }, null, 2));
      } else {
        console.error(message);
      }
      process.exitCode = 2;
    }
  });

await program.parseAsync(process.argv);

