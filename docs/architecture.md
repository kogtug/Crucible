# Architecture

## Two protocol eras

MCP's draft spec (targeting final release 2026-07-28) removes the `initialize`
handshake entirely and replaces it with per-request `_meta` fields plus an
optional `server/discover` probe. That is a genuine fork in how a client has
to talk to a server, not just new fields bolted onto the old flow - so
Crucible has two parallel implementations rather than one that awkwardly
branches partway through:

| | Legacy (protocol versions through 2025-11-25) | Modern (draft, 2026-07-28) |
|---|---|---|
| Connection | `McpHarness` (`packages/core/src/harness.ts`), wraps the official SDK | `RawJsonRpcClient` (`packages/core/src/rawClient.ts`), hand-rolled |
| Handshake | `initialize` / `notifications/initialized` | none - version/identity ride in `_meta` on every request |
| Discovery | N/A | `server/discover` |
| Checks | `packages/conformance/src/checks/*`, run by `runChecks` | `packages/conformance/src/modern/checks/*`, run by `runModernChecks` |
| Reference fixture | `fixture-basic-server` (built on the SDK) | `fixture-stateless-server` (hand-rolled - the SDK doesn't speak this era yet) |

`@crucible/core` exports both connection types rather than one generic
abstraction over both, on purpose. A generic that has to cover "sometimes
there's a handshake, sometimes there isn't; sometimes discovery is a method
call, sometimes it doesn't exist" tends to either leak both models through
its interface anyway, or hide details a conformance tool specifically needs
to see. Two small, honest classes beat one blurry one.

## Detecting which era a target speaks

`probeServerEra()` (`packages/core/src/probe.ts`) implements the exact algorithm
in the draft spec's stdio transport page ("Backward Compatibility"):

1. Send `server/discover` with the preferred version in `_meta`.
2. A valid `DiscoverResult` comes back -> **modern**. Negotiate a mutually
   supported version from `supportedVersions`.
3. A `-32022 UnsupportedProtocolVersionError` comes back -> **modern, but
   wrong version**. The spec is explicit that a client must not fall back to
   `initialize` in this case - the server has already identified itself as
   modern, it just doesn't support the version we asked for.
4. Any other error, or no response before a timeout -> **legacy**. Fall back
   to `initialize`.

The CLI's `scan` command runs this probe once per target. On a modern
result, it keeps using that same connection for the modern checks. On a
legacy result, it closes that connection and opens a fresh one through
`McpHarness` - the SDK's `Client` owns its transport from the first byte and
can't adopt a socket that already had raw, non-`initialize` traffic on it,
so two small connections is simpler and safer than one connection handed
between two different client implementations.

Version comparison (`protocolVersionAtLeast`) is plain string comparison.
MCP protocol versions are zero-padded ISO dates (`"2026-07-28"`), and
lexicographic order on strings of that exact shape is chronological order,
so there's no reason to pull in a date-parsing dependency for this.

## HTTP transport

Both connection types (`McpHarness`, `RawJsonRpcClient`) now take a
`Target` (`packages/core/src/target.ts`) instead of a stdio-only
`TargetServerCommand`:

```ts
type Target =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "http"; url: string };
```

This replaced `TargetServerCommand` everywhere rather than living alongside
it, once a second transport needed describing - a discriminated union says
"a target is a command or a URL, never partially either" in a way two
independent shapes with optional fields wouldn't. The CLI decides which
kind to build from its own argument: a single argument matching
`^https?://` is an HTTP target, anything else is a stdio command
(`parseTarget()` in `packages/cli/src/index.ts`), so `crucible scan --
node server.js` and `crucible scan http://localhost:8080/mcp` both just
work.

`McpHarness`'s HTTP support is exactly one line of real work - swap in the
official SDK's `StreamableHTTPClientTransport` for `StdioClientTransport` -
because the SDK's `Client` already speaks both identically. `RawJsonRpcClient`'s
is more involved, since it has no SDK to lean on: `request()` now branches
on `target.kind`, and the HTTP path POSTs a single JSON-RPC message with
the headers the draft spec requires (`Content-Type`, `Accept`,
`Mcp-Method`, `MCP-Protocol-Version`) and reads back a single
`application/json` response - no SSE handling, see "Deferred, on purpose".
The chaos-specific methods (`writeRawLine`, `waitForNextRawResponse`) throw
a clear error for HTTP targets rather than pretending to support them; only
`request()` needed to work for every conformance check to work over either
transport.

**`httpHeaderConformance`** (`packages/conformance/src/modern/checks/httpHeaders.ts`)
is a different shape of check from `discoverConformance` and
`statelessToolsListConformance`: those two call the target normally and
grade the response. This one deliberately sends a `tools/list` request with
an `Mcp-Method` header that doesn't match its own body (via `RawRequestOptions.headerOverrides`,
added for exactly this) and checks that the server rejects it with a
-32020 `HeaderMismatch` - proving the server enforces the rule, not just
that it behaves when nothing violates it. It reports `warn` for stdio
targets, where the check doesn't apply at all, the same pattern
`toolsListSchema` already used in Phase 1 for a server that doesn't
advertise the `tools` capability.

