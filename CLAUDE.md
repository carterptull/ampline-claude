# CLAUDE.md

Architecture map for working in this repo. Read `DECISIONS.md` alongside this — it has the
*why* behind anything here that looks surprising, plus every place the live Claude Code
payload disagreed with the original spec.

## What this is

A zero-dependency Claude Code statusline. Reads a JSON payload on stdin, prints one or two
lines of ANSI-colored text to stdout. Installed via `npx ampline-claude --install` into
`~/.claude/settings.json`.

## Rules that apply everywhere, not just where first introduced

- **Never add a runtime dependency.** `package.json` has no `dependencies` field. Keeping it
  that way is the point — instant `npx`, zero supply-chain surface.
- **Never add a network call or read a credential.** No exceptions. Usage data comes only
  from stdin `rate_limits`, cached to disk. See `lib/usage.js` and the README FAQ
  ("Does it read my credentials?") for why an OAuth fallback was rejected.
- **Color = identity, bold = urgency.** The 20-step model/effort wheel (`lib/colors.js`)
  carries no urgency signal — only `max` bolds, because it's inherently "pay attention."
  Usage bars (`lib/bar.js`) are the opposite: a separate green→red danger ramp, bold reserved
  for the 85%+ threshold. Don't blend the two scales. Opt-in pace coloring feeds the same ramp
  and is capped below the bold step, and the pace marker is a glyph, so neither adds a color
  channel (D39, D40).
- **Every segment returns `null` instead of throwing.** stdout is the product surface; a
  blank statusline is acceptable, a crashed one is not. Every `render*Segment(ctx)` function
  wraps its body in `try/catch` and returns `null` on any failure.
