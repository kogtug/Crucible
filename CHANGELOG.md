# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/), adapted for a
pre-1.0 project organized by development phase rather than semver
releases - `README.md`'s status table is the authoritative, always
-current breakdown of what's done and what's deferred; this file is the
narrative history of how it got there.

## Phase 5 — Tasks extension (SEP-2663)

### Added
- `tools/call` (first implementation) and `tasks/get` on the stateless
  fixture, with a genuine async create-and-poll flow.
- `taskCreationConformance`, `taskCapabilityConformance`.
- `Mcp-Name` header support (SEP-2243), for `tools/call` and `tasks/get`.
- `createDispatcher()`, replacing a bare module-level dispatch function,
  giving each server instance its own Tasks task store.

### Fixed
- `validateCacheableResult` rejected any `resultType` other than
  `"complete"` or `"input_required"` - the type is actually an open
  string union (`"complete" | "input_required" | string`) specifically
  so extensions like Tasks can define their own values (`"task"`). Found
  by re-reading the schema before building Tasks support on top of the
  same function; would have failed every correctly-implemented task.

## Phase 4 — Streamable HTTP transport

### Added
- `Target` (stdio | http), replacing the stdio-only `TargetServerCommand`
  across `McpHarness` and `RawJsonRpcClient`.
- `RawJsonRpcClient` HTTP support: hand-rolled POST with the draft spec's
  required headers, single-JSON-response only (no SSE).
- `httpHeaderConformance`.
- HTTP entry points (`httpServer.ts`) for both fixtures, sharing business
  logic with their existing stdio entry points.
- `crucible scan <url>`.

### Fixed
- A module-level `CRUCIBLE_BREAK` constant, read once at import time,
  silently broke in-process tests that constructed the HTTP fixture more
  than once with different break modes in the same process. Fixed by
  taking the break mode as an explicit parameter instead.

## Phase 3 — Chaos/resilience engine

### Added
- `@crucible/chaos`: four-tier verdict (resilient/degraded/hung/crashed)
  instead of pass/fail.
- `malformedJsonResilience`, `unknownMethodResilience`, both era-agnostic.
- `RawJsonRpcClient` gained raw writes, unmatched-response handling, and
  liveness tracking.
- `crucible chaos -- <command>`.
- Three fixture break modes (`crash-on-malformed`, `hang-on-unknown-method`,
  `freeze-on-unknown-method`) so all four verdicts have a real positive case.

### Findings
- The official SDK's stdio transport doesn't respond with a JSON-RPC
  parse error for malformed input - a real, reproducible robustness gap,
  rigorously verified against JSON-RPC 2.0, the MCP spec, and the SDK's
  own source before being stated as a finding. **Not** a confirmed
  specification violation - see `FINDINGS.md` for the full analysis.

## Phase 2 — The draft 2026-07-28 primitives

### Added
- `RawJsonRpcClient`, hand-rolled JSON-RPC 2.0, no `initialize` assumed.
- `probeServerEra`, implementing the spec's own 3-outcome `server/discover`
  detection algorithm.
- `fixture-stateless-server`, hand-rolled (the official SDK doesn't speak
  this protocol era yet), with its first `CRUCIBLE_BREAK` modes.
- `discoverConformance`, `statelessToolsListConformance`.
- CLI auto-detects protocol era and dispatches to the matching check
  family; `--format json`.

### Corrected
- Described the draft spec's discovery mechanism as "Server Cards," based
  on secondary sources. That term doesn't appear anywhere in the actual
  spec - the real mechanism is a JSON-RPC method, `server/discover`.
  Corrected once the spec repo itself was cloned and read directly.

## Phase 1 — Walking skeleton

### Added
- npm workspaces monorepo, TypeScript project references throughout.
- `@crucible/core`: `McpHarness`, a thin wrapper around the official SDK.
- `@crucible/fixture-basic-server`: a minimal, well-behaved reference
  server.
- `@crucible/conformance`: `handshakeConformance`, `toolsListSchema`.
- `@crucible/cli`: `crucible scan -- <command>`.
- CI, MIT license, initial README.