Both fixtures grew an HTTP entry point (`httpServer.ts`) alongside the
existing stdio one (`index.ts`), each importing the same business logic
rather than reimplementing it - `fixture-basic-server`'s two entry points
share `createEchoServer()`; `fixture-stateless-server`'s share
`handlers.ts`. `stateless-server`'s HTTP entry point also grew its own
break mode, `CRUCIBLE_BREAK=skip-header-validation`, so
`httpHeaderConformance` has a genuine server that gets the check wrong to
fail against, not just one that gets it right - the same true-positive
-and-true-negative discipline every other check in this repo follows. Both
`httpServer.ts` files export a factory function (`createStatelessHttpServer(breakMode?)`,
`createEchoHttpServer()`) that tests call directly and `.listen(0)` for an
OS-assigned port, rather than spawning a child process and polling for
readiness - and are also runnable standalone (`node dist/httpServer.js`,
respecting a `PORT` env var) for manual use and for real end-to-end CI
smoke tests against a genuine background process, not just an in-process
one. `createStatelessHttpServer` takes its break mode as an explicit
parameter defaulting to `process.env.CRUCIBLE_BREAK`, rather than reading
the environment variable into a module-level constant - the latter was
the first version, and it broke silently the first time a test tried to
create two servers with different break modes in the same process, since
the constant had already been fixed at import time. Found by testing that
exact scenario, not by inspection.

## Why the fixture servers are built differently

`fixture-basic-server` is built on `@modelcontextprotocol/sdk` because
that's what most real MCP servers look like today, and Phase 1's checks
need a target that behaves like one. `fixture-stateless-server` is
hand-rolled JSON-RPC because, as of SDK 1.29.0, the SDK has no concept of
`server/discover`, per-request `_meta` versioning, or the `resultType` /
`ttlMs` / `cacheScope` fields - there is nothing to build the "modern"
fixture on top of yet. Both fixtures support a `CRUCIBLE_BREAK=<mode>`
environment variable that deliberately violates one specific rule, so every
new check has both a positive and a negative test (`packages/conformance/src/modern/integration.test.ts`)
rather than only ever being exercised against a well-behaved target.

## A correction, made honestly

Phase 1's README described the draft spec's discovery mechanism as
"Server Cards," based on secondary (blog) sources. Having since cloned
`modelcontextprotocol/modelcontextprotocol` and read the actual schema and
changelog, that terminology doesn't appear anywhere in the primary source.
The real mechanism is a JSON-RPC method, `server/discover` (SEP-2575), not
an HTTP `.well-known` document. That's now what this document and the code
both reflect. Leaving this note here rather than quietly editing history:
secondary sources got the shape of this one wrong, and it only surfaced by
going and reading the spec directly - which is exactly why Phase 2 started
with a `git clone` of the spec repo instead of more blog research.

## The chaos engine

`@crucible/chaos` sends a target deliberately adversarial input (not just
edge-case-but-valid input, which is what the conformance checks exercise)
and scores how it degrades, using four tiers rather than pass/fail:

- **resilient** - handled the fault correctly (or safely) and stayed
  responsive to a follow-up request afterward.
- **degraded** - still alive and responsive afterward, but the immediate
  reaction wasn't what convention calls for (e.g. silently swallowing bad
  input instead of erroring on it).
- **hung** - still alive, but stopped responding to *anything*, not just
  the fault - a genuinely different, worse failure mode than degraded.
- **crashed** - the process exited as a direct result of the input.

Every scenario ends by calling the same `classifyResilience()` helper
(`packages/chaos/src/liveness.ts`), which checks `isAlive()`, then probes
with a harmless `server/discover` call to distinguish "hung" from
"degraded," then folds in whatever the scenario itself observed about the
immediate reaction. Centralizing that logic means every scenario's notion
of "resilient" is consistent, rather than each one inventing its own bar -
the same reasoning behind the conformance engines sharing
`validateCacheableResult` in Phase 2.

`runChaosScenarios` itself is now a thin wrapper around `@crucible/core`'s
`runEngine` - see "One loop, three engines" below.

Both scenarios connect via `RawJsonRpcClient` directly, with no
`server/discover` era-probe first, unlike `scan`. Malformed JSON and
unrecognized methods are meaningful regardless of which protocol era a
target speaks, so `chaos` doesn't need to know that going in - it works
against `fixture-basic-server` (legacy) and `fixture-stateless-server`
(modern) equally, which the test suite proves directly.

