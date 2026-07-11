import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "./engine.js";
import type { Check, CheckStatus } from "./types.js";
import type { McpHarness } from "@crucible/core";

// These tests exercise the engine in isolation with fake checks, so they
// don't need a real MCP connection. integration.test.ts (this package) and
// modern/integration.test.ts are what exercise the real, end-to-end stdio +
// handshake path against actual fixture servers.

test("a check that throws becomes a failed CheckResult instead of crashing the run", async () => {
  const explodingCheck: Check = {
    id: "exploding-check",
    title: "A check that always throws",
    async run() {
      throw new Error("boom");
    },
  };

  const results = await runChecks({} as McpHarness, [explodingCheck]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fail" satisfies CheckStatus);
  assert.match(results[0].message, /boom/);
});

test("runChecks preserves check order and returns exactly one result per check", async () => {
  const alwaysPass: Check = {
    id: "always-pass",
    title: "Always passes",
    async run() {
      return { id: "always-pass", title: "Always passes", status: "pass", message: "ok" };
    },
  };
  const alwaysWarn: Check = {
    id: "always-warn",
    title: "Always warns",
    async run() {
      return { id: "always-warn", title: "Always warns", status: "warn", message: "hmm" };
    },
  };

  const results = await runChecks({} as McpHarness, [alwaysPass, alwaysWarn]);

  assert.deepEqual(
    results.map((r) => r.id),
    ["always-pass", "always-warn"],
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ["pass", "warn"],
  );
});
