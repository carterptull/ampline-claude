# Architecture diagrams

Visual companions to [`CLAUDE.md`](../CLAUDE.md) (how the repo is laid out) and
[`DECISIONS.md`](../DECISIONS.md) (why it was built this way). The diagrams show the shape of
each decision. The decision log explains the reasoning behind it.

| Diagram | Shows |
| --- | --- |
| [`overview.md`](overview.md) | Start here: the payload in, the segments, the line out, and the separate subagent path in one picture |
| [`c4-context.md`](c4-context.md) | Who and what ampline-claude sits among, and what it deliberately never does (no network, no credentials) |
| [`c4-container.md`](c4-container.md) | The internal modules: entry point, render, config, layout, colors, bar, cache, usage, installer, and the eight segments, with their `require()` dependencies |
| [`render-sequence.md`](render-sequence.md) | What happens from the stdin payload to the stdout line, step by step, including the stdin timeout and the write-then-exit rule |
| [`color-wheel.md`](color-wheel.md) | How a model family and effort level become one of the 20 wheel colors, and how the usage danger ramp differs |
| [`pr-mr-segment.md`](pr-mr-segment.md) | How a `pr` payload becomes `#N` or `!N`, a review color, and a validated clickable link |
| [`cache-tiers.md`](cache-tiers.md) | The fresh and stale cache tiers for usage, git state, and the current task, and what happens on a miss |
| [`install-flow.md`](install-flow.md) | What `--install` and `uninstall` do to `settings.json` and the runtime copy, and the safeguards around both |
| [`deployment-security.md`](deployment-security.md) | How code gets from a branch to npm, and the runtime controls at each trust boundary |

## Keeping these current

These are hand-maintained, not generated. Each file ends with a stamp
(`Last updated: <date> · reflects v<version>`, the version taken from `package.json`), so a
stale diagram is visible rather than silent.

Bump every diagram's footer to the current release version on each release, even ones whose
content didn't change this time. The stamp is a "still accurate as of this version" claim, not
a record of when the file itself was last edited. Content is a separate question from the
stamp. Re-verify what a diagram actually shows only when a change touches one of the areas
below, and update its Mermaid source and prose then, not on every release.

| If you change... | Re-check |
| --- | --- |
| `lib/colors.js` wheel or gradients | `color-wheel.md` |
| `lib/segments/pr.js` | `pr-mr-segment.md`, `deployment-security.md` |
| `lib/cache.js` or any cache TTL | `cache-tiers.md` |
| `lib/install.js` | `install-flow.md` |
| `bin/ampline-claude.js`, `lib/render.js`, or `lib/layout.js` | `render-sequence.md`, `overview.md` |
| a new segment or module, or a changed `require()` edge | `c4-container.md`, `overview.md` |
| `.github/workflows/ci.yml`, the `files` allowlist in `package.json`, `scripts/verify-pack.js`, or `SECURITY.md` | `deployment-security.md` |
| `sanitize()`, the `git` call's flags or timeout, or any new foreign string reaching stdout | `deployment-security.md` |
| a new external dependency or a new payload source | `c4-context.md`, `overview.md` |

A routine fix or copy change doesn't need a diagram update.

## Syntax rules (GitHub's Mermaid renderer)

- No native `C4Context` / `C4Container`: still experimental and inconsistent on GitHub. The C4
  views here are `flowchart`s styled by level.
- `flowchart` labels break lines with `<br/>`, never `\n`.
- `stateDiagram-v2` transition labels and `classDiagram` relationship labels are single-line
  plain text: no `\n`, no colons.
- Keep node ids simple alphanumerics, and quote any label containing parentheses, slashes,
  colons, or other special characters.
- Avoid HTML other than `<br/>` and `<b>`. Do not use `<small>`: GitHub's renderer sizes the
  node for the normal font, so the tail of small text gets clipped (seen on github.com, and in
  the portfolio and blitzcast diagrams too).
- Keep each diagram to roughly 6 to 14 nodes. Split rather than grow one giant diagram.
- Verify by viewing the rendered file on github.com. Reading the source is not verification.

---
_Last updated: 2026-10-07 · reflects v0.6.0_