All four verdicts are exercised end to end against real fixtures, not just
unit-tested against fakes - `fixture-stateless-server` grew three
chaos-specific `CRUCIBLE_BREAK` modes (`crash-on-malformed`,
`hang-on-unknown-method`, `freeze-on-unknown-method`) specifically so
"crashed," "degraded," and "hung" each have a genuine positive case to
prove against, not just "resilient."

**A real finding surfaced immediately**: running `chaos` against
`fixture-basic-server` (built entirely on the official SDK) reports the
malformed-JSON scenario as "degraded," not "resilient." See
[`FINDINGS.md`](../FINDINGS.md) for the full verification against JSON-RPC
2.0, the MCP spec, and the SDK's own source before that finding is stated
anywhere else in this repo - short version, it's a real, reproducible
robustness gap, but explicitly **not** a confirmed spec violation, and
there's a related (not duplicate) upstream issue already.

## One loop, three engines

By the time the chaos engine existed, `@crucible/conformance`'s legacy and
modern engines and `@crucible/chaos`'s engine all contained the exact same
loop: iterate a list of check-like things, run each against a shared
context, catch anything that throws and turn it into a result instead of
aborting the whole run. Phase 2's architecture notes deliberately argued
*against* generalizing the legacy and modern engines together, on the
grounds that two instances of a pattern aren't enough to safely infer the
right generalization from. Three identical copies is a different claim -
at that point it's not a design choice being second-guessed, it's the same
code existing three times. `@crucible/core` now exports `runEngine`, a
small generic over the context type and the result type; each of the three
call sites kept everything that's actually specific to it (how its context
gets built, what a thrown error looks like as a Result) and lost nothing
but the copy-pasted loop. All 29 tests passed unmodified after the change,
which is itself the point: refactoring behavior-preserving duplication out
shouldn't require touching behavior, or the tests that pin it.

## SEPs this phase implements against

- **SEP-2567** - stateless core: no protocol-level sessions, no `Mcp-Session-Id`.
- **SEP-2575** - removes `initialize`; adds per-request `_meta` versioning and `server/discover`.
- **SEP-2549** - `CacheableResult`: required `ttlMs` + `cacheScope` on list/read results.
- **SEP-2322** - required `resultType` on every result; Multi Round-Trip Requests.
- **SEP-2243** - required `Mcp-Method` / `MCP-Protocol-Version` headers on Streamable HTTP, implemented in Phase 4 (`Mcp-Name`, which only applies to `tools/call` / `resources/read` / `prompts/get`, is still deferred - see below, none of Crucible's fixtures implement those methods yet).

## Deferred, on purpose

- **Streamable HTTP's SSE response mode.** Only the single-JSON-response
  path is implemented (see "HTTP transport", above) - a server MAY respond
  with an SSE stream instead, but nothing in this repo needs one yet (no
  long-running or subscription-style calls), so building it now would be
  speculative rather than driven by an actual check that needs it.
- **Chaos testing over HTTP.** `RawJsonRpcClient`'s HTTP path supports
  `request()` fully, but the chaos-specific primitives (`writeRawLine`,
  `waitForNextRawResponse`, a meaningful `isAlive()`) remain stdio-only.
  "Malformed input" means something different for a persistent stdio
  stream versus a single self-contained POST body, and that difference
  deserves its own design pass rather than a same-day retrofit.
- **`Mcp-Name` header conformance** (SEP-2243) - required only for
  `tools/call`, `resources/read`, and `prompts/get`, none of which any
  fixture in this repo implements yet. `httpHeaderConformance` covers
  `Mcp-Method` and `MCP-Protocol-Version`, which apply to every request.
- **The `io.modelcontextprotocol/tasks` extension.** Genuinely async task
  polling is a bigger surface than one milestone's worth, and the official
  SDK marks its own experimental Tasks support as unstable right now - this
  needs more of the spec text than the discovery/caching rules did, and
  deserves its own milestone rather than a rushed check.
- **MRTR (`InputRequiredResult`) conformance.** `validateCacheableResult`
  already accepts `resultType: "input_required"` as valid, but nothing yet
  exercises the actual multi-round-trip retry flow end to end.
- **Crucible's own resilience to a malformed server**, as opposed to a
  target server's resilience to malformed client input. `RawJsonRpcClient`
  currently just drops an unparseable line from a server rather than
  surfacing it distinctly (`packages/core/src/rawClient.ts`, in
  `onStdoutData`) - the same underlying gap as upstream issue
  `typescript-sdk#244`, just on Crucible's side of the connection instead
  of the SDK's. Noted, not yet fixed: the chaos engine's two current
  scenarios both test a *server's* resilience to a misbehaving client, not
  a client's resilience to a misbehaving server, so this hasn't had a
  scenario forcing the issue yet either.
