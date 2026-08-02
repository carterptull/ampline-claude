# Decisions

Lightweight ADR-style entries, written as decisions are made. Newest phase last.

---

## Phase 1 — Payload verification

Captured against **Claude Code 2.1.220 on Windows 10**, Node 22.13.1, by temporarily
pointing `statusLine.command` and `subagentStatusLine.command` at a script that appends
raw stdin to a JSONL file. 24 main-statusline payloads and 4 subagent payloads.

Where the live payload disagreed with the plan, **the payload wins.**

### D1. `model.display_name` carries a version suffix — `"Sonnet 5"`, not `"Sonnet"`

The plan's §1.1/§1.5 showed `"display_name": "Opus"`. The real value on this account is
`"Sonnet 5"` for `model.id: "claude-sonnet-5"`.

**Decision:** render `display_name` as-is. It is what Claude Code itself calls the model,
it is only one or two characters wider, and stripping the version would be inventing a
name the user never sees elsewhere. `shortenModel` keeps its defensive strips (the
`claude ` prefix and a `(N context)` suffix) but gains nothing new.

**Consequence:** the README segment table and the wheel table must show `Sonnet 5` /
`Opus 5` / `Haiku 4.5`, not the bare family names, or the docs will not match the screen.
Family detection is unaffected — `normalizeModelFamily` keys off `model.id` first.

### D2. `subagentStatusLine` has no `name` field, and `type` is not the agent type

Plan §1.6 showed `"name": "explore-auth"` and `"type": "Explore"`. Neither is real.
The observed task object is:

```json
{
  "id": "a132c7a336b0a457c",
  "type": "local_agent",
  "status": "completed",
  "description": "Payload capture trigger A",
  "label": "Payload capture trigger A",
  "startTime": 1785636406582,
  "model": "claude-haiku-4-5-20251001",
  "contextWindowSize": 200000,
  "tokenCount": 14046,
  "tokenSamples": [0, 12935, 14046, 14046],
  "cwd": "C:\\Users\\cart3\\Repositories\\ampline-claude"
}
```

- `name` — **absent entirely.**
- `type` — always the literal `"local_agent"`. It is an internal transport kind, not the
  agent definition. The subagent's actual type (`Explore`, `general-purpose`, …) is **not
  in the payload at all**, so a "which agent is this" indicator is unbuildable.
- `description` and `label` both carry the caller-supplied task description.

**Decision:** the display-name chain becomes `label || description || 'agent'`. `type` is
dropped from the chain — falling back to it would print the literal string `local_agent`
in every row where the first two were missing, which is worse than the generic `agent`.

### D3. `task.effort` is absent in the ordinary case

Plan §1.6 flagged `effort` as possibly a numeric token budget. On 2.1.220 it was **absent
for every observed task**, including a Sonnet subagent, because subagents inherit the
session effort.

**Decision:** no code change — `normalizeEffortLevel(undefined)` already returns `null`,
and `colorForModelEffort` falls back to the family's `high` slot. The numeric-budget guard
stays in, unexercised but correct, since it costs nothing and §1.6 documents the case.

**Consequence:** in practice the subagent rows are colored by **model family only**. The
wheel's effort axis is a main-statusline feature.

### D4. `task.model` is a bare id string, and Haiku's is long

Confirmed as a **string**, not an object (§18 asked). But the Haiku value is
`"claude-haiku-4-5-20251001"` — stripping `claude-` leaves `haiku-4-5-20251001`, exactly
18 characters, so the plan's `truncate(..., 18)` passes it through whole and burns 18
columns on a date stamp.

**Decision:** normalize subagent model ids to a short family label (`haiku`, `sonnet`,
`opus`, `fable`) via `normalizeModelFamily`, falling back to the truncated raw id only
when the family is unrecognized. Keeps `modelIdOf` for the object shape in case it ever
changes.

### D5. `COLUMNS` is **not set** for the subagent invocation

`COLUMNS=156` / `LINES=47` were present on every main-statusline call — confirming the
plan's §1 point 3 on Windows specifically. For `subagentStatusLine`, **both are
undefined**, and the payload carries `"columns": 152` instead.

**Decision:** this validates §1.6 as load-bearing rather than stylistic. `subagents.js`
reads width from the payload only and must never consult `process.env.COLUMNS`; there is
nothing there to read. `layout.js` (main line only) continues to read the env var.

### D6. `resets_at` epoch-seconds confirmed; percentages were integers in this sample

`rate_limits.five_hour = { used_percentage: 93, resets_at: 1785636000 }` and
`seven_day = { used_percentage: 17, resets_at: 1785891600 }`. The reset values are
10-digit **epoch seconds** exactly as §1.4 warns.

Both percentages were integers across all 24 captures. That does **not** disprove the
float case — the plan's `toEntry` clamps without rounding and stays as specified.

### D7. Fields confirmed present, and fields still unobserved

