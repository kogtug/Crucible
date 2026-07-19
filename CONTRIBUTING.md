# Contributing to Crucible

Crucible is a conformance and resilience testing harness for the Model
Context Protocol. This document is about _how_ to work in this repo -
`README.md` covers what it is, `docs/architecture.md` covers why it's
built the way it is.

## Setup

```bash
git clone <this repo>
cd crucible
npm install
npm run build
npm test
```

Node >= 18 (CI runs 22). No API keys, no external services - every test
either runs in-process or spawns a fixture server this repo also owns.

## Everyday commands

| Command                                   | What it does                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                           | Builds every package via TypeScript project references                                                                                                                                                     |
| `npm test`                                | Full suite: unit + real end-to-end integration, every era/transport                                                                                                                                        |
| `npm run lint` / `npm run lint:fix`       | ESLint, type-aware, across `packages/`                                                                                                                                                                     |
| `npm run format` / `npm run format:check` | Prettier                                                                                                                                                                                                   |
| `npm run clean`                           | Removes `dist/` **and** `.tsbuildinfo` files together - removing only one leaves `tsc -b` convinced nothing changed, and it silently skips rebuilding (see `docs/architecture.md` for the debugging story) |

CI runs lint, format check, the full test suite, and several real
end-to-end smoke tests (stdio, HTTP, chaos, Tasks) on every push and PR.

## Before you open a PR

- `npm run lint && npm run format:check && npm test` all clean.
- If you touched a spec-referenced check or fixture, re-read the relevant
  section of the actual spec (`git clone` of
  `modelcontextprotocol/modelcontextprotocol` is the primary source this
  repo works from - not blog posts, not secondary summaries, including
  this one). `FINDINGS.md` and several commit messages in this repo's
  history exist specifically because a secondary source turned out to be
  wrong about something a primary-source re-read caught.
- If a fixture or check's behavior changed, check whether `docs/architecture.md`,
  the `README.md` status table, or a doc comment now describes something
  that's no longer true. Several past commits in this history exist
  purely to fix exactly this kind of drift - it's a normal, expected part
  of a change, not a separate cleanup pass to skip.

## The rule this whole repo follows: prove both directions

Every conformance check and chaos scenario in this repo is tested against
**a server that gets it right and a server that gets it wrong** - never
just the happy path. In practice, this means most new checks need a new
`CRUCIBLE_BREAK=<mode>` on one of the fixtures in `packages/fixtures/`
that violates the specific rule being checked, and nothing else. Search
either fixture's `src/index.ts` or `handlers.ts` for `CRUCIBLE_BREAK` to
see the existing pattern. A check that only ever sees a correct server
proves nothing - it would keep passing even if the check itself were
broken.

## Adding a new conformance check

1. Read the actual spec text for the rule (not a summary of it) and note
   the exact SEP / section you're implementing against.
2. Add a `CRUCIBLE_BREAK` mode to the relevant fixture that violates the
   rule, and only that rule - everything else about the fixture's
   response should stay correct, so the check is exercised in isolation.
3. Write the check (`packages/conformance/src/checks/` for the legacy,
   initialize-based family; `packages/conformance/src/modern/checks/` for
   the draft, discover-based one - see `docs/architecture.md`, "Two
   protocol eras," for which one applies).
4. Add it to `defaultChecks` / `defaultModernChecks`.
5. Write both directions: a test proving it passes the fixture's default
   (correct) mode, and a test proving it fails the fixture's break mode.
   If you add a check to a list another test already asserts an exact
   result count for, that count needs updating too - this has come up in
   nearly every phase so far.

## Adding a new chaos scenario

Same shape, in `packages/chaos/src/scenarios/`: a fault to inject, a
`ChaosScenario` that sends it and calls the shared `classifyResilience()`
helper, and a fixture break mode that produces each verdict you want to
prove the scenario can detect (see `packages/fixtures/stateless-server`'s
`crash-on-malformed` / `hang-on-unknown-method` / `freeze-on-unknown-method`
for three different verdicts from the same shape of scenario).

## Commit style

Commits in this repo are structured as a short summary line, then a
`What changed` list, then a `Why` paragraph. Look at `git log` for the
actual convention rather than a template here - it's easier to match an
example than a description of one. A few things that consistently matter:

- One logical change per commit. A feature and the tests proving it are
  usually two commits, not one - it's easier to see "this is what proves
  the feature works" as its own reviewable unit.
- If a change fixes a bug in already-shipped code (not the feature you're
  currently adding), it gets its own commit, landed _before_ whatever
  you were doing when you found it - see the `resultType` fix in this
  repo's history for the shape of that.
- Avoid backticks inside commit message bodies passed via `-m` - most
  shells try to execute them as command substitution. Use
  `git commit -F -` with a heredoc instead if a message needs them.

## Reporting a spec-conformance finding

If Crucible's own output makes you suspect a real server or SDK is doing
something non-conformant, don't state that conclusion directly - verify
it the way `FINDINGS.md` was built:

1. Find the exact spec text (or the exact absence of it) the behavior
   should be judged against.
2. Read the actual implementation source, not just its type definitions.
3. Write down reproduction steps, expected vs. actual behavior with exact
   citations, affected version, impact, and a stated confidence level -
   distinguishing a confirmed violation from an implementation limitation,
   an intentional choice, or a case where the spec itself is genuinely
   ambiguous.
4. Check for an existing upstream issue before assuming there isn't one.

`FINDINGS.md` in this repo is a live example of the format and the level
of hedging that's appropriate - in particular, it's fine and expected for
the answer to be "this is a real gap, but not a confirmed spec violation."
