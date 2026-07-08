#!/usr/bin/env node
import { Command } from "commander";
import { McpHarness } from "@crucible/core";
import { runChecks } from "@crucible/conformance";
import type { CheckResult } from "@crucible/conformance";

const STATUS_ICON: Record<CheckResult["status"], string> = {
  pass: "\u2705",
  fail: "\u274c",
  warn: "\u26a0\ufe0f ",
};

function printReport(results: CheckResult[]): void {
  for (const result of results) {
    console.log(`${STATUS_ICON[result.status]} [${result.status.toUpperCase()}] ${result.title}`);
    console.log(`   ${result.message}`);
    if (result.specRef) console.log(`   spec: ${result.specRef}`);
    console.log("");
  }

  const passCount = results.filter((r) => r.status === "pass").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  console.log(
    `Summary: ${passCount} passed, ${failCount} failed, ${warnCount} warned (${results.length} total).`,
  );
}

const program = new Command();

program
  .name("crucible")
  .description(
    "Conformance and resilience testing harness for the Model Context Protocol.",
  )
  .version("0.1.0");

program
  .command("scan")
  .description("Run Crucible's conformance checks against a target MCP server.")
  .argument(
    "<command...>",
    "the command that launches the target server over stdio, e.g. `node server.js`",
  )
  .action(async (commandParts: string[]) => {
    const [command, ...args] = commandParts;
    const harness = new McpHarness({ command, args });

    console.log(`\nCrucible: launching target server -> ${command} ${args.join(" ")}\n`);

    try {
      await harness.connect();
      const results = await runChecks(harness);
      printReport(results);
      process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
    } catch (err) {
      console.error(
        `Crucible could not complete the scan: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 2;
    } finally {
      await harness.close();
    }
  });

await program.parseAsync(process.argv);
