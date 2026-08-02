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

### D10. `context_window_size` was 1000000, not 200000

This account runs a 1M-token context. `used_percentage` is already normalized against the
real window size, so the context bar needs no change — but it confirms that reading
`used_percentage` directly (rather than deriving it from token counts) was the right call.
