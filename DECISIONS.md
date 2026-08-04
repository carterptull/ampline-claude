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

**Decision: implemented**, shortly after this entry was first written (`Fixed empty stdin bug.`,
`Fixed test file to support the stderr fixture.`). When stdin arrives genuinely empty within the
timeout and `--subagent` was not passed, `bin/ampline-claude.js` writes one line to **stderr**
only — "ampline-claude: no input received — if you meant to install, run `npx ampline-claude
--install`" — and never touches stdout. Verified byte-for-byte that stdout is unaffected.
Covered by `test/run.js`: `empty.txt` asserts the stderr hint fires (`expectStderr`), `full.json`
asserts it does not (`refuteStderr`), so a real render can never regress into printing it.

---

## Phase 2 — Pre-1.0 hardening pass (targeting v0.3.0)

Triggered by an explicit request for a security + release-readiness review before any public
1.0 tag. Five independent reviews ran in parallel (security/attack-surface, POSIX portability,
account-tier compatibility, core-logic correctness, release/packaging) against the v0.2.0 code.
One finding (D18) was verified directly, not just reported, before acting on it — same standard
Phase 1 held payload claims to.

### D18. CRLF shebang made `npx ampline-claude` fail on every non-Windows machine

**This was the release blocker.** `core.autocrlf=true` on this (Windows) dev machine, no
`.gitattributes`, so every tracked `.js` file's working tree copy carried `\r\n` — including
`bin/ampline-claude.js`'s first line: `#!/usr/bin/env node\r`. Verified directly:

```
working tree:  #!/usr/bin/env node \r \n     <- what `npm pack` ships
git blob:      #!/usr/bin/env node \n        <- what a fresh clone gets (git normalizes on commit)
```

