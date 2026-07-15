# Crucible

**A conformance and resilience testing harness for the Model Context Protocol (MCP).**

Crucible connects to an MCP server, runs it through a battery of spec-referenced
conformance checks, and deliberately injects protocol-level faults to see
whether the server degrades safely or fails silently. Think of it as
`npm audit` crossed with chaos engineering, aimed specifically at the MCP wire
protocol rather than at malicious tool content.

## Why this project, why now

MCP is mid-way through the largest revision to its specification since launch:
the release candidate is out now, and the final spec lands **2026-07-28**. It
removes the `initialize` handshake entirely in favor of a stateless core,
per-request version negotiation, and a `server/discover` method for capability
discovery, plus a `resultType`/`ttlMs`/`cacheScope` contract on every result
and tighter OAuth-based authorization. SDK maintainers have roughly a ten-week
window to validate against it — which means almost none of the existing MCP
tooling ecosystem (security scanners, chaos-testing tools, observability
platforms) yet has anything that checks whether a server or client correctly
implements *these specific new primitives*. That gap is what Crucible targets.

This is deliberately **not** another MCP security scanner (tool-poisoning /
prompt-injection detection is already well served by tools like MCP-Scan,
mcp-audit, and several others) and **not** another generic agent chaos-testing
framework (see `agent-chaos`, Cordum). Crucible is scoped narrowly to protocol
*correctness and resilience* against the newest spec surface.

See [`docs/architecture.md`](./docs/architecture.md) for the full design,
including a correction: Phase 1 described the new discovery mechanism as
"Server Cards" based on secondary sources. Having since read the actual spec,
that term doesn't exist in it - the real mechanism is a JSON-RPC method,
`server/discover`. The docs explain how that surfaced.

## Status

**Phase 1 — walking skeleton**
- [x] Monorepo scaffold (npm workspaces + TypeScript project references)
- [x] `@crucible/core` — stdio harness wrapping the official MCP SDK client
- [x] `@crucible/fixture-basic-server` — a minimal, well-behaved reference server
- [x] `@crucible/conformance` — engine + 2 checks (handshake, `tools/list` schema)
- [x] `@crucible/cli` — `crucible scan -- <command>`
- [x] Automated test suite (unit tests for the engine + a real end-to-end
      integration test against the fixture server), wired into CI

**Phase 2 — the draft 2026-07-28 primitives (stdio-only)**
- [x] `RawJsonRpcClient` — hand-rolled JSON-RPC 2.0 client, no `initialize` assumed
- [x] `probeServerEra` — implements the spec's own 3-outcome `server/discover` detection algorithm
- [x] `@crucible/fixture-stateless-server` — hand-rolled server for the new era, with `CRUCIBLE_BREAK` modes
- [x] Modern checks: `discoverConformance`, `statelessToolsListConformance` (both version-gated)
- [x] CLI auto-detects era and runs the matching check family; `--format json` for CI
- [x] 18 tests total, including true-positive *and* true-negative coverage for every new check
- [x] Streamable HTTP transport + its header requirements (SEP-2243) — delivered in Phase 4, below
- [x] `io.modelcontextprotocol/tasks` extension conformance — delivered in Phase 5, below (core flow only)
- [ ] MRTR (`input_required`) round-trip conformance — accepted as valid, not yet exercised end to end

**Phase 3 — chaos/resilience engine (stdio, 2 scenarios)**
- [x] `@crucible/chaos` — four-tier verdict system (resilient/degraded/hung/crashed)
- [x] `malformedJsonResilience`, `unknownMethodResilience`, both era-agnostic
- [x] `RawJsonRpcClient` extended with raw writes, unmatched-response handling, and liveness tracking
- [x] `fixture-stateless-server` grew 3 chaos-specific `CRUCIBLE_BREAK` modes so all
      four verdicts have a real, end-to-end positive case, not just "resilient"
- [x] CLI: `crucible chaos -- <command>`, era-agnostic, `--format json` supported
- [x] A real finding, rigorously verified before being stated as one: see [`FINDINGS.md`](./FINDINGS.md)
- [x] 29 tests total

**Phase 4 — Streamable HTTP transport**
- [x] `Target` discriminated union (stdio | http) replaces the stdio-only shape,
      across `McpHarness` and `RawJsonRpcClient`
- [x] `McpHarness` over HTTP via the official SDK's `StreamableHTTPClientTransport`
- [x] `RawJsonRpcClient` over HTTP: hand-rolled POST with the draft spec's required
      headers (`Mcp-Method`, `MCP-Protocol-Version`), single-JSON-response only (no SSE)
- [x] `httpHeaderConformance` — proves a server actually rejects a mismatched
      `Mcp-Method` header, not just that it works when nothing's wrong
