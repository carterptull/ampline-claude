# ampline-claude

[![npm version](https://img.shields.io/npm/v/ampline-claude.svg)](https://www.npmjs.com/package/ampline-claude)
[![npm downloads](https://img.shields.io/npm/dm/ampline-claude.svg)](https://www.npmjs.com/package/ampline-claude)
[![license](https://img.shields.io/npm/l/ampline-claude.svg)](https://github.com/carterptull/ampline-claude/blob/main/LICENSE)
[![CI](https://github.com/carterptull/ampline-claude/actions/workflows/ci.yml/badge.svg)](https://github.com/carterptull/ampline-claude/actions/workflows/ci.yml)

**Amplify your statusline.** ampline-claude is a color-graded, zero-dependency statusline for
Claude Code, built by Paymon Software. Its signature feature is a continuous 20-step color
wheel across the model and effort space, so the model and effort level you are running show up
in color at a glance, next to context and rate-limit usage, git state and session cost. It
wraps to a second line when your terminal is narrow.

Website and live demo: https://ampline.js.org

![ampline-claude preview](https://github.com/carterptull/ampline-claude/raw/main/preview.png)

## Contents

- [Quickstart](#quickstart)
- [Update](#update)
- [Uninstall](#uninstall)
- [Commands](#commands)
- [What it shows](#what-it-shows)
- [The color wheel](#the-color-wheel)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Known limitations](#known-limitations)
- [Stability](#stability)

## Quickstart

```sh
npx ampline-claude --install
```

That's it. It installs itself into `~/.claude/settings.json` and copies its runtime to
`~/.claude/hooks/ampline-claude/`. Restart Claude Code or start a new session to see it.

The installer writes the absolute path of the Node that ran it, so the statusline still works when
Claude Code is launched without your shell's `PATH`. If that Node sits in a directory that holds a
single version (Homebrew's `Cellar`, or the version folders of nvm, fnm, volta, asdf, nodenv, mise
or snap), the installer also prints the path it wrote and a reminder to re-run
`npx ampline-claude --install` after you upgrade Node. Where a stable `PATH` entry such as
`/opt/homebrew/bin/node` leads to the same binary, that entry is written instead of the versioned
one.

The bare `npx ampline-claude` also installs, but only from an interactive terminal. Use
`--install` in scripts, in CI, or any time you are not sure. It works everywhere.

<details>
<summary>Manual install (editing settings.json yourself)</summary>

Run `npx ampline-claude --install` once anyway. That's what copies the runtime to a stable
location. Then, if you'd rather manage the config yourself, add entries shaped like this to
`~/.claude/settings.json`, using **your own absolute path** (shown below as a placeholder,
since `~` isn't expanded by `cmd.exe` and copy-pasting it literally won't work):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/.claude/hooks/ampline-claude/bin/ampline-claude.js\"",
    "padding": 0,
    "refreshInterval": 30
  },
  "subagentStatusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/.claude/hooks/ampline-claude/bin/ampline-claude.js\" --subagent"
  }
}
```

The exact `command` value the installer writes for your machine is the fastest way to get this
right. Run the installer once, then copy `statusLine.command` straight out of the
`settings.json` it produced.

</details>

## Update

```sh
npx ampline-claude@latest --install
```

Re-runs the installer, which replaces the installed copy in place.

## Uninstall

```sh
npx ampline-claude uninstall
```

Removes the `statusLine`/`subagentStatusLine` entries ampline wrote from `settings.json` (backing
up the file first; if the backup cannot be made, nothing is changed), deletes
`~/.claude/hooks/ampline-claude/`, and clears the cache. If the entries are already gone, it still
deletes the runtime copy and the cache. Only a command that runs the installed copy counts as
ampline's: if your `settings.json` points at a different statusline, including your own wrapper
script, uninstall leaves the file and the runtime copy alone. If only one of the two entries is
ampline's, that one is removed, and the runtime copy stays for as long as the other entry still
names `ampline-claude`. Installing works a bit differently
though: installing over an existing foreign `statusLine` or `subagentStatusLine` prints a notice
and then replaces it, after backing the file up. Backups are named
`settings.json.backup.<timestamp>`, and only the newest five of those are kept.

## Commands

| Command | What it does |
|---|---|
| `npx ampline-claude --install` | install, or update the installed copy. The explicit form, safe in scripts and CI |
| `npx ampline-claude` | the same, but only from an interactive terminal |
| `npx ampline-claude uninstall` or `--uninstall` | uninstall, as described above |
| `npx ampline-claude --version` or `-v` | print the version |
| `npx ampline-claude --help` or `-h` | print usage |
| `ampline-claude --subagent` | what Claude Code runs for the subagent panel: reads a payload on stdin and prints one `{"id","content"}` JSON line per row. You do not run it by hand |

Flags are matched anywhere in the arguments, and an unknown one is ignored. Run with no flag, no
terminal and nothing on stdin, it prints a one-line hint to stderr, renders whatever it can from
the current directory to stdout, and exits 0. The installer
prints a few plain lines for a human to read, and that text is not meant to be parsed. Check the
exit code instead: `0` on success, `1` when it could not read or parse `settings.json`, back it up,
copy the runtime or write the file.

## What it shows

| Segment | Example | Notes |
|---|---|---|
| Directory | `ampline-claude` | repo name as Claude Code reports it, falls back to the folder name |
| Git | `⎇ main ↑2 ●` | branch, ahead/behind, dirty (`●`) or clean (`✓`). `✓` means no *tracked* changes, see below |
| Model + effort | `Opus 5.5 · high` | the 20-step wheel, see below |
| Context | `C34 ███░░░░░` | context-window usage, green→red. Reflects the last completed API call, see below |
| 5-hour usage | `H93 ┃██████░ ↺ 4h28m` | rate-limit window, with reset countdown and a pace marker (`┃`). Subscription accounts only, see below |
| Weekly usage | `W17 █░░░┃░░░ ↺ 2d23h` | same shape, 7-day window. Subscription accounts only, see below |
| Cost | `$12.47 +2412/-1` | session cost estimate + lines changed |
| Task | `Writing the render module…` | current in-progress todo, dimmed |
| PR / MR | `#1` or `!7` | open GitHub PR (`#N`) or GitLab merge request (`!N`) for the current branch, colored by review state. The number is a clickable link in terminals that support hyperlinks |

A full line looks like:

```
ampline-claude │ ⎇ main ✓ │ Opus 5.5 · high │ C34 ███░░░░░ │ H93 ┃██████░ ↺ 4h28m │ W17 █░░░┃░░░ ↺ 2d23h │ $12.47 +2412/-1 │ #1
```

Wraps to two lines automatically when it doesn't fit `COLUMNS`.

That example is from a Claude.ai subscription account. On an enterprise or Teams account the
`H` and `W` segments are absent, because Claude Code does not send rate-limit data for
those account types. Everything else renders the same.

**Reading the pace marker.** The `┃` in a usage bar marks how much of that window has already
elapsed, so you can compare time used against quota used on one bar. In `H93 ┃██████░`, 93% of
the quota is gone but the marker sits at the far left, so only about a tenth of the window has
passed. That is the bar telling you to slow down. In `W17 █░░░┃░░░` the marker is well ahead of
the fill, so the quota is being spent slower than the clock. A fill that runs clearly past the
marker means you are using quota faster than time is passing. Read the two to about one cell, an
eighth of the window: when they sit side by side you are roughly on pace. The marker replaces one
of the eight cells, so the bar stays the same width, and the number beside it is always the exact percentage.
It is left out when ampline-claude cannot tell where you are in the window, and on dimmed bars
showing cached values. It assumes a 5-hour and a 7-day window, because the payload only
reports when a window resets.

**Git dirty is a deliberate narrower check.** For speed, the one `git status` call ampline-claude
makes skips untracked files (`--untracked-files=no`). A repo whose only change is a handful of
new, not-yet-`git add`ed files still shows `✓`. The marker tracks staged, modified, and deleted
files, not whether your working tree matches HEAD exactly. `git status` in your terminal is
still the source of truth.

## The color wheel

One continuous sweep. Model tier picks the region, effort picks the position within it.
Blue → cyan → green → yellow → orange → red → pink → violet → purple.

| # | Model | Effort | Color | Hex |
|---|---|---|---|---|
| 0 | Haiku 5.5 | low | royal blue | `#3D64E8` |
| 1 | Haiku 5.5 | medium | cornflower blue | `#4D79E8` |
| 2 | Haiku 5.5 | high | azure | `#5D8EE8` |
| 3 | Haiku 5.5 | xhigh | sky blue | `#6DA3E8` |
| 4 | Haiku 5.5 | max | light blue | `#7DB8E8` |
| 5 | Sonnet 5.5 | low | cyan | `#5CE8D0` |
| 6 | Sonnet 5.5 | medium | teal | `#4AC98C` |
| 7 | Sonnet 5.5 | high | green | `#7ACC3D` |
| 8 | Sonnet 5.5 | xhigh | yellow-green | `#C4CC3D` |
| 9 | Sonnet 5.5 | max | yellow | `#E8B23D` |
| 10 | Opus 5.5 | low | light orange | `#E8963D` |
| 11 | Opus 5.5 | medium | orange | `#E8763D` |
| 12 | Opus 5.5 | high | red-orange | `#E85A3D` |
| 13 | Opus 5.5 | xhigh | red | `#E8433D` |
| 14 | Opus 5.5 | max | deep red | `#D8203D` |
| 15 | Fable 5.1 | low | light pink | `#E88CC8` |
| 16 | Fable 5.1 | medium | pink | `#E85CB3` |
| 17 | Fable 5.1 | high | violet | `#C43DE8` |
| 18 | Fable 5.1 | xhigh | magenta | `#B300D8` |
| 19 | Fable 5.1 | max | purple | `#8000C0` |

Haiku 5.5 reports effort, so it runs from a deeper blue at `low` up to the light blue at
`max`. Haiku 4.5, or any Haiku that sends no effort data, has nothing to grade, so it stays a
flat `#7DB8E8`, the same color as Haiku 5.5 `max`. For every other family, missing effort
falls back to that family's `high` color. Models are matched on family, so a point release
such as Sonnet 5.5 or Opus 5.5 uses its family's colors.

Every effort level renders un-bold except `max`, which is bold. It's the one effort level
loud enough to earn it.

**Why usage bars don't use the wheel.** Context and rate-limit usage get a separate, plain
green→yellow→orange→red→darkest-red ramp instead, bolding at 85% and adding a `⚠` at 95%.
Color tells you what's running. Bold tells you when to worry. The wheel answers *what's
running*, the ramp answers *when to worry*, and mixing them (letting pink or violet show up in
a usage bar) would turn a glance into something you have to decode instead of just see.

**Pace coloring is opt-in.** The ramp normally reads the percentage you have used. With
`"paceColors": true` the 5-hour and weekly bars read it at where your pace is heading instead,
so 40% used with a fifth of the window gone turns orange rather than staying green. It never
colors a bar calmer than the plain ramp would, and it stops at orange, so bold and `⚠` still mean you are really nearly out.
See `DECISIONS.md` D40.

## Configuration

Drop a `.amplinerc.json` in your project root (or `~/.amplinerc.json` for a global default).
The nearest one wins. The search starts at the directory Claude Code reports for the session
(`workspace.current_dir`, or `cwd`), checks at most 30 directories, starting with the session
directory, and then tries your home directory. Files don't merge together. Finding the git
repository for the branch uses the same 30-directory limit.

```json
{
  "segments": [
    "dir", "git", "model", "context",
    "fiveHour", "weekly", "cost", "task", "pr"
  ],
  "line2From": "fiveHour",
  "separator": " │ ",
  "color": true,
  "paceColors": false,
  "maxBranchLength": 24,
  "maxTaskLength": 40
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `segments` | string[] | all nine | which segments render, in order. Names are case-sensitive. Unknown names are dropped silently, and a name that appears twice is kept once (the first). An empty list means the default. |
| `line2From` | string | `"fiveHour"` | the segment where line 2 begins when wrapping. It must be one of your `segments`, otherwise it falls back to `fiveHour`, or to the middle segment if `fiveHour` is not in your list. Naming the first segment means never wrap. |
| `separator` | string | `" │ "` | rendered between segments. Control and invisible characters are removed, and it is cut to 16 characters. |
| `color` | boolean | `true` | `false` strips all ANSI from the output |
| `paceColors` | boolean | `false` | color the 5-hour and weekly bars by where your pace is heading, not only where it is now. It is a straight-line projection from elapsed time, so it does not apply in the first 10% of a window, and it assumes a 5-hour and a 7-day window. It can raise a bar to orange early, never colors one calmer than the plain ramp would, and never reaches bold or `⚠`. |
| `maxBranchLength` | number | `24` | branch name truncation. A fraction is rounded down and the value is capped at 200. A value under 5, or one that is not a finite number, falls back to the default. |
| `maxTaskLength` | number | `40` | task text truncation, with the same rules as `maxBranchLength` |

Invalid values get corrected silently instead of raising an error, the same way the tool
degrades everywhere else. Unknown keys are ignored. A `.amplinerc.json` is read only if it is a
regular file of at most 64 KB, and one that is a directory, a special file or too big is skipped
like a missing one. See `.amplinerc.json.example` in this repo for a starting point.

## How it works

Claude Code pipes a JSON payload to the statusline command's **stdin** on every render and
captures stdout. There's no TTY, so no `tput cols`. Width comes from `COLUMNS` in the
environment instead, falling back to a sane default if it's ever unset. The process has to
exit fast too: if a new render fires while the script is still running, Claude Code just
cancels it. So the real failure mode here isn't slowness, it's *no statusline at all*.

**Config directory.** `~/.claude` is the default location for settings, cache, and the
installed runtime. If you've redirected it with `CLAUDE_CONFIG_DIR`, ampline-claude follows
along. The installer, cache, and task segment all resolve through the same override.

**Usage bars, cached.** `rate_limits` is absent from stdin until the first API response of a
session. We could fill that gap with a network call, but that would mean reading your OAuth
token and depending on an undocumented endpoint, so instead every `rate_limits` value gets
written through to a local cache. On a cold start, the bars appear instantly showing the
last-known values, dimmed to signal they're stale, then snap to live the moment the first
response lands.

**Pace marker.** The marker needs the window's reset time and assumes the window lengths, 5
hours and 7 days, since the payload never says how long a window is. It uses the live value
only. A dimmed cached bar never shows one, because a cached quota compared against a live clock
would mislead.

**Degradation.** Every segment either renders or returns nothing, never a crash, and the render
path always exits 0. If data's missing, that one segment just gets skipped and the rest of the
line still renders. The one subprocess it starts, `git status`, has a 400ms timeout, and input
that comes from a checkout or from stdin is read only up to fixed limits (see
[`SECURITY.md`](SECURITY.md)).

More detail:
- [`CLAUDE.md`](CLAUDE.md): module architecture, frozen interfaces, the rules that apply everywhere
- [`diagrams/`](diagrams/README.md): architecture diagrams, starting with
  [`overview.md`](diagrams/overview.md)
- [`DECISIONS.md`](DECISIONS.md): every design decision and why, including where the live
  Claude Code payload disagreed with documentation
- [`CHANGELOG.md`](CHANGELOG.md): what shipped in each version
- [`SECURITY.md`](SECURITY.md): how to report a vulnerability

## FAQ

<details>
<summary>Does this use extra API tokens or slow Claude Code down?</summary>

No. It runs entirely locally, no API calls of any kind. Rendering is a handful of file reads
and, at most, one cached `git status` call every 5 seconds. Typical render time is a few
milliseconds. The one subprocess, `git status`, is capped at 400ms, so a cache miss on a large repo
costs at most that, and a `git status` that fails or times out is not retried for 30 seconds, so a
slow repo does not pay for it on every render. The cap covers only that call: the file reads
are not time-limited, so a `~/.claude` on a slow network mount can slow a render down.
The cost of that: after one transient failure the branch shows without its marker for up to 30 seconds.
And if an earlier result between 5 and 60 seconds old exists, it is shown instead and no pause is
started, so a repo that is always slow still pays the 400ms until that result ages out.
</details>

<details>
<summary>Is the session cost my actual bill?</summary>

No, it's the client-side estimate Claude Code itself computes and exposes on stdin, not a
figure from your account. It also resets to `$0` on `/clear`, which is Claude Code's behavior,
not a bug here.
</details>

<details>
<summary>Does it work if I only have an API key, not a Claude.ai subscription?</summary>

Yes, for everything except the two usage bars. `rate_limits` only appears on stdin for
Claude.ai subscribers, and that presence is what gates the feature, never
`ANTHROPIC_API_KEY`. Plenty of Max subscribers also export an API key for other tooling, and
gating on that variable would silently break usage bars for them.
</details>

<details>
<summary>Does it read my credentials?</summary>

No, and it makes no network requests at all. Usage data comes only from the payload Claude
Code already sends on stdin.
</details>

<details>
<summary>Does ampline run git in my repository?</summary>

The branch is read from `.git/HEAD` without running anything. The ahead/behind/dirty marker comes
from one `git status` call, and git follows the repository's own configuration, as it does when
you run it yourself. ampline-claude turns off `core.fsmonitor` for that call, does not let it
write the index, does not run git inside submodules (a submodule with a dirty work tree does not
set the dirty marker; a moved submodule commit still does), starts git in the work tree it
inspected and sets a ceiling directly above it, so that if git rejects that repository it fails
rather than climbing into another one (git keeps its own ownership check), and skips the call
entirely when the repository's own config defines a content filter or an include. Global and
system config (a Git LFS filter you installed, for example) are yours and are not checked. This
narrows what a repository can make git do on every render; it does not remove it and is not a
sandbox. The marker is also left out when the repository sits in a folder whose path contains
`:` (macOS and Linux) or `;` (Windows), because git would read that as two ceilings. Treat a
directory you did not clone yourself (an unpacked archive, for example) as you would before
running git in it. Older git versions have two further gaps, which
[`SECURITY.md`](SECURITY.md) describes.
</details>

<details>
<summary>Can it break Claude Code?</summary>

The installer never overwrites a `settings.json` it can't parse. It aborts and prints the
parse error instead, and it refuses to change the file at all if it cannot first make a backup.
Every statusline render either prints something or prints nothing, and always exits 0. The one
process it starts, `git status`, has a 400ms timeout.
</details>

<details>
<summary>I ran `npx ampline-claude` from a script and nothing installed, why?</summary>

`npx ampline-claude` with no flags installs when run from an interactive terminal (TTY
detected). From a non-interactive shell, like a dotfiles script or CI, there's no TTY to
detect, and Claude Code's own real renders look the same way on stdin. If stdin also turns out
to be genuinely empty, it prints a one-line hint to stderr pointing at the explicit flag.
Either way, use `npx ampline-claude --install` in scripts to install unconditionally.
</details>

## Known limitations

- **Truecolor terminals only.** The wheel and the danger ramp both use 24-bit ANSI color
  (`\x1b[38;2;r;g;bm`). There's no ANSI-16 fallback yet, so on a terminal without truecolor
  support, colors will render incorrectly instead of degrading gracefully. Set `NO_COLOR=1`
  to opt out of color entirely.
- **The pace marker rests on assumed window lengths.** ampline-claude treats the 5-hour window
  as 5 hours and the weekly one as 7 days, because the payload only gives the reset time. If
  Claude's windows are ever different, the marker moves, or disappears when the assumed window is shorter than the real one, and with
  `paceColors` on the color changes too. The percentage and the countdown never do. The marker also
  hides whether its own cell was filled, so the visible fill can be off by one cell there. The
  number beside the bar stays exact. Its glyph (`┃`) rendered correctly on a real Mac and on
  Windows (which Mac terminal and font was not recorded, D39). Other terminals and fonts have not
  been tried.
- **`paceColors` is a straight-line projection.** It assumes you keep spending at the average
  rate so far, so a short burst early in a long window can turn a bar orange that later settles.
  It does not apply in the first 10% of a window. It is off by default.
- **Opus `max` and Fable `low` sit next to each other in the wheel.** Both are meant to read
  as "spending a lot," which is intentional, but the exact hue boundary between them is close.
- **Usage bars need one API response before they first appear** on a brand-new install. The
  write-through cache has nothing to show until then.
- **The 5-hour and weekly bars need a Claude.ai subscription account.** Claude Code only
  sends rate-limit window data for accounts that have those windows. Enterprise and Teams
  accounts do not, so `fiveHour` and `weekly` never appear on them. The rest of the
  statusline renders normally. This is the intended behavior, not a failure.
- **The context percentage reflects the last completed API call.** It is not a live token
  counter. During a long single response the number stays at its pre-call value, then jumps
  once that call finishes. Claude Code re-renders the statusline within about 300ms of the
  value changing, so this is not a refresh problem, and changing `refreshInterval` does not
  affect it. There is no fix available from the statusline side.
- **The PR/MR segment renders whatever Claude Code hands it, and nothing more.** Claude Code
  resolves the current branch's pull request or merge request itself and puts the result in
  the payload. `ampline-claude` never runs `gh`, `glab`, or any other command to look one up,
  and never reads a token. If Claude Code sends nothing, the segment is left out, the same as
  if there were no open PR. What Claude Code itself needs to find one, per its own
  documentation (not independently verified for GitLab, see `DECISIONS.md` D38):
  - **GitHub:** a GitHub token, either the one saved by `gh auth login` or `GH_TOKEN` /
    `GITHUB_TOKEN` (GitHub Enterprise hosts use their own variables).
  - **GitLab (merge requests, shown as `!N`):** Claude Code v2.1.234 or later, a remote on
    gitlab.com or a self-managed GitLab host, and the `glab` CLI on `PATH` and logged in with
    `glab auth login`. Claude Code ignores `GITLAB_TOKEN`, and checks for `glab` and its login
    once per session, so restart Claude Code after installing or logging in.
  On an MR, green means GitLab reports it mergeable, not that someone approved it.
- **The PR/MR number is a link only when the URL is a plain `https` one.** Claude Code supplies
  the URL, and `ampline-claude` only turns the number into a clickable hyperlink when that URL
  is printable ASCII, at most 2048 characters, uses `https`, and carries no username or
  password. Otherwise the number still shows, as plain text. Terminals without hyperlink
  support, such as macOS Terminal.app, show the number without a link. `NO_COLOR` and
  `"color": false` also turn the link off.
- **What has been checked on real hardware.** The render, including the pace marker glyph that
  ships in 1.0.0, is confirmed on a real Mac and on Windows, including a live Claude Code session on
  Windows (see `DECISIONS.md` D39 and D47). Linux was verified on Ubuntu under WSL on an earlier
  release: the fixture suite, the install and uninstall flow, the shebang, UTF-8 glyph output, color
  behavior, and the absolute Node path written for a Node that was not on the default `PATH`
  (D36). Node 24 on Linux is covered by CI. Not confirmed: the environment variables a real Claude
  Code process supplies on Linux (that check was a controlled invocation, not a live session),
  terminals and fonts beyond the ones tried, and the macOS install and uninstall flow, which has not
  been confirmed separately. The installer's choice of a stable `PATH` entry over a Homebrew
  `Cellar` path is tested with injected paths only and has not been run on a Mac.
- **Some file reads have no time limit.** Only the `git status` call has a timeout. Reading the
  cache and the todo files is not time-limited, so a `~/.claude` on a slow network mount can slow a
  render down.

## Stability

From 1.0.0, ampline-claude follows [SemVer](https://semver.org/spec/v2.0.0.html). A breaking
change to any of the following waits for a major release:

- **The command line:** `--install`, `uninstall` and `--uninstall`, `--version` and `-v`,
  `--help` and `-h`, and `--subagent` (see [Commands](#commands)).
- **The `.amplinerc.json` keys** `segments`, `line2From`, `separator`, `color`, `paceColors`
  (opt-in) and `maxBranchLength` and `maxTaskLength`, with their types and defaults as listed
  under [Configuration](#configuration), including the limits listed there.
- **The stdin fields it reads.** For the statusline: `session_id`, `cwd`, `workspace.current_dir`,
  `workspace.repo.name`, `model.id`, `model.display_name`, `effort.level`,
  `context_window.used_percentage`, `rate_limits.five_hour` and `rate_limits.seven_day`
  (`used_percentage`, and `resets_at` in epoch seconds; other forms accepted today are
  tolerance, not a promise), `cost.total_cost_usd`, `cost.total_lines_added`,
  `cost.total_lines_removed`, and `pr.number`, `pr.url`, `pr.review_state`, `pr.kind`. For
  `--subagent`: `columns` and, per entry in `tasks`, `id`, `label`, `description`, `name`,
  `agentType`, `status`, `model`, `effort` and `tokenCount`. Fields Claude Code adds later are
  ignored.
- **The render path always exits 0.** A segment that cannot render is left out. (The installer is
  different by design: it exits 1 when it cannot complete the install safely.)
- **The subagent output shape:** one `{"id","content"}` JSON line per row.

The rules this README states are part of the behavior: bold only at the `max` effort, usage bars
bold from 85%, and pace (the marker and `paceColors`) never adding bold or `⚠`. What may change in
a minor release is how things look: the exact glyphs, hex colors, spacing and segment labels, and
the tuning of pace coloring (its 10% dead zone, its cap at 84 and its projection, D46) and the
marker's placement.

Not part of the promise: the `task` segment reads Claude Code's local todo files, whose location
is an undocumented convention, so it is best-effort. Everything under `lib/` is internal. The
package's `exports` field allows only `package.json`, so `require('ampline-claude/lib/...')`
fails, and those modules can change in any release. The installer's printed output is for people
to read and is not machine-readable; use its exit code. The statusline text itself is for
terminals and is not a data format either. The reasoning is in `DECISIONS.md` D49.

---

© 2026 Paymon Software · MIT
