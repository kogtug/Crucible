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
| Connection | `McpHarness` (`packages/core/harness.ts`), wraps the official SDK | `RawJsonRpcClient` (`packages/core/rawClient.ts`), hand-rolled |
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

`probeServerEra()` (`packages/core/probe.ts`) implements the exact algorithm
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

## SEPs this phase implements against

- **SEP-2567** - stateless core: no protocol-level sessions, no `Mcp-Session-Id`.
- **SEP-2575** - removes `initialize`; adds per-request `_meta` versioning and `server/discover`.
- **SEP-2549** - `CacheableResult`: required `ttlMs` + `cacheScope` on list/read results.
- **SEP-2322** - required `resultType` on every result; Multi Round-Trip Requests.
- **SEP-2243** - required `Mcp-Method` / `Mcp-Name` headers on Streamable HTTP (not yet implemented - see Deferred, below).

## Deferred, on purpose

- **Streamable HTTP transport**, and the `Mcp-Method` / `Mcp-Name` header
  requirements that only apply to it (SEP-2243). Everything implemented so
  far is transport-agnostic (stdio proves it fine), which let Phase 2 ship
  real, tested conformance checks without also taking on an HTTP transport
  implementation in the same milestone. Planned for the phase that adds the
  chaos engine, since fault injection is where transport-level behavior
  (dropped connections, malformed headers) actually matters most.
- **The `io.modelcontextprotocol/tasks` extension.** Genuinely async task
  polling is a bigger surface than one milestone's worth, and the official
  SDK marks its own experimental Tasks support as unstable right now - this
  needs more of the spec text than the discovery/caching rules did, and
  deserves its own milestone rather than a rushed check.
- **MRTR (`InputRequiredResult`) conformance.** `validateCacheableResult`
  already accepts `resultType: "input_required"` as valid, but nothing yet
  exercises the actual multi-round-trip retry flow end to end.
