import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResilience } from "./liveness.js";
import type { RawJsonRpcClient } from "@crucible/core";

function fakeClient(overrides: Partial<RawJsonRpcClient>): RawJsonRpcClient {
  return {
    isAlive: () => true,
    getExitInfo: () => undefined,
    request: async () => {
      throw new Error("fakeClient: request() not stubbed for this test");
    },
    ...overrides,
  } as RawJsonRpcClient;
}

test("reports 'crashed' when the process is no longer alive, regardless of the immediate outcome", async () => {
  const client = fakeClient({
    isAlive: () => false,
    getExitInfo: () => ({ code: 1, signal: null }),
  });
  const { verdict, message } = await classifyResilience(client, {
    immediateResponseAcceptable: true,
    detail: "x",
  });
  assert.equal(verdict, "crashed");
  assert.match(message, /code 1/);
});

test("reports 'hung' when alive but unresponsive to the follow-up liveness probe", async () => {
  const client = fakeClient({
    isAlive: () => true,
    request: async () => {
      throw new Error("timed out");
    },
  });
  const { verdict } = await classifyResilience(client, {
    immediateResponseAcceptable: true,
    detail: "x",
  });
  assert.equal(verdict, "hung");
});

test("reports 'degraded' when responsive afterward but the immediate reaction was wrong", async () => {
  const client = fakeClient({
    isAlive: () => true,
    request: async () => ({ jsonrpc: "2.0" as const, id: 1, result: {} }),
  });
  const { verdict } = await classifyResilience(client, {
    immediateResponseAcceptable: false,
    detail: "x",
  });
  assert.equal(verdict, "degraded");
});

test("reports 'resilient' when responsive afterward and the immediate reaction was correct", async () => {
  const client = fakeClient({
    isAlive: () => true,
    request: async () => ({ jsonrpc: "2.0" as const, id: 1, result: {} }),
  });
  const { verdict } = await classifyResilience(client, {
    immediateResponseAcceptable: true,
    detail: "x",
  });
  assert.equal(verdict, "resilient");
});
