# CLAUDE.md

Architecture map for working in this repo. Read `DECISIONS.md` alongside this — it has the
*why* behind anything here that looks surprising, plus every place the live Claude Code
payload disagreed with the original spec.

## What this is

A zero-dependency Claude Code statusline. Reads a JSON payload on stdin, prints one or two
lines of ANSI-colored text to stdout. Installed via `npx ampline-claude` into
`~/.claude/settings.json`.

## Rules that apply everywhere, not just where first introduced

- **Never add a runtime dependency.** `package.json` has no `dependencies` field. Keeping it
  that way is the point — instant `npx`, zero supply-chain surface.
- **Never add a network call or read a credential.** No exceptions. Usage data comes only
  from stdin `rate_limits`, cached to disk. See `lib/usage.js` and `DECISIONS.md`'s "no
  network" entry for why an OAuth fallback was rejected.
- **Color = identity, bold = urgency.** The 16-step model/effort wheel (`lib/colors.js`)
  carries no urgency signal — only `max` bolds, because it's inherently "pay attention."
  Usage bars (`lib/bar.js`) are the opposite: a separate green→red danger ramp, bold reserved
  for the 85%+ threshold. Don't blend the two scales.
- **Every segment returns `null` instead of throwing.** stdout is the product surface; a
  blank statusline is acceptable, a crashed one is not. Every `render*Segment(ctx)` function
  wraps its body in `try/catch` and returns `null` on any failure.
- **`execFileSync` blocks the event loop.** No `setTimeout` can bound it. The only real
  defenses are: as few subprocess calls as possible (one `git status` call per render cycle,
  not two), a hard timeout on that one call, and caching so most renders hit zero
  subprocesses. See `lib/segments/git.js`.
- **stdout is the product. stderr is debug only.** Never `console.log` from a code path that
  runs during a real statusline render — it corrupts the line Claude Code displays.

## Module layout

```
bin/ampline-claude.js     Entry point. Three modes: installer (TTY or --install/uninstall),
                           statusline (stdin piped, no flag), subagent (stdin piped, --subagent).
lib/
  colors.js                The wheel, the danger ramp, NO_COLOR, ANSI stripping. Frozen interface.
  bar.js                   Block-bar renderer shared by context/fiveHour/weekly. BAR_WIDTH = 8.
  cache.js                 Two-tier fresh/stale file cache. Handles the Windows ':' filename bug
                            and atomic writes (two processes — main + subagent — can race).
  usage.js                 stdin rate_limits -> write-through cache -> resolveUsage(). Synchronous.
  config.js                .amplinerc.json loader: walk up from cwd, then home, first file wins.
  layout.js                One-line vs two-line wrapping, reading COLUMNS.
  render.js                Assembles segments per config into the final line(s). Entry point
                            for the main statusline; NOT used for the subagent line.
  install.js               settings.json merge + backup + runtime copy to ~/.claude/hooks/.
  segments/
    model.js                Model name + effort, wheel color.
    context.js               Context-window usage bar.
    rateLimits.js             5-hour + weekly usage bars.
    git.js                     Branch (from .git/HEAD, no subprocess) + ahead/behind/dirty
                               (one cached `git status --porcelain=v2` call).
    cost.js                     Session cost + lines added/removed.
    task.js                      Current in-progress todo, from ~/.claude/todos/.
    pr.js                          Open PR + review state. Requires `gh` CLI installed and
                                   authenticated on the machine Claude Code runs in — that's
                                   Claude Code's dependency, not ours; see DECISIONS.md D12.
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

lib/bar.js       renderBar(label, usedPct, opts) -> string | null   opts: {stale}
                 BAR_WIDTH

lib/cache.js     read(key) -> {age, value} | null · write(key, value)
                 remove(key) · prune() · CACHE_DIR

lib/usage.js     resolveUsage(input) -> {fiveHour, weekly, stale} | null   <- SYNCHRONOUS
                 formatCountdown(resetsAtMs) -> string

lib/layout.js    layout(line1Parts, line2Parts, separator) -> string
                 visibleWidth(str) -> number · SEGMENT_SEP

lib/config.js    loadConfig(cwd) -> config · DEFAULT_CONFIG · VALID_SEGMENTS

lib/render.js    renderStatusline(input) -> string                  <- SYNCHRONOUS

lib/install.js   runInstaller(options) -> void · INSTALL_DIR

segments         render<Name>Segment(ctx) -> string | null
                 ctx = { input, config, usage }                     <- ONE object argument
```

`resolveUsage` is synchronous because there's no network call left to await. Segment
renderers take one `ctx` object rather than positional args, so a segment that only needs
`input` can't accidentally receive `config` or `usage` in the wrong slot.

## The subagent payload is a different shape entirely

`subagentStatusLine` does not receive a single task — it receives `{ columns, tasks: [...] }`,
one row per task, newline-separated. Verified against a real captured payload (see
`DECISIONS.md` D2-D5):

- No `name` field. Display name is `task.label || task.description || 'agent'`.
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

## Cache TTLs

| Data | Key | Fresh | Stale | Why |
|---|---|---|---|---|
| Usage | `usage` | n/a (write-through) | 24h + resets_at rollover check | stdin is authoritative when present; cache only covers cold start |
| Git state | `git:<gitdir>` | 5s | 60s | one subprocess call; 5s is below human perception for branch/dirty changes |
| Current task | `task:<session_id>` | 3s | 15s | filesystem I/O; todos don't change faster than this |

## Testing

`npm test` runs `test/run.js` — spawns the real binary against every fixture in
`test/fixtures/`, each in its own throwaway `HOME`/`USERPROFILE` (see `DECISIONS.md` D14 for
why per-fixture isolation, not per-suite, is required). `scripts/syntax-check.js` and
`scripts/verify-pack.js` are CI-only, excluded from the published tarball by the `files`
allowlist in `package.json`.
