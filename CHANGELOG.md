# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **A pace marker on the 5-hour and weekly bars.** One cell of the bar becomes `┃` at the point
  of the window that has already elapsed, so quota used and time used read off the same bar.
  A fill head ahead of the marker means quota is being spent faster than the clock. The bar
  stays 8 cells and the marker needs no color, so it shows under `NO_COLOR`. It is left out
  when the reset time is unknown and on dimmed stale bars. See `DECISIONS.md` D39.
- **`paceColors` (opt-in, default `false`).** Colors the 5-hour and weekly bars by where your pace
  is heading, not only where it is now, so a bar that is on course to run out turns orange
  early. It never colors a bar calmer than the plain ramp would, and stops at orange so bold and `⚠` stay
  reserved for real consumption of 85% and up. It does not apply in the first 10% of a window.
  See `DECISIONS.md` D40.
- `elapsedFraction` and `paceRampPct` in `lib/usage.js`, and `opts.marker` / `opts.rampPct` on
  `renderBar`. These are additions to declared interfaces; `resolveUsage` is unchanged.

### Changed
- **Known limitations updated for macOS.** v0.7.0 rendering, including the pace marker glyph,
  is confirmed working on a real Mac, and the marker was also confirmed in a live Claude Code
  session on Windows. See `DECISIONS.md` D39.
- **Copyright is now held by Paymon Software.** The license is still MIT and its terms are
  unchanged; only the copyright holder named in `LICENSE` and the README footer differ.

### Fixed
- **A config file can no longer stall or flood the render.** `segments` is deduplicated (nine at most), `separator` is capped at 16 characters, `maxBranchLength` and `maxTaskLength` are floored and clamped to 5..200, and `.amplinerc.json`, the `.git` file and `HEAD` are read only if they are regular files of at most 64 KB. Input on stdin is capped at 8 MB, past which nothing is rendered and the exit code stays 0.
- **The subagent status line now uses Claude Code's documented output format.** `--subagent`
  printed bare text rows, but Claude Code expects one JSON line per row, `{"id","content"}`, and
  keeps its own default row for anything else, so the custom rows were most likely never shown.
  It now emits that format, leaves out tasks with no id, and falls back to the subagent's `name`
  and `agentType` when there is no label or description. The model id is now sanitized like the
  other displayed fields, and a `status` that names an `Object.prototype` property (such as
  `constructor`) no longer prints into the row. See `DECISIONS.md` D41.
- **Values of the wrong type or range no longer print.** A non-string repo name or model
  display name used to print as `[object Object]`, `5` or `true`, and cost accepted `$-5.00`,
  `$1e+21` and `+-3/--4`. Names must now be strings, cost must be 0 up to 1e9, and line counts
  must be non-negative integers. An unusable `current_dir` falls back to `cwd` for both the
  directory and git segments. Escape sequences were already stripped everywhere; this is about
  types, and is now covered by a whole-line injection suite. See `DECISIONS.md` D42.
- **A rate-limit percentage of `null`, `""` or `false` no longer shows as 0%.** It was coerced
  with `Number()`, drew a bar, and was cached, so a later render with no usage data served it
  for up to a day. A percentage must now be a number.
- **A todo that is not text no longer prints `[object Object]` on the second render**, and
  another session's task can no longer appear because its id starts with yours. Session ids are
  matched exactly, and a blank task is left out instead of leaving an empty segment.
- **A very long run of spaces in a model name no longer stalls the render.** A display name of
  100,000 spaces took 8 seconds and a million never finished. The name is bounded before it
  reaches a pattern, and the pattern is linear.
- **Empty names fall back instead of printing nothing**: a model whose display name cleans to
  nothing uses its id, and a blank repo name uses the directory name. Repo and directory names
  are capped at 40 characters. Subagent rows ignore names and token counts that are not the
  right type.
- **Bidirectional and invisible characters are stripped from names.** A right-to-left override
  in a directory or branch name could reorder the rest of the line on a bidi-capable terminal,
  and zero-width or tag characters could blank a name or hide text. Zero-width joiners and
  variation selectors are kept, so emoji sequences still work. Cell width now counts rockets and
  other newer emoji as two cells and combining or zero-width characters as none, so the line
  wraps when it should. A test now fails if such a character appears in the source. See
  `DECISIONS.md` D43.

### Security
- **`git status` is no longer run in a repository whose own config defines a filter or an include.**
  `git status` also honors content filter drivers and `include`/`includeIf` files named in a
  repository's own config, which `-c core.fsmonitor=` does not cover; a repository that arrived as
  an archive (a clone does not transfer `.git/config`) could use them to run a command on every
  render. Before spawning `git status`, ampline now reads the repo-local config (`config`,
  `config.worktree`, and for a linked worktree the common directory's, found through
  `commondir`). If it defines a `[filter ...]`, `[include]` or `[includeIf ...]` section, or cannot
  be read and parsed, the call is skipped: the branch still shows from `HEAD`, with no
  ahead/behind/dirty marker and no cache entry. Global and system config are not scanned, and
  everything else in a repository's own config is trusted exactly as when you run git yourself
  there. See `DECISIONS.md` D20 (follow-up).