- **Foreign strings get sanitized before they reach stdout.** Branch names, todo text,
  subagent labels, model names, and config values (`.amplinerc.json` `separator`, notably —
  it loads automatically from a repo you didn't write) all pass through
  `colors.js`'s `sanitize()` before interpolation. Terminal escape sequences are otherwise a
  live injection vector, not a hypothetical one — see `DECISIONS.md`. Sanitizing is not enough
  on its own: a value must also be the right TYPE and in a sane range, because `sanitize(String({}))`
  is still `[object Object]` and a bare finite number can print as `1e+21` (D38, D42).
- **`execFileSync` blocks the event loop.** No `setTimeout` can bound it. The only real
  defenses are: as few subprocess calls as possible (one `git status` call per render cycle,
  not two), a hard timeout on that one call, and caching so most renders hit zero
  subprocesses. See `lib/segments/git.js`.
- **stdout is the product. stderr is debug only.** Never `console.log` from a code path that
  runs during a real statusline render — it corrupts the line Claude Code displays.

## Module layout

```
bin/ampline-claude.js     Entry point. Six argv-driven paths: --help, --version, --install,
                           uninstall/--uninstall, subagent (stdin piped, --subagent), and the
                           default statusline path (TTY -> installer, piped stdin -> render).
                           `if (require.main === module) main();` guards against a bare
                           `require('ampline-claude')` triggering a real install as a side effect.
lib/
  claudeDir.js              Resolves CLAUDE_CONFIG_DIR (falls back to ~/.claude). Every other
                            module that touches the config directory goes through this — never
                            hardcode os.homedir()/.claude again.
  colors.js                The wheel, the danger ramp, NO_COLOR, ANSI stripping, control-char
                            sanitization. Frozen interface.
  bar.js                   Block-bar renderer shared by context/fiveHour/weekly. BAR_WIDTH = 8.
                            Optional pace marker (┃) for the usage bars; glyph-only so it survives NO_COLOR.
  cache.js                 Two-tier fresh/stale file cache. Handles the Windows ':' filename bug
                            and atomic writes (two processes — main + subagent — can race).
  safeRead.js              readSmallTextFile(path, maxBytes?) -> string | null. The only way to read
                            a file from a checkout we do not control (.amplinerc.json, .git, HEAD,
                            repo-local git config): regular files of at most 64 KB by default,
                            checked again on the open descriptor; null on anything else.
  usage.js                 stdin rate_limits -> write-through cache -> resolveUsage(). Synchronous.
                            Also the window pace math: elapsedFraction, paceRampPct (D39, D40).
  config.js                .amplinerc.json loader: walk up from cwd, then home, first file wins.
  layout.js                One-line vs two-line wrapping, reading COLUMNS (falls back to
                            DEFAULT_COLUMNS when unset/non-numeric).
  render.js                Assembles segments per config into the final line(s). Entry point
                            for the main statusline; NOT used for the subagent line.
  install.js               settings.json merge + backup + runtime copy to ~/.claude/hooks/.
                            Writes through a symlinked settings.json rather than replacing it,
                            and preserves the original file's permission bits across the atomic
                            rename.
  segments/
    model.js                Model name + effort, wheel color.
    context.js               Context-window usage bar.
    rateLimits.js             5-hour + weekly usage bars, with the pace marker and opt-in paceColors.
    git.js                     Branch (from .git/HEAD, no subprocess) + ahead/behind/dirty
                               (one cached `git status --porcelain=v2` call, run with
                               `-c core.fsmonitor=` and `--no-optional-locks`). fsmonitor is
                               overridden; if the repo's OWN config (config, config.worktree,
                               and a linked worktree's common dir via `commondir`) defines a
                               `[filter ...]`, `[include]` or `[includeIf ...]` section, or cannot
                               be read and parsed, the call is skipped (branch only, no marker,
                               no `git:` cache entry; D20 follow-up). Everything else in the
                               repo's own config is trusted exactly as when you run git yourself
                               there; global and system config are never scanned.
    cost.js                     Session cost + lines added/removed.
    task.js                      Current in-progress todo, from ~/.claude/todos/.
    pr.js                          Open PR (`#N`) or GitLab MR (`!N`, when `pr.kind === 'mr'`) +
                                   review state. Claude Code fills `pr` (via `gh` or `glab`
                                   on the machine it runs on) — that's its dependency, not
                                   ours; see DECISIONS.md D12 and D38. The number becomes an
                                   OSC 8 link only when `pr.url` passes `safeLinkUrl` (https,
                                   printable ASCII, <=2048 chars, no credentials).
    subagents.js                   subagentStatusLine renderer. Different payload shape
                                   entirely — see "The subagent payload" below.
```

## Frozen module interfaces

Treat these signatures as fixed. Changing one means changing every call site.

```
lib/colors.js    fg(r,g,b) · RESET · BOLD · DIM · EFFORT_ORDER · WHEEL
                 colorForModelEffort(modelId, displayName, level) -> string
                 dangerStyle(pct) -> {color,bold,warn} | null
                 normalizeModelFamily(modelId, displayName) -> family | null
                 normalizeEffortLevel(level) -> level | null      <- null, never a default
                 colorsEnabled() -> boolean · stripAnsi(s) -> string
                 sanitize(s) -> string   <- strips C0/C1 controls, line separators, bidi and zero-width characters (D43)

lib/claudeDir.js claudeDir() -> string   <- CLAUDE_CONFIG_DIR override or ~/.claude

lib/bar.js       renderBar(label, usedPct, opts) -> string | null   opts: {stale, marker, rampPct}
                 marker = elapsed fraction 0..1; one cell becomes ┃, width stays 8;
                 ignored when stale or not a finite number in 0..1.
                 rampPct = percentage the danger ramp is read at; can only RAISE urgency
                 BAR_WIDTH

lib/cache.js     read(key) -> {age, value} | null · write(key, value)
                 remove(key) · prune() · CACHE_DIR

lib/usage.js     resolveUsage(input) -> {fiveHour, weekly, stale} | null   <- SYNCHRONOUS
                 formatCountdown(resetsAtMs) -> string
                 elapsedFraction(resetsAtMs, windowMs, now?) -> number | null   <- 0..1, null = unknown
                 paceRampPct(percentUsed, fraction) -> number | null        <- null = use the real pct
                 PACE_DEADBAND (0.1) · PACE_CAP (84)

lib/layout.js    layout(line1Parts, line2Parts, separator) -> string
                 visibleWidth(str) -> number · SEGMENT_SEP

lib/config.js    loadConfig(cwd) -> config · DEFAULT_CONFIG · VALID_SEGMENTS

lib/render.js    renderStatusline(input) -> string                  <- SYNCHRONOUS

lib/install.js   runInstaller(options) -> void · INSTALL_DIR

segments         render<Name>Segment(ctx) -> string | null
                 segments/pr.js also exports safeLinkUrl(raw) -> href | null
                 ctx = { input, config, usage }                     <- ONE object argument
```

`resolveUsage` is synchronous because there's no network call left to await. Segment
renderers take one `ctx` object rather than positional args, so a segment that only needs
`input` can't accidentally receive `config` or `usage` in the wrong slot.

## The subagent payload is a different shape entirely

`subagentStatusLine` does not receive a single task — it receives `{ columns, tasks: [...] }`,
one entry per row. Its OUTPUT is not bare text: Claude Code expects one JSON line per row,
`{"id": "<task id>", "content": "<row>"}`, with the id echoed, and a row with no id keeps the
default rendering (`DECISIONS.md` D41). The input shape was verified against a real captured
payload (see D2-D5):

- Display name is `task.label || task.description || task.name || task.agentType || 'agent'`.
  `name` and `agentType` are in the current docs but were absent from the captured payloads (D2).
- `task.type` is always the literal string `"local_agent"` — never use it for display.
- `task.effort` is usually absent (subagents inherit session effort) and can be a **numeric**
  token budget instead of a level string. `normalizeEffortLevel` returns `null` for both
  cases, which is what keeps a numeric budget from painting a wrong wheel color.
- Width comes from `input.columns`, never `process.env.COLUMNS` — that env var is genuinely
  unset in the subagent invocation.

## Degradation contract

Every failure mode ends in **something rendered and exit 0** — never a hang, never a
non-zero exit from the statusline path, never a partial/garbled line. Specifically:
- A segment with insufficient data returns `null` and is simply omitted from the line.
- `renderStatusline` and `renderSubagentLine` each wrap every segment call in `try/catch`.
- The entry point (`bin/ampline-claude.js`) has a 500ms stdin timeout and writes+exits from
  the stdout callback, never immediately after `write()` — stdout to a pipe is asynchronous
  on Windows, and exiting too early truncates the output.
- One narrow, deliberate exception to "stderr is debug only": if stdin arrives genuinely empty
  (outside `--subagent` mode), the entry point writes a one-line install hint to stderr. This
  never fires during a real Claude Code render — real renders always pipe a payload — so it
  doesn't contradict stdout-is-the-product; it only helps a human or script that ran the bare
  command with no input to install. See DECISIONS.md D17.
- **Known gap:** the "never a hang" guarantee is enforced by a real timeout only for the one
  `execFileSync('git', ...)` call. The synchronous filesystem reads in `cache.js` and
  `segments/task.js` (`readFileSync`/`readdirSync`/`statSync`) have no ceiling — on a
  network-mounted `~/.claude`, a render could block for as long as that I/O takes. Fixing this
  for real means moving those paths off synchronous I/O, which conflicts with `usage.js` and
  `render.js` being deliberately `SYNCHRONOUS` (see Frozen module interfaces) — not addressed
  yet, flagged here rather than silently assumed away.

## Cache TTLs

| Data | Key | Fresh | Stale | Why |
|---|---|---|---|---|
| Usage | `usage` | n/a (write-through) | 24h + resets_at rollover check | stdin is authoritative when present; cache only covers cold start |
| Git state | `git:<gitdir>` | 5s | 60s | one subprocess call; 5s is below human perception for branch/dirty changes |
| Current task | `task:<session_id>` | 3s | 15s | filesystem I/O; todos don't change faster than this |

## Diagrams

`diagrams/` holds hand-maintained Mermaid architecture diagrams (start at
`diagrams/overview.md`). When a change alters something one of them shows (the render path,
the color wheel, the PR/MR segment, the cache tiers, the installer, CI or the security
controls), update that diagram and its footer stamp in the same PR. Bump every footer's
version on each release. The re-check table and the GitHub Mermaid syntax rules are in
`diagrams/README.md`. `diagrams/` is not in the npm `files` allowlist, so it never ships in
the tarball.

## Testing

`npm test` runs `test/run.js` — spawns the real binary against every fixture in
`test/fixtures/`, each in its own throwaway `HOME`/`USERPROFILE` (see `DECISIONS.md` D14 for
why per-fixture isolation, not per-suite, is required). `scripts/syntax-check.js` and
`scripts/verify-pack.js` are CI-only, excluded from the published tarball by the `files`
allowlist in `package.json`.
