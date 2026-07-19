# FINDINGS.md

## Summary

Crucible's `malformed-json-resilience` chaos scenario observed that
`@modelcontextprotocol/sdk`'s `StdioServerTransport` does not send a
JSON-RPC error response when it receives a line on stdin that fails to
parse as JSON. Before treating this as a spec violation anywhere in this
repo's docs, code, or commit history, I went back to primary sources rather
than assuming. Verdict: **not a confirmed specification violation** - the
spec is more silent on this exact scenario than my first-draft framing
implied - but it **is** a real, reproducible gap relative to both
JSON-RPC 2.0's own convention and the plain-language expectation set by
MCP's base protocol docs. Full reasoning below.

## Reproduction steps

```bash
# From the crucible repo root, after `npm install && npm run build`:
node -e '
  const { spawn } = require("child_process");
  const p = spawn("node", ["packages/fixtures/basic-server/dist/index.js"]);
  p.stdout.on("data", (d) => console.log("STDOUT:", d.toString()));
  p.stdin.write("{\"jsonrpc\": \"2.0\", \"id\": 1, method: tools/list, not valid json}\n");
  setTimeout(() => { console.log("no response arrived within 2s"); p.kill(); }, 2000);
'
```

Or, using Crucible itself:

```bash
node packages/cli/dist/index.js chaos -- node packages/fixtures/basic-server/dist/index.js
```

Both reliably reproduce: no bytes are written to stdout in response to the
malformed line, and the process remains alive and otherwise responsive
(confirmed by a follow-up `server/discover` call succeeding immediately
after).

## Expected behavior, with exact citations

**JSON-RPC 2.0** (jsonrpc.org/specification), Section 5, "Response object":

> When a rpc call is made, the Server MUST reply with a Response, except
> for in the case of Notifications.

Section 7 ("Examples") shows this applied to malformed input specifically:

```
--> {"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]
<-- {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": null}
```

And Section 6 ("Batch") contains the one place the spec is unambiguously
explicit about a parse failure specifically: _"If the batch rpc call itself
fails to be recognized as \[a\] valid JSON or as an Array with at least one
value, the response from the Server MUST be a single Response object"_ (a
-32700 error).

**MCP base protocol** (`docs/specification/2025-11-25/basic/index.mdx`,
"Error Responses"):

> Error responses **MUST** include the same ID as the request they
> correspond to (except in error cases where the ID could not be read due
> a malformed request).

This line only makes sense if a malformed request is expected to produce an
error response in the first place - it's specifying which `id` to use in
that case, not whether to reply at all. That's the strongest MCP-level
textual support for "yes, reply."

**MCP stdio transport** (`docs/specification/2025-11-25/basic/transports.mdx`):

> The server **MUST NOT** write anything to its `stdout` that is not a
> valid MCP message. The client **MUST NOT** write anything to the
> server's `stdin` that is not a valid MCP message.

This is the line I originally (and imprecisely) cited as the spec backing
for this scenario. On a close re-read, it is a constraint on _what a
server emits_ (never anything invalid) and _what a well-behaved client
sends_ - it does not say what a server must do upon _receiving_ something
invalid. Silence is not "an invalid message," so responding with nothing
does not, by itself, violate this line. Using it as the specRef for "the
server should have replied" was imprecise, and I've corrected it in code
(see "What changed in this repo," below). It's also worth noting explicitly
that Crucible's own scenario has the client (Crucible) deliberately
violating this exact clause by design, since fault injection requires
sending input a compliant client wouldn't - that's the nature of chaos
testing, not an oversight.

## Actual behavior, and why (verified against SDK source, not just its types)

Traced directly in the installed package
(`node_modules/@modelcontextprotocol/sdk`, version confirmed below):

`shared/stdio.js`:

```js
export function deserializeMessage(line) {
  return JSONRPCMessageSchema.parse(JSON.parse(line));
}
```

No try/catch here - a malformed line throws a plain `SyntaxError` out of `JSON.parse`.

`server/stdio.js`, `processReadBuffer()`:

```js
processReadBuffer() {
    while (true) {
        try {
            const message = this._readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
        }
        catch (error) {
            this.onerror?.(error);   // <- caught here, nothing sent to the client
        }
    }
}
```

