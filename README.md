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
- [ ] Streamable HTTP transport + its header requirements (SEP-2243) — deferred, see `docs/architecture.md`
- [ ] `io.modelcontextprotocol/tasks` extension conformance — deferred
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

**Later phases**
- [ ] Phase 4: LLM-assisted adversarial test-case generation; Streamable HTTP transport;
      `io.modelcontextprotocol/tasks` extension conformance (deferred from Phase 2, see `docs/architecture.md`)
- [ ] Phase 5: report dashboard + shareable badge
- [ ] Phase 6: GitHub Action, SARIF export, case studies against real open-source
      MCP servers (with permission)

## Quickstart

```bash
npm install
npm run build
npm run scan:basic       # legacy (initialize-based) fixture
npm run scan:stateless   # modern (draft 2026-07-28, discover-based) fixture
node packages/cli/dist/index.js chaos -- node packages/fixtures/stateless-server/dist/index.js
npm test                 # 29 tests: unit + real end-to-end integration, all eras and scenarios
```

Try breaking the modern fixture on purpose, and watch Crucible catch it:

```bash
CRUCIBLE_BREAK=bad-cache-scope npm run build \
  && node packages/cli/dist/index.js scan --format json \
     -- env CRUCIBLE_BREAK=bad-cache-scope node packages/fixtures/stateless-server/dist/index.js
```

## Repository layout

```
packages/
  core/                low-level MCP connections: McpHarness (SDK-based) and
                        RawJsonRpcClient + probeServerEra (hand-rolled)
  conformance/         spec-referenced checks + the engines that run them
                        (legacy checks in checks/, modern checks in modern/)
  chaos/               fault-injection scenarios + four-tier resilience scoring
  cli/                 `crucible` command-line tool (scan, chaos)
  fixtures/
    basic-server/       well-behaved legacy (SDK-based) reference server
    stateless-server/   well-behaved modern (hand-rolled) reference server,
                         with CRUCIBLE_BREAK modes for regression testing
docs/
  architecture.md       design decisions, including the two-protocol-era split
                         and the chaos engine's verdict system
FINDINGS.md             primary-source-verified conformance/robustness findings
```

## License

MIT - see [LICENSE](./LICENSE).
