# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
