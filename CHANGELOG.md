# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
