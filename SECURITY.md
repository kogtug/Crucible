# Security Policy

Crucible is a testing tool, not a service that handles production traffic
or credentials, but it's about protocol security and correctness, so its
own dependency hygiene should hold to the same bar it tests other servers
against.

## Reporting a vulnerability

Open an issue, or - if it's sensitive enough that it shouldn't be public
before a fix lands - use GitHub's private vulnerability reporting on this
repository.

## Current dependency audit status

As of the last review (`npm audit`, re-checked whenever dependencies are
touched):

- **`fast-uri` (high)** - fixed via `npm audit fix`, no breaking changes.
- **`@hono/node-server` < 2.0.5 (moderate)** - [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9),
  a path-traversal issue in its `serve-static` middleware on Windows, via
  an encoded backslash in a request path. This is a transitive dependency
  of `@modelcontextprotocol/sdk` (currently `1.29.0`, the latest
  published version - there is no newer release that resolves this yet).

  **Assessed, not exploitable through Crucible's own usage**: grepping the
  installed SDK's source for `serveStatic` / `serve-static` turns up no
  references - the SDK depends on `@hono/node-server` for its underlying
  Node-to-Hono HTTP adapter (used by `StreamableHTTPServerTransport`), not
  for static file serving, and Crucible's fixtures never serve static
  files or directories through it. The vulnerable code path ships in
  `node_modules` because npm installs the whole package, but nothing in
  this dependency chain calls it.

  `npm audit fix --force` "fixes" this today only by downgrading
  `@modelcontextprotocol/sdk` to `1.24.3`, which doesn't patch the
  transitive dependency - it just resolves to a version tree where the
  audit tool doesn't flag it, and would mean testing against an older SDK
  than the one this project has actually verified everything against.
  Downgrading for an unexploited path in unused code is a worse trade than
  documenting the exposure and revisiting it once the SDK ships a version
  that updates past the vulnerable range.

This assessment gets revisited every time `npm install` reports a new
finding, not left to go stale - a `grep` that comes back empty today isn't
guaranteed to stay that way through a dependency bump.