- [x] Both fixtures grew an `httpServer.ts` entry point alongside the existing
      stdio one, sharing the same business logic (`createEchoServer()` /
      `handlers.ts`) so the two transports can't quietly drift apart
- [x] CLI: `crucible scan <url>` alongside `crucible scan -- <command>`
      (`chaos` stays stdio-only for now, and says so clearly if you try otherwise)
- [x] 36 tests total, including real background-process smoke tests in CI,
      not just in-process ones
- [x] `Mcp-Name` header conformance — delivered in Phase 5, below (for `tools/call` / `tasks/get`)
- [ ] SSE response mode, chaos-testing over HTTP — still deferred, see `docs/architecture.md`

**Phase 5 — Tasks extension (SEP-2663) core flow**
- [x] `tools/call` implemented for the first time (`echo`, and the new task-augmentable `slow_echo`)
- [x] `tasks/get` create-and-poll flow: `CreateTaskResult` (`resultType: "task"`) →
      poll → terminal `GetTaskResult` (`resultType: "complete"`)
- [x] `taskCreationConformance`, `taskCapabilityConformance` — the second proves a server
      doesn't create a task for a client that never declared support
- [x] `Mcp-Name` header support (SEP-2243) for `tools/call` and `tasks/get`
- [x] `createDispatcher()` — per-server-instance task store, replacing a bare module-level
      dispatch function, so tests creating multiple server instances don't leak task state between them
- [x] A real bug fixed in already-shipped code, found by reading the spec before building on
      it: `resultType` is an open string union (`"complete" | "input_required" | string`), not
      limited to two literals — Tasks' `resultType: "task"` would have failed conformance
      against Crucible's own check. Fixed in its own commit, own regression test, before this
      phase's feature work — see `docs/architecture.md`
- [x] 40 tests total
- [ ] `tasks/update`, `tasks/cancel`, `notifications/tasks`, TTL expiry, the stable
      (2025-11-25) version of Tasks — all deferred, see `docs/architecture.md`

**Later phases**
- [ ] Phase 6: LLM-assisted adversarial test-case generation (needs an Anthropic API key
      wired into wherever this runs — not available while building this, see `docs/architecture.md`)
- [ ] Phase 7: report dashboard + shareable badge
- [ ] Phase 8: GitHub Action, SARIF export, case studies against real open-source
      MCP servers (with permission)

## Quickstart

```bash
npm install
npm run build
npm run scan:basic       # legacy (initialize-based) fixture, over stdio
npm run scan:stateless   # modern (draft 2026-07-28, discover-based) fixture, over stdio - includes Tasks
node packages/cli/dist/index.js chaos -- node packages/fixtures/stateless-server/dist/index.js
npm test                 # 40 tests: unit + real end-to-end integration, every era/transport/scenario
```

Or over real Streamable HTTP, in two terminals:

```bash
# terminal 1
npm run serve:stateless-http    # listens on :8080

# terminal 2
node packages/cli/dist/index.js scan http://localhost:8080/
```

Try breaking the modern fixture on purpose, and watch Crucible catch it:

```bash
CRUCIBLE_BREAK=bad-cache-scope npm run build \
  && node packages/cli/dist/index.js scan --format json \
     -- env CRUCIBLE_BREAK=bad-cache-scope node packages/fixtures/stateless-server/dist/index.js
```

Or watch the Tasks extension get caught returning a task nobody asked for:

```bash
node packages/cli/dist/index.js scan --format json \
  -- env CRUCIBLE_BREAK=task-without-capability node packages/fixtures/stateless-server/dist/index.js
```

## Repository layout

```
packages/
  core/                low-level MCP connections: McpHarness (SDK-based) and
                        RawJsonRpcClient + probeServerEra (hand-rolled), both
                        over stdio or Streamable HTTP via the shared Target type
  conformance/         spec-referenced checks + the engines that run them
                        (legacy checks in checks/, modern checks in modern/,
                        including the HTTP-only httpHeaderConformance and the
                        Tasks extension checks)
  chaos/               fault-injection scenarios + four-tier resilience scoring
                        (stdio only for now - see docs/architecture.md)
  cli/                 `crucible` command-line tool (scan, chaos)
  fixtures/
    basic-server/       well-behaved legacy (SDK-based) reference server -
                         index.ts (stdio) and httpServer.ts (HTTP) share
                         createEchoServer.ts
    stateless-server/   well-behaved modern (hand-rolled) reference server -
                         index.ts (stdio) and httpServer.ts (HTTP) share
                         handlers.ts (including the Tasks extension's
                         tools/call + tasks/get), each with their own
                         CRUCIBLE_BREAK modes
docs/
  architecture.md       design decisions: the two-protocol-era split, the
                         chaos engine's verdict system, the HTTP transport
                         design, the Tasks extension
FINDINGS.md             primary-source-verified conformance/robustness findings
```

## License

MIT - see [LICENSE](./LICENSE).