`npm pack`/`npm publish` archive the **working tree**, not git blobs, and are unaffected by
git's own line-ending normalization. On POSIX, the kernel reads the shebang line and `env`
looks for a binary literally named `node\r`, which doesn't exist: `env: 'node\r': No such file
or directory`, exit 127 — before any statusline code runs. The published v0.2.0 tarball was
built on this same machine and almost certainly carries this.

**Why the existing 3-OS × 3-Node CI matrix never caught it:** three gaps line up. CI checks out
fresh on Linux, which materializes git's *normalized* LF blobs, so the CRLF working-tree state
never exists there. `test/run.js` invokes the binary as `spawnSync(process.execPath, [BIN])` —
explicitly through `node`, bypassing the shebang line entirely. And the `pack` job only ever
inspected the tarball's file *list* (`scripts/verify-pack.js`), never file *contents*. The
defect lived only in an artifact built on a Windows checkout, on a path none of the three
guardrails modeled.

**Decision:** add `.gitattributes` (`* text=auto eol=lf`, explicit for `*.js`) and normalize the
working tree to LF. Not sufficient on its own — see D20 for the durable fix, since a
`.gitattributes` file only prevents *this* checkout from reintroducing the bug, not a future
Windows contributor's.

### D19. Terminal escape sanitization — untrusted strings were reaching stdout unfiltered

The security review's sharpest finding: `.amplinerc.json` is loaded by walking **up from cwd**
(`config.js`), so a config file *committed to a repository* loads automatically the first time
that repo is opened. Every other config key was validated (`segments` allowlisted, numbers
range-checked), but `separator` was only type-checked, then joined straight into stdout
(`layout.js`). A repo shipping
`{"separator": "]8;;https://evil.example click here ]8;;"}` would render
an attacker-controlled OSC 8 hyperlink on every refresh — no prompt, no consent required.

The same gap existed for every other foreign string reaching a segment unfiltered: git branch
name (from `.git/HEAD`), `workspace.repo.name`, cwd basename, todo text (from
`~/.claude/todos/*.json` — model-authored, so a prompt-injected session could plant an escape
that persists across every future render), and subagent `label`/`description` (also
model-authored). `stripAnsi` already existed in `colors.js` and correctly handled both SGR and
OSC sequences, but was only ever applied when `config.color === false` — the exact control that
would have prevented this was present, correct, and unreachable in the default colored path
every user runs.

**Decision:** add `colors.js: sanitize(s)` — strips C0/C1 control characters (including ESC,
DEL, and the CSI/OSC bytes 0x9b/0x9d) and the Unicode line/paragraph separators U+2028/U+2029.
Applied at the point each foreign string is read, before any truncation or interpolation:
branch name, dir/repo name, task text, subagent label/description, model `display_name`/`id`,
and config `separator`. Deliberately narrow (control chars only, not a general allowlist) so it
can't reject legitimate Unicode in branch names or todo text. As a side effect, this also closes
a correctness bug the logic review found independently: `separator: "\n"` used to produce a
5-line statusline (LF is a control character, now stripped).

### D20. `git status` hardened against a hostile `.git/config`

`git status` runs the `core.fsmonitor` hook command from the repo's own `.git/config`, and
ampline-claude fires this **automatically on every render** — merely opening Claude Code in a
directory obtained as an archive (not a `clone`, which doesn't transfer `.git/config`) with a
crafted fsmonitor command is arbitrary code execution with no git command ever typed by the
user.

**Decision:** add `-c core.fsmonitor=` (disables it for this call only) and `--no-optional-locks`
to the `execFileSync('git', ...)` argv in `git.js`. The second flag is independently worth
having regardless of the security angle — without it, the statusline was taking the index lock
every 30s (`refreshInterval`) and could contend with a concurrent interactive git command.

### D21. Surrogate-pair-unsafe truncation fixed in three segments

`truncateBranch` (`git.js`), `decorate` (`task.js`), and `truncate` (`subagents.js`) all
truncated with `.slice()`, which operates on UTF-16 code units, not code points. A branch name
or todo text with an emoji near the truncation boundary could have its trailing character split
mid-surrogate-pair, rendering a literal `�` in the statusline.

**Decision:** switch all three to `Array.from(str)` before slicing, which iterates by code
point. Deliberately not a full grapheme-cluster-aware truncation (combining marks, ZWJ
sequences, flag sequences can still visually misbehave) — that's a materially bigger change
for a cosmetic-at-worst failure mode once the mojibake case is closed, and is noted as a
follow-up rather than done here.

### D22. `pr.js` could render a phantom `#0`

`Number(pr.number)` followed by `Number.isFinite` let `null`, `''`, `false`, and `[]` all pass
through as `0` — a payload shaped like `pr: { number: null }` (plausible for "no PR, but the
key is present") would render a fake `#0` PR link.

**Decision:** require `Number.isInteger(number) && number > 0`. GitHub/GitLab issue and PR
numbers start at 1, so this rejects nothing real.

### D23. `usage.js: toMs()` guarded against a unit-confusion footgun

D6 confirmed `resets_at` as 10-digit epoch **seconds** across 24 live captures, and `toMs()`
multiplies every numeric value by 1000 on that assumption. If a future payload ever emitted
milliseconds instead (13-digit), the multiply would land the result ~58,000 years in the
future. Worse: `keepIfCurrent` only drops a cached window once it's *past* its reset time, so a
value that can never appear "past" would stay wedged in the cache indefinitely, rendering an
absurd countdown (`↺ 20646577d9h`) on every subsequent cold start.

**Decision:** if the numeric value exceeds `1e11`, treat it as already milliseconds rather than
multiplying — a real epoch-seconds value won't cross that threshold until the year ~5138. Also
added a blanket sanity bound: reject any `resets_at` implying a reset more than 60 days out,
regardless of which branch produced it. No legitimate rate-limit window resets that far out
under any unit.

### D24. `CLAUDE_CONFIG_DIR` honored via a new `lib/claudeDir.js`

`os.homedir()/.claude` was hardcoded independently in `install.js`, `cache.js`, and
`segments/task.js`. Claude Code itself honors `CLAUDE_CONFIG_DIR` for a redirected config
location (roaming profiles, some org-managed setups); ignoring it meant the installer could
report `✓ ampline-claude installed.` while writing to a `settings.json` Claude Code never reads
— success output with zero actual effect, the worst failure mode for a support conversation.

**Decision:** add `lib/claudeDir.js` exporting `claudeDir()`, resolving
`process.env.CLAUDE_CONFIG_DIR || ~/.claude`. All three call sites now go through it. Kept as
its own tiny module rather than folded into `cache.js` (which has no reason to be a dependency
of `install.js`) or duplicated three times.

**Explicitly not attempted this pass:** detecting an enterprise `managed-settings.json` that
might override a user-level `statusLine`. Unlike `CLAUDE_CONFIG_DIR` (a documented Claude Code
env var), the managed-settings precedence behavior is unverified from this account — the same
caution D8 applied to the `pr` field (pause and verify against a real payload rather than ship
a guess) applies here. A wrong heuristic that falsely warns a normal user is worse than no
detection. Flagged as a real gap, not silently assumed away.

### D25. Model segment length capped (extends D1)

D1 committed to rendering `display_name` as-is because real values are short (~10-15 chars,
e.g. "Sonnet 5"). That reasoning doesn't extend to the `|| model.id` fallback path, which on a
Bedrock/Vertex/gateway model can be a 40-100+ char ARN or inference-profile id — unbounded, it
would blow out the line and force a spurious two-line wrap.

**Decision:** cap the rendered name at 32 chars (well above any real `display_name`, well below
a pathological id) via the same `Array.from`-based code-point-safe truncation as D21. D1's
core claim — a real display name is never truncated — is unaffected, since 32 chars never
fires on one.

### D26. `layout.js` gained a `COLUMNS` fallback

D5 confirmed `COLUMNS` is set on Windows for the main-statusline invocation. It was never
verified on macOS/Linux, and in bash/zsh `COLUMNS` is a shell variable, not an exported env
var, by default — a child process only inherits it if the parent explicitly exports it.
Previously, an unset/non-numeric `COLUMNS` disabled wrapping entirely: `layout()` would return
a single line at any width.

**Decision:** add `DEFAULT_COLUMNS = 120` as a fallback when `COLUMNS` doesn't parse. Chosen to
match the value `test/run.js` already pins for the fixture suite, so the wrap path stays
exercised by the same width it's tested at. Not a substitute for verifying what Claude Code
actually passes on macOS/Linux — still an open item — but "wrap at a reasonable guess" is
strictly better than "never wrap."

### D27. `install.js` prefers `process.execPath` over a bare `node`

The generated `statusLine.command` was `node "<entry>"`, relying on the child process's
inherited PATH containing `node`. Reliable on Windows (`node` is almost always on the system
PATH); not guaranteed on macOS/Linux with a version-managed Node (nvm/fnm/asdf keep `node` on a
shell-init-managed PATH) if Claude Code is ever launched from a GUI context (Dock, Finder)
rather than a terminal that sourced the shell init. The failure mode is a blank statusline
indistinguishable from the degradation contract working as designed — no diagnostic at all.

**Decision:** prefer the absolute `process.execPath` (the Node binary currently running the
installer) when it resolves to a real file, falling back to `node` otherwise.
**Trade-off accepted:** a version-specific nvm path (e.g.
`~/.nvm/versions/node/v22.13.1/bin/node`) survives a later `nvm use` switching the *default*,
since nvm doesn't delete prior versions on a version switch — it only breaks if that specific
version is later uninstalled, which is rarer than the PATH gap it fixes. Unverified on real
macOS/Linux hardware; flagged for confirmation alongside D18.

### D28. `install.js` preserves `settings.json`'s file mode and symlink identity

Two related gaps in `writeSettings`. First: the atomic write (tmp file + rename) created the
tmp file at the umask default, then renamed it over the target — a user who'd deliberately
`chmod 600`'d a `settings.json` holding API keys in `env` blocks would silently end up
world-readable after any install/uninstall. Second: `renameSync` replaces a symlink with a
plain file rather than writing through it — dotfiles managers (stow/chezmoi/yadm) commonly
symlink `settings.json` into a tracked repo, and this would silently sever that link.

**Decision:** `writeSettings` now resolves the real target via `fs.realpathSync` before writing
(falls back to the plain path on `ENOENT`, i.e. a fresh install with no existing file), reads
the original file's mode via `fs.statSync`, and `chmod`s the tmp file to match before the
rename. Confirmed the install/uninstall round-trip still works end to end (backup, cache dir,
runtime copy, statusline render through the installed copy) via a throwaway-`HOME` smoke test.
**Not independently verifiable on Windows** — there are no real POSIX permission bits here, so
`chmod 600` was a no-op in the test environment; the logic is straightforward (stat, chmod,
rename) but needs confirmation on a POSIX box.

### D29. `package.json` no longer declares `main`; `bin/ampline-claude.js` guards its own entry

`main` pointed at the CLI entry point, and the entry point called `main()` unconditionally at
module load. `require('ampline-claude')` — a REPL, a test harness, an accidental import —
would run a real install as a side effect, mutating the importer's `~/.claude/settings.json`.

**Decision:** drop `main` (a CLI package doesn't need one; `bin` is sufficient) and add
`if (require.main === module) main();` regardless, so the behavior can't recur even if a `main`
field is ever reintroduced for some other reason.

### D30. `rateLimits.js` segments wrapped in `try/catch` for consistency

CLAUDE.md states every `render*Segment(ctx)` wraps its body in `try/catch`. `renderFiveHourSegment`
and `renderWeeklySegment` didn't — harmless in practice, since `render.js` already wraps every
segment call site, but it made a documented invariant false in a public file.

**Decision:** add the wrapper to both, matching every other segment, so the documented rule is
actually true rather than merely "true because of a different layer."

### D31. Git dirty semantics (`--untracked-files=no`) kept, not changed — now documented

The logic and release reviews both independently flagged the same thing: a repo whose only
change is new untracked files renders `✓` (clean), which reads as stronger than it is. The
`--untracked-files=no` flag was a deliberate perf choice (avoids scanning untracked files,
consistent with the "one git call, hard timeout, minimize subprocess cost" rule), not an
oversight — but it was undocumented, so users would reasonably assume `✓` means "nothing
changed" rather than "nothing tracked changed."

**Decision:** keep the flag (changing it trades a real perf property for a case that's a
narrower-than-expected signal, not a wrong one) and document it instead — in `README.md`'s
segment table and a dedicated callout, and in `CLAUDE.md`'s module layout. Consistent with this
project's established pattern (D9, D11) of resolving a surprising-but-intentional behavior by
documenting it rather than changing it, unless the behavior is actually wrong.

### D32. `NO_COLOR` stale-bar visibility (D11) — flagged, not reversed

The logic review found that D11's justification ("a stale bar carries zero danger color while
every live bar carries at least green — that contrast survives even in terminals that ignore
DIM") only holds when color is enabled at all. Under `NO_COLOR=1`, a live 60%-usage bar and a
stale 60%-usage bar render **byte-identical** — there is no stale signal whatsoever in the
no-color path, which is exactly the gap D11's rejected `~` prefix would have covered.

**Decision:** not resolved this pass. D11 was an explicit, deliberate call Carter made after a
visual side-by-side review; reversing it unilaterally in a hardening pass isn't this session's
call to make. Recorded here as a confirmed gap in the existing decision's own stated reasoning,
for Carter to weigh directly rather than silently overridden or silently left inconsistent.
