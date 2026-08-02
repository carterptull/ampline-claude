# ampline-claude

[![npm version](https://img.shields.io/npm/v/ampline-claude.svg)](https://www.npmjs.com/package/ampline-claude)
[![npm downloads](https://img.shields.io/npm/dm/ampline-claude.svg)](https://www.npmjs.com/package/ampline-claude)
[![license](https://img.shields.io/npm/l/ampline-claude.svg)](https://github.com/carterptull/ampline-claude/blob/main/LICENSE)
[![CI](https://github.com/carterptull/ampline-claude/actions/workflows/ci.yml/badge.svg)](https://github.com/carterptull/ampline-claude/actions/workflows/ci.yml)

A color-graded, zero-dependency statusline for Claude Code, by **Paymon Software**. Its
signature feature is a continuous 16-step color wheel across the model × effort space — no
other Claude Code statusline shows what's running and how hard at a glance, in color, on one
line.

![ampline-claude preview](https://github.com/carterptull/ampline-claude/raw/main/preview.png)

## Contents

- [Quickstart](#quickstart)
- [Update](#update)
- [Uninstall](#uninstall)
- [What it shows](#what-it-shows)
- [The color wheel](#the-color-wheel)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Known limitations](#known-limitations)

## Quickstart

```sh
npx ampline-claude
```

That's it — it installs itself into `~/.claude/settings.json` and copies its runtime to
`~/.claude/hooks/ampline-claude/`. Restart Claude Code or start a new session to see it.

<details>
<summary>Manual install (editing settings.json yourself)</summary>

Run `npx ampline-claude` once anyway — it's what copies the runtime to a stable location.
Then, if you'd rather manage the config yourself, add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"~/.claude/hooks/ampline-claude/bin/ampline-claude.js\"",
    "padding": 0,
    "refreshInterval": 30
  },
  "subagentStatusLine": {
    "type": "command",
    "command": "node \"~/.claude/hooks/ampline-claude/bin/ampline-claude.js\" --subagent"
  }
}
```

Use an absolute path, not `~` — `cmd.exe` doesn't expand it.

</details>

## Update

```sh
npx ampline-claude@latest
```

Re-runs the installer, which replaces the installed copy in place.

## Uninstall

```sh
npx ampline-claude uninstall
```

Removes the `statusLine`/`subagentStatusLine` entries from `settings.json` (backing up the
file first), deletes `~/.claude/hooks/ampline-claude/`, and clears the cache. If your
`settings.json` points at a different statusline, uninstall refuses to touch it.

## What it shows

| Segment | Example | Notes |
|---|---|---|
| Directory | `ampline-claude` | repo name from the `origin` remote, falls back to the folder name |
| Git | `⎇ main ↑2 ●` | branch, ahead/behind, dirty (`●`) or clean (`✓`) |
| Model + effort | `Opus 5 · high` | the 16-step wheel — see below |
| Context | `C34 ███░░░░░` | context-window usage, green→red |
| 5-hour usage | `H93 ███████░ ↺ 4h28m` | rate-limit window, with reset countdown |
| Weekly usage | `W17 █░░░░░░░ ↺ 2d23h` | same shape, 7-day window |
| Cost | `$12.47 +2412/-1` | session cost estimate + lines changed |
| Task | `Writing the render module…` | current in-progress todo, dimmed |
| PR | `#1` | open PR for the current branch, colored by review state |

A full line looks like:

```
ampline-claude │ ⎇ main ✓ │ Opus 5 · high │ C34 ███░░░░░ │ H93 ███████░ ↺ 4h28m │ W17 █░░░░░░░ ↺ 2d23h │ $12.47 +2412/-1 │ #1
```

Wraps to two lines automatically when it doesn't fit `COLUMNS`.

## The color wheel

One continuous sweep — model tier picks the region, effort picks the position within it.
Blue → cyan → green → yellow → orange → red → pink → violet → purple.

| # | Model | Effort | Color | Hex |
|---|---|---|---|---|
| 0 | Haiku 4.5 | (none) | light blue | `#7DB8E8` |
| 1 | Sonnet 5 | low | cyan | `#5CE8D0` |
| 2 | Sonnet 5 | medium | teal | `#4AC98C` |
| 3 | Sonnet 5 | high | green | `#7ACC3D` |
| 4 | Sonnet 5 | xhigh | yellow-green | `#C4CC3D` |
| 5 | Sonnet 5 | max | yellow | `#E8B23D` |
| 6 | Opus 5 | low | light orange | `#E8963D` |
| 7 | Opus 5 | medium | orange | `#E8763D` |
| 8 | Opus 5 | high | red-orange | `#E85A3D` |
| 9 | Opus 5 | xhigh | red | `#E8433D` |
| 10 | Opus 5 | max | deep red | `#D8203D` |
| 11 | Fable 5 | low | light pink | `#E88CC8` |
| 12 | Fable 5 | medium | pink | `#E85CB3` |
| 13 | Fable 5 | high | violet | `#C43DE8` |
| 14 | Fable 5 | xhigh | magenta | `#B300D8` |
| 15 | Fable 5 | max | purple | `#8000C0` |

Haiku has no effort levels, so it's a flat color. `max` renders **bold** everywhere else in
the sweep is non-bold — it's the one effort level loud enough to earn it.

**Why usage bars don't use the wheel.** Context and rate-limit usage get a separate,
deliberately conventional green→yellow→orange→red→darkest-red ramp instead, bolding at 85%
and adding a `⚠` at 95%. This is the whole design thesis: **color = identity, bold =
urgency.** The wheel tells you *what's running*; the ramp tells you *when to worry*. Mixing
them — letting pink or violet show up in a usage bar — would turn a glance into a decode.

## Configuration

Drop a `.amplinerc.json` in your project root (or `~/.amplinerc.json` for a global default).
The nearest one wins — searched from the current directory upward to the filesystem root,
then your home directory. No merging between files.

```json
{
  "segments": [
    "dir", "git", "model", "context",
    "fiveHour", "weekly", "cost", "task", "pr"
  ],
  "line2From": "fiveHour",
  "separator": " │ ",
  "color": true,
  "maxBranchLength": 24,
  "maxTaskLength": 40
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `segments` | string[] | all nine | which segments render, in order. Unknown names are dropped silently. |
| `line2From` | string | `"fiveHour"` | the segment where line 2 begins when wrapping |
| `separator` | string | `" │ "` | rendered between segments |
| `color` | boolean | `true` | `false` strips all ANSI from the output |
| `maxBranchLength` | number | `24` | branch name truncation |
| `maxTaskLength` | number | `40` | task text truncation |

Invalid values are corrected silently rather than raising an error — consistent with how the
tool degrades everywhere else. See `.amplinerc.json.example` in this repo for a starting point.

## How it works

Claude Code pipes a JSON payload to the statusline command's **stdin** on every render, and
captures stdout — no TTY, so no `tput cols`; width comes from `COLUMNS`/`LINES` in the
environment instead. The process has to exit fast: if a new render triggers while the script
is still running, Claude Code cancels it, so the real failure mode isn't slowness, it's *no
statusline at all*.

**Usage bars, cached.** `rate_limits` is absent from stdin until the first API response of a
session. Rather than filling that gap with a network call — which would mean reading your
OAuth token and adding a dependency on an undocumented endpoint — every `rate_limits` value
received is written through to a local cache. On a cold start, the bars appear instantly
showing the last-known values, dimmed to signal staleness, then snap to live the moment the
first response lands.

**Degradation.** Every segment either renders or returns nothing — never a crash, never a
hang. Missing data means that one segment is silently omitted; the rest of the line still
renders.

More detail:
- [`CLAUDE.md`](CLAUDE.md) — module architecture, frozen interfaces, the rules that apply everywhere
- [`DECISIONS.md`](DECISIONS.md) — every design decision and why, including where the live
  Claude Code payload disagreed with documentation
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped in each version

## FAQ

<details>
<summary>Does this use extra API tokens or slow Claude Code down?</summary>

No. It runs entirely locally — no API calls of any kind. Rendering is a handful of file reads
and, at most, one cached `git status` call per 5 seconds. Typical render time is a few
milliseconds; the worst case (a cache miss on a large repo) is capped at 400ms.
</details>

<details>
<summary>Is the session cost my actual bill?</summary>

No — it's the client-side estimate Claude Code itself computes and exposes on stdin, not a
figure from your account. It also resets to `$0` on `/clear`, which is Claude Code's behavior,
not a bug here.
</details>

<details>
<summary>Does it work if I only have an API key, not a Claude.ai subscription?</summary>

Yes, for everything except the two usage bars. `rate_limits` only appears on stdin for
Claude.ai subscribers, and that presence is what gates the feature — never
`ANTHROPIC_API_KEY`. Plenty of Max subscribers also export an API key for other tooling;
gating on that variable would silently break usage bars for them.
</details>

<details>
<summary>Does it read my credentials?</summary>

No, and it makes no network requests at all. Usage data comes only from the payload Claude
Code already sends on stdin.
</details>

<details>
<summary>Can it break Claude Code?</summary>

The installer never overwrites a `settings.json` it can't parse — it aborts and prints the
parse error instead. Every statusline render either prints something or prints nothing; it
never hangs and never exits non-zero.
</details>

## Known limitations

- **Truecolor terminals only.** The wheel and the danger ramp both use 24-bit ANSI color
  (`\x1b[38;2;r;g;bm`). No ANSI-16 fallback yet — on a terminal without truecolor support,
  colors will render incorrectly rather than degrading gracefully. Set `NO_COLOR=1` to opt
  out of color entirely.
- **Opus `max` and Fable `low` sit next to each other in the wheel.** Both are meant to read
  as "spending a lot," which is intentional, but the exact hue boundary between them is close.
- **Usage bars need one API response before they first appear** on a brand-new install — the
  write-through cache has nothing to show until then.
- **The PR segment requires the `gh` CLI installed and authenticated** on the machine Claude
  Code runs on. This is a precondition of how Claude Code itself resolves the current
  branch's PR status, not something `ampline-claude` calls directly — without it, `pr`
  simply doesn't appear, the same as if there were no open PR.

---

© 2026 Paymon Software · MIT