- **Correction to the 0.3.0 entry below.** It said the `core.fsmonitor` override stopped a
  repository's `.git/config` from running a command on every render. That was too broad:
  the override closes only the fsmonitor path. Filters and includes were not covered until this
  release.

## [0.6.0] - 2026-10-07

### Added
- **Haiku 5.5 effort colors.** Haiku 5.5 reports effort levels, so Haiku now has a five-stop
  blue ramp from `#3D64E8` at `low` up to the existing `#7DB8E8` at `max`. The wheel is
  now 20 steps. Haiku with no effort data (Haiku 4.5) keeps the flat `#7DB8E8` it always had.
  See `DECISIONS.md` D37.
- **GitLab merge requests show as `!N`.** Claude Code v2.1.234 added GitLab merge request
  support and sets `pr.kind` to `"mr"`. The PR segment now renders GitLab's own `!N` for
  merge requests and keeps `#N` for GitHub pull requests.
- **The PR/MR number is a clickable link** in terminals that support hyperlinks, when
  `pr.url` is a plain `https` URL (printable ASCII, at most 2048 characters, no username
  or password). Any other URL leaves the number as plain text. No link is emitted under
  `NO_COLOR` or `"color": false`. See `DECISIONS.md` D38.
- `diagrams/`: hand-maintained Mermaid architecture diagrams, linked from the README and
  `CLAUDE.md`.
- Test runner helpers for inline payloads and exact escape-sequence assertions, plus tests for
  the Haiku ramp, the PR/MR label, hostile `pr.url` values, and `pr.kind` handling.

### Fixed
- A `pr.review_state` value that matches a name on `Object.prototype` (for example
  `"constructor"`) printed function source into the statusline. It is now looked up as an
  own property only.
- A `pr.number` that was not a plain positive integer could still render something that was
  not a PR number (`true` as `#1`, `"0x10"` as `#16`, `1e21` as `#1e+21`). Such values now
  omit the segment.
- The test runner no longer inherits `NO_COLOR` or `FORCE_COLOR` from the caller's shell.
  Exporting `NO_COLOR` used to fail the color checks and let the hostile-URL checks pass
  without testing anything.

### Changed
- README and `CLAUDE.md` now describe both GitHub and GitLab requirements for the PR/MR
  segment (a GitHub token, or `glab` logged in plus Claude Code v2.1.234 or later), and use the
  5.5 model names in the wheel table.
- Package description and docs say 20-step wheel, up from 16.

## [0.5.0] - 2026-08-09

### Changed
- **Breaking:** minimum supported Node version raised from 18 to 24 (`engines.node` is now
  `>=24.0.0`). Node 18 and 20 are EOL/deprecated; the CI matrix now tests Node 24 only
  instead of 18/20/22, and `actions/checkout`/`actions/setup-node` were bumped from `@v4` to
  `@v7` in `.github/workflows/ci.yml`, since v4 ran on GitHub's deprecated `node20` Actions
  runtime.

## [0.4.1] - 2026-08-05

### Fixed
- Quickstart and Update now recommend `npx ampline-claude --install`, and `SECURITY.md` and
  `CLAUDE.md` were corrected to match. The bare form only installs from an interactive
  terminal, so the previous instruction silently did nothing in scripts, in CI, and in some
  enterprise terminals. The behavior itself is unchanged and intentional, see `DECISIONS.md`
  D17.
- `--help` listed the bare command first as the primary way to install. It now leads with
  `--install`, matching the README.
- Corrected the explanation of the context percentage. It reflects the last completed API
  call rather than a live token count, so it is not a refresh problem and `refreshInterval`
  does not affect it. See `DECISIONS.md` D33.
- The installer's refuse-to-reinstall-from-itself error suggested `npx ampline-claude@latest`
  with no flag. It now suggests `--install`, matching every other reference to the command.
- `--version` run against an installed copy always printed `unknown`, on every version ever
  published, because the installer copied `bin/` and `lib/` but never `package.json`, and
  `--version` reads its own version from that file. The installer now copies it too.

### Added
- Documented that the 5-hour and weekly bars need a Claude.ai subscription account.
  Enterprise and Teams accounts get no rate-limit data in the payload, so those two
  segments never appear on them. See `DECISIONS.md` D35.
- Documented that ultracode cannot be told apart from plain `xhigh`, because Claude Code
  normalizes it away before the statusline payload is built. See `DECISIONS.md` D34.
- Clarified that the PR segment renders what Claude Code resolves, and never runs `gh`
  itself.
