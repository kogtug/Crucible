# Crucible

**A conformance and resilience testing harness for the Model Context Protocol (MCP).**

Crucible connects to an MCP server, runs it through a battery of spec-referenced
conformance checks, and (from Phase 3 onward) deliberately injects protocol-level
faults to see whether clients degrade safely or fail silently. Think of it as
`npm audit` crossed with chaos engineering, aimed specifically at the MCP wire
protocol rather than at malicious tool content.

## Why this project, why now

MCP is mid-way through the largest revision to its specification since launch:
the release candidate is out now, and the final spec lands **2026-07-28**. It
introduces a stateless protocol core, an async `Tasks` lifecycle, `Server Cards`
for capability discovery, and tighter OAuth-based authorization. SDK maintainers
have roughly a ten-week window to validate against it — which means almost none
of the existing MCP tooling ecosystem (security scanners, chaos-testing tools,
observability platforms) yet has anything that checks whether a server or client
correctly implements *these specific new primitives*. That gap is what Crucible
targets.

This is deliberately **not** another MCP security scanner (tool-poisoning /
prompt-injection detection is already well served by tools like MCP-Scan,
mcp-audit, and several others) and **not** another generic agent chaos-testing
framework (see `agent-chaos`, Cordum). Crucible is scoped narrowly to protocol
*correctness and resilience* against the newest spec surface.

## Status: Phase 1 (walking skeleton)

- [x] Monorepo scaffold (npm workspaces + TypeScript project references)
- [x] `@crucible/core` — stdio harness wrapping the official MCP SDK client
- [x] `@crucible/fixture-basic-server` — a minimal, well-behaved reference server
- [x] `@crucible/conformance` — engine + 2 checks (handshake, `tools/list` schema)
- [x] `@crucible/cli` — `crucible scan -- <command>`
- [x] Automated test suite (unit tests for the engine + a real end-to-end
      integration test against the fixture server), wired into CI
- [ ] Phase 2: Streamable HTTP transport, new-spec checks (stateless headers,
      Server Cards, cache `ttlMs`), a family of deliberately-broken fixture servers
- [ ] Phase 3: chaos/fault-injection engine + client resilience scoring
- [ ] Phase 4: LLM-assisted adversarial test-case generation
- [ ] Phase 5: report dashboard + shareable badge
- [ ] Phase 6: GitHub Action, SARIF export, case studies against real open-source
      MCP servers (with permission)

See `docs/architecture.md` (coming with Phase 2) for the full design.

## Quickstart

```bash
npm install
npm run build
npm run scan:basic   # spawn the fixture server and scan it
npm test             # unit tests + a real end-to-end integration test
```

## Repository layout

```
packages/
  core/          low-level MCP connection harness
  conformance/   spec-referenced checks + the engine that runs them
  cli/           `crucible` command-line tool
  fixtures/      reference MCP servers used as scan targets in tests/demos
```

## License

MIT - see [LICENSE](./LICENSE).
