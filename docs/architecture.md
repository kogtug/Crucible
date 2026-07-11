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
- **SEP-2243** - required `Mcp-Method` / `Mcp-Name` headers on Streamable HTTP (not yet implemented - see Deferred, below).

## Deferred, on purpose

- **Streamable HTTP transport**, and the `Mcp-Method` / `Mcp-Name` header
  requirements that only apply to it (SEP-2243). Deferred again, now to
  Phase 4: everything through Phase 3 turned out to be fully exercisable
  over stdio (the chaos engine's two scenarios included), so there was
  never a forcing function to take on an HTTP transport implementation
  just to hit a roadmap checkbox. It's still coming - dropped connections
  and malformed headers are exactly the kind of thing the chaos engine
  should eventually cover - just not before it earns its place with a
  scenario that actually needs it.
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