Confirmed live: `session_id`, `session_name`, `cwd`, `transcript_path`, `prompt_id`,
`model.{id,display_name}`, `effort.level`, `workspace.{current_dir,project_dir,added_dirs,repo.{host,owner,name}}`,
`version`, `output_style.name`, all five `cost.*`, all of `context_window.*` including
`current_usage.*`, `exceeds_200k_tokens`, `fast_mode`, `thinking.enabled`, both
`rate_limits` windows.

**Still unobserved, and therefore still guarded by the null-not-throw contract:**

- `pr` — no open PR on this branch during capture. Never appeared. The segment ships, but
  its rendering is unverified against a live value.
- `workspace.git_worktree` — not a worktree session.
- `effort` absent for a model without effort support — could not switch this session to
  Haiku. The plan's rule (absent, never downgraded) is *assumed*, and the
  null-never-a-default contract in `normalizeEffortLevel` is what makes being wrong here
  harmless.
- `context_window.used_percentage` as `null` — never null in 24 captures, but the guard stays.

### D8. The `pr` segment gets verified against a real PR in Phase 5

`pr` was absent from all 24 captures — this branch has no open PR — so the segment would
otherwise ship having never rendered live data.

**Decision:** rather than trusting the field reference or cutting the segment, Phase 5
pauses to capture a real one. Push the branch, open a throwaway PR, re-run the Phase 1
dump script for a single render, confirm `number` / `url` / `review_state` and how quickly
the field populates after opening, then close the PR.

**Rejected:** shipping it guarded-but-unverified (the null contract makes it *safe*, but
safe-and-never-exercised is how a segment silently never renders for anyone), and cutting
it from v1.0 (§9.5 already nominates it as the first cut if the line is crowded — that is a
layout call to make once the line is running, not a reason to drop it unseen).

### D9. `npx ampline-claude` with no flags always installs — no interactive menu

Resolves the third open question in §20.

**Decision:** keep §13's behavior. `process.stdin.isTTY` → run the installer immediately.
`npx <tool>` doing the obvious thing with zero prompts is the strong convention for
install-and-go CLIs, and it keeps the README's headline command a single line.

**Why not a menu:** it needs `readline`, a non-TTY fallback, and a `--yes` flag so scripted
and CI installs don't hang — real added surface area on `install.js`, which is the one
module in this project that can destroy a user's configuration. Discoverability is bought
more cheaply by the existing install footer, which already prints the uninstall and
config paths.

### D10. Bar width resolved to 8 cells

Resolves the first open question in §20 (plan default was 6).

**Decision:** `BAR_WIDTH = 8`, chosen by Carter after a side-by-side comparison of 6/8/10 rendered
against real percentages (1%, 8%, 23%, 50%, 62%, 87%, 99%) in the Phase 2 visual review. 8 gives
9 fill states at ~12.5%/block — a visibly finer read than 6's 7 states/16.7%-block — for two extra
columns, without reaching 10's 10%/block precision that starts crowding the line.

### D11. Stale marker stays dim-only, no `~` prefix

Resolves the fourth open question in §20.

**Decision:** no code change — `renderBar`'s existing `opts.stale` path (dim, no danger color,
no bold, no glyph) is correct as specified. Considered and rejected an additional `~` prefix.

**Why:** a stale bar already carries **zero danger color** while every live bar carries at least
green — that contrast (colored vs. uncolored), not brightness, is the real signal, and it survives
even in terminals that ignore the DIM SGR attribute outright. An explicit `~` would be a legible
backup for that edge case, but it costs a column on an already tight line and sits visually close
to the `↺` reset-countdown glyph a few characters to its right. Revisit only if real usage shows
the dim treatment getting missed.

### D12. Live `pr` capture — confirmed the field requires `gh` CLI installed *and* authenticated

D8 committed to verifying the `pr` field against a real payload before shipping `segments/pr.js`
unverified. Carter opened a real PR (carterptull/ampline-claude#1) against this branch and pushed
it himself. First attempt: 35 fresh captures with the PR open, zero carrying a `pr` field. `gh`
was confirmed absent from the machine at that point (checked both Git Bash and PowerShell `PATH`),
so that was recorded as the likely-but-unconfirmed cause.

**Confirmed on retry:** after Carter installed `gh` (`gh --version` → 2.97.0) and it turned out to
already be authenticated (`gh auth status` → logged in as `carterptull`), the exact same dump
technique captured `pr` populated in 7 of 9 fresh renders, immediately:

```json
{ "number": 1, "url": "https://github.com/carterptull/ampline-claude/pull/1", "review_state": "pending" }
```

Shape matches §1.1 exactly. `renderPrSegment` verified against this real object: renders `#1` in
the `pending` yellow, correctly.

**Decision:** no code change needed — `pr.js` was already correct, just unverified. This closes
the last open item from D7/D8. **`gh` CLI (installed and authenticated) is a real, undocumented
runtime precondition for the `pr` field** — not stated anywhere in the plan's field reference, and
worth a line in the README FAQ/limitations section in Phase 7. It does not need to be a stated
dependency of `ampline-claude` itself (the tool never calls `gh`; Claude Code does, internally, to
populate the payload) — the note is purely so a user without `gh` installed understands why the
PR segment never appears rather than assuming a bug.

### D13. `copyRuntime` rolls back on a failed swap

**Deviation from the plan.** §14's `copyRuntime` retires the existing install (`rename` to
`.old-<pid>`) and then renames staging into place. If that second rename fails, the plan's version
leaves the user with **no install at all** — the old one retired under a temp name, the new one
never moved in.