`shared/protocol.js` wires that `onerror` up to the `Protocol`/`Server`
class's own `onerror`, which is itself just an optional, user-settable
callback (`this.onerror?.(error)`) - there is no default handler anywhere
in this chain that constructs and sends a `-32700` response. Unless the
application using the SDK sets `server.onerror` itself and manually sends
one, nothing goes back over the wire. This is a complete explanation, not
a guess: I read the exact three files involved rather than inferring from
the failure alone.

## Affected version

`@modelcontextprotocol/sdk@1.29.0` (latest at time of writing; confirmed via
`npm view @modelcontextprotocol/sdk dist-tags` and by downloading and
reading this exact package, not an older cached copy).

## Related upstream issue (this is not a novel discovery)

[`modelcontextprotocol/typescript-sdk#244`](https://github.com/modelcontextprotocol/typescript-sdk/issues/244)
reports the same code path from the opposite direction: a server author's
stray `console.log()` inside a tool handler writes a plain-text line to
stdout, and the _client's_ `deserializeMessage` throws the same unguarded
`SyntaxError` trying to parse it. A maintainer's reply frames that
specific case as a server-authoring mistake (use `console.error()` /
stderr for logging, per the docs) rather than committing to change
`deserializeMessage` itself.

That framing doesn't fully cover Crucible's scenario, though: #244 is about
a well-behaved client receiving accidentally-malformed output from a
server the developer controls. Crucible's scenario is about a server
receiving deliberately-malformed input from a client it does _not_
control - which is exactly the situation where automatically returning a
well-formed `-32700` matters most, since "fix your own code" isn't an
available remedy against someone else's client. I'm treating this as a
related-but-distinct angle on the same root cause, not a duplicate.

## Impact

Low-to-moderate, and narrow in scope. This does not crash the process, leak
data, or affect any other capability - the server (confirmed via the
follow-up liveness probe) continues functioning normally afterward. The
practical impact is entirely on observability: a client (or a proxy,
gateway, or logging layer sitting in front of one) that sends a genuinely
malformed line - due to its own bug, a transport-level corruption, or a
deliberate probe - gets silence instead of a diagnosable `-32700`,
indistinguishable from a request that was simply dropped for some other
reason.

## Confidence level

- **Low** confidence this is a clean, letter-of-the-law specification
  violation. Both JSON-RPC 2.0 and MCP are genuinely under-specified for
  this exact scenario (input that never becomes a parseable message at
  all), as opposed to the batch case, which JSON-RPC 2.0 addresses
  explicitly.
- **Medium-high** confidence this is a real robustness/observability gap
  worth fixing regardless of the letter-of-the-law question - it diverges
  from JSON-RPC 2.0's own worked example, from the plain-language
  implication of MCP's "Error Responses" section, and from what every
  secondary JSON-RPC reference I checked describes as standard practice.
- **Not confirmed** as a deliberate design choice - I found no maintainer
  comment or changelog entry defending this behavior specifically (as
  distinct from the #244 thread, which is about a different scenario). A
  plausible rationale exists (keep the raw transport minimal, route all
  error presentation through the optional `onerror` hook), but "plausible"
  is not "confirmed," and I'm not asserting intent I can't back up.

## Should an upstream issue be opened?

Not a new one. #244 already covers the root cause (the unguarded
`JSON.parse` in `deserializeMessage`) even though it approaches it from the
client-receiving-bad-server-output direction rather than the
server-receiving-bad-client-input direction this scenario tests. If this
comes up again once Crucible has a cleaner writeup (e.g. after Phase 3's
scenario library grows), the better move is a comment on #244 connecting
the two angles, not a duplicate issue.

## What changed in this repo as a result

- `packages/chaos/src/scenarios/malformedJson.ts`'s `specRef` no longer
  cites the stdio transport's "MUST NOT write invalid output" line, since
  that line constrains emission, not a server's reaction to malformed
  input - it now cites JSON-RPC 2.0's Section 5 and the worked example in
  Section 7, which is what the check actually scores against.
- The scenario's result message now says "not spec-correct" only in the
  sense of "diverges from JSON-RPC 2.0's documented convention," not "the
  MCP specification is violated" - matching the confidence levels above.
- This file. Findings like this get written down, not folded quietly into
  a commit message.