- Verified the full test suite, the install and uninstall flow, and the color/UTF-8 output
  on real Linux. The README's Known limitations now say Linux is confirmed and macOS is not,
  instead of listing both as unverified. See `DECISIONS.md` D36.
- Added `test/fixtures/pr-gitlab-shape.json`, confirming the PR segment renders a
  GitLab-shaped merge request identically to a GitHub pull request, since it only ever reads
  a number and a review state.

## [0.4.0] - 2026-08-04

### Changed
- Rewrote the README's explanatory prose for a plainer, more human tone: no em dashes or
  semicolons, shorter sentences, and a "color tells you what's running, bold tells you when to
  worry" framing instead of "design thesis" language. No functional or configuration changes;
  tables, code samples, and links are unchanged.

## [0.3.0] - 2026-08-04

Pre-release hardening pass: security review, cross-platform correctness, and account-tier
compatibility, ahead of a 1.0.0 tag. See `DECISIONS.md` Phase 2 for the full reasoning behind
each item below.

### Fixed
- **Published package failed to run on macOS/Linux.** The working-tree copy of every source
  file carried CRLF line endings (including `bin/ampline-claude.js`'s shebang), which
  `npm pack` ships as-is regardless of git's own line-ending normalization. Added
  `.gitattributes` (`eol=lf`) and normalized the working tree.
- A repo-local `.amplinerc.json` (loaded automatically by walking up from cwd) could inject raw
  terminal escape sequences via an unsanitized `separator` value, and several other
  payload/filesystem-sourced strings (branch name, todo text, subagent labels, model name)
  reached stdout unsanitized. Added `colors.js: sanitize()` and applied it at every foreign-string
  interpolation point.
- `git status` ran with no protection against a repo's own `.git/config` `core.fsmonitor` hook
  command, which could execute arbitrary code on every render for a hostile extracted archive.
  Hardened the invocation with `-c core.fsmonitor=` and `--no-optional-locks`.
  _Correction (2026-10-25): this closed only the fsmonitor path. Filter drivers and includes in a
  repository's own config were not covered until the `[Unreleased]` Security entry above._
- Branch names, todo text, and subagent labels truncated near a surrogate pair could render a
  broken `�` character. Truncation now splits on code points, not UTF-16 units.
- A PR payload shaped like `{ number: null }` rendered a phantom `#0`. `pr.js` now requires a
  real positive integer.
- A millisecond-scale `resets_at` would have produced an absurd, permanently-cached countdown.
  `usage.js` now guards against the unit-confusion case and rejects any reset more than 60 days out.
- `require('ampline-claude')` could trigger a real install as an unintended side effect of
  module load. Dropped the unnecessary `main` field and added a `require.main === module` guard.

### Added
- `CLAUDE_CONFIG_DIR` is now honored by the installer, cache, and task segment via a new
  `lib/claudeDir.js`, instead of each hardcoding `~/.claude`.
- `layout.js` falls back to a sane default width when `COLUMNS` is unset or non-numeric, instead
  of silently disabling two-line wrapping.
- The installer prefers the absolute path of the Node binary running it (`process.execPath`)
  over a bare `node`, so a GUI-launched Claude Code with a minimal PATH can still find it.
- The installer now preserves a `settings.json` file's permission bits across its atomic write,
  and writes through a symlinked `settings.json` (e.g. a dotfiles-managed one) instead of
  replacing it with a plain file.
- The model segment's rendered name is now length-capped, so an unbounded model id (as seen on
  some third-party gateways) can't force a spurious line wrap.
- `SECURITY.md` with a vulnerability-reporting path.

### Changed
- `README.md`/`CLAUDE.md`: fixed the broken manual-install snippet, clarified that the git
  dirty marker (`✓`/`●`) only reflects tracked changes, corrected the directory-segment and
  `COLUMNS`/`LINES` descriptions, documented `CLAUDE_CONFIG_DIR`, and aligned the copyright
  line with `LICENSE`.

## [0.2.0] - 2026-08-02

### Fixed
- Bare `npx ampline-claude` with no TTY and no `--install` flag now prints a one-line hint to
  stderr (`no input received — if you meant to install, run npx ampline-claude --install`)
  instead of silently doing nothing. Stdout is untouched, so real statusline renders are
  unaffected — the hint only fires on genuinely empty stdin outside `--subagent` mode.

## [0.1.0] - 2026-08-02

### Added
- Initial implementation: 16-step model/effort color wheel, context and rate-limit usage bars,
  git state, session cost, current task, open PR, and subagent panel rows.
- `.amplinerc.json` configuration: segment selection/order, two-line wrap point, separator,
  color toggle, branch/task truncation lengths.
- Write-through usage cache so 5-hour and weekly bars survive a cold session start, marked stale.
- `npx ampline-claude` installer with settings.json backup, foreign-statusline detection, and
  a safe uninstall path.
- Zero-dependency fixture test suite (`npm test`) and a three-OS × three-Node-version CI matrix.