**Decision:** wrap the final rename; on failure, rename the retired directory back and delete
staging before rethrowing. Costs four lines and converts a total-loss failure into a no-op.

Consistent with the module's existing philosophy (never `rm` the live install before the
replacement exists) — the plan just didn't carry it through the last step.

### D14. `test/run.js` isolates HOME per fixture, not just per suite-run

**Deviation from the plan.** §15's `test/run.js` spawns each fixture against the real
`~/.claude/cache/ampline`. On this dev machine that produced an actual failing test:
`no-rate-limits.json` picked up a leftover cached `usage` entry from earlier manual testing and
rendered a countdown it shouldn't have — reproducing a real bug class (fixture non-determinism for
any contributor who has actually used the tool), not a bug in `usage.js` itself.

**First fix attempted, insufficient:** one shared throwaway `HOME` for the whole test run. This
still failed — fixtures run alphabetically, and `five-hour-only.json` / `float-percentages.json` /
`full.json` all carry live, non-expired `rate_limits` and run *before* `no-rate-limits.json`,
legitimately write-through-caching into the shared fake home. A later fixture in the same run then
correctly inherits that cache — same failure, different cause.

**Decision:** give every fixture (and the `NO_COLOR` check) its own `fs.mkdtempSync` home,
created and torn down per subprocess. Slightly more I/O than the plan's version; the only way to
make each fixture actually test its documented scenario in isolation, both from the developer's
real cache and from every other fixture in the same run.

### D15. `scripts/verify-pack.js` needs `shell: true` to invoke `npm` on Windows

**Deviation from the plan.** `execFileSync('npm', [...])` fails with `ENOENT` on Windows —
`npm` there is `npm.cmd`, a shim, and `execFileSync` without `shell: true` doesn't route
through PATHEXT resolution the way a real shell invocation does. Caught by actually running
the script locally rather than trusting it would work from the plan's snippet.

**Decision:** pass `shell: true`. Works identically on all three OSes, so no `win32` branch
needed. Matters beyond local dev — the CI matrix's `pack` job could have silently only ever
been exercised on `ubuntu-latest` per the plan, but any Windows contributor running
`node scripts/verify-pack.js` locally would have hit this immediately.

### D16. `context_window_size` was 1000000, not 200000

This account runs a 1M-token context. `used_percentage` is already normalized against the
real window size, so the context bar needs no change — but it confirms that reading
`used_percentage` directly (rather than deriving it from token counts) was the right call.

### D17. Bare `npx ampline-claude` with no TTY and no flag silently does nothing

Post-publish real-world testing (not fixtures): ran the actual published package against Carter's
real `settings.json` — `npx ampline-claude` (no args) from a non-interactive shell (this session's
Bash tool has no TTY) fell through to **statusline mode**, not the installer, and printed a
rendered-looking line to stdout instead of installing anything. Confirmed via hash: `settings.json`
was byte-identical before and after, no install directory created.

**Root cause:** `bin/ampline-claude.js`'s `main()` decides installer-vs-statusline on
`process.stdin.isTTY`, which is correct and load-bearing — Claude Code itself invokes the exact
same entry point with piped, non-TTY stdin on every real render. There is no way to distinguish
"a human ran this bare, from a script, meaning to install" from "Claude Code is rendering" using
TTY alone, since both are non-TTY.

**Not a bug in the installer logic** — `npx ampline-claude --install` (documented in the README as
the explicit alternative) works correctly regardless of TTY, verified in the same session: real
install (17 files copied, settings.json correctly repointed, all real hooks preserved) followed by
real uninstall (install dir and cache dir removed, statusLine/subagentStatusLine keys removed, all
other settings preserved) — both independently verified against Carter's actual machine, not a
throwaway test home.

**The actual gap:** silence. A scripted/automated `npx ampline-claude` invocation with no TTY and
no `--install` flag neither installs nor errors — it just prints something to stdout and exits 0,
giving no signal that nothing happened. Someone automating install (a dotfiles script, a setup
script) who doesn't pass `--install` would see no error and have no clue.

**Decision: left as-is for now**, not fixed in this pass. The documented workaround
(`npx ampline-claude --install`) already fully covers this for anyone who reads the README, and
the realistic audience for the bare command is an interactive human in a real terminal, where TTY
detection works correctly. A low-risk future improvement, if this bites someone for real: when
stdin arrives genuinely empty within the timeout AND not `--subagent`, print a one-line hint to
**stderr** (never stdout, to avoid corrupting a real render) suggesting `--install`. Not implemented
because it adds a branch to the entry point's dispatch logic for a scenario that has a documented
workaround and has not caused a real problem yet — revisit only if it does.
