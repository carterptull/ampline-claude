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

**Update (2026-10-14):** Claude Code's current documentation lists an optional `name` (the
name the subagent is addressed by) and an `agentType` (v2.1.293 and later, the same value
hooks receive as `agent_type`), so "unbuildable" no longer holds. The display chain is now
`label || description || name || agentType || 'agent'` (D41). The payloads captured above
predate those fields and have not been re-captured, so whether a live payload carries them
is documented, not observed.

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

**Update (v0.6.0):** this precondition is narrower than first recorded. Claude Code also accepts
`GH_TOKEN` / `GITHUB_TOKEN` for GitHub, and since v2.1.234 fills `pr` for GitLab merge requests
through `glab`. See D38.

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

**Follow-up (2026-10-25): the fsmonitor override was not the whole story.** An audit before 1.0
found that this entry, and the CHANGELOG line and diagram text that repeat it, claimed more than
`-c core.fsmonitor=` delivers. That flag closes one mechanism. `git status` also runs content
filter drivers that a repository's own config defines and that `.gitattributes` selects, and it
honors `include` and `includeIf` files named in that config. The precondition is a repository
directory that arrives with its own config: an extracted archive, or an embedded bare directory
inside a clone. Claude Code itself runs git in the workspace, so the added exposure is that
ampline repeats the call on every render. The original text above stands as the record of what
was believed then.

**Decision:** before the subprocess, `git.js` scans the repo-local config files: `<gitdir>/config`
and `<gitdir>/config.worktree`, plus, for a linked worktree, the same two files in the common
directory found through the `commondir` file. If any of them defines a `[filter ...]` section
(any key), an `[include]` or an `[includeIf ...]` section, or cannot be read or parsed (not a
small regular file, over 256 KB, malformed header), ampline does not run `git status` in that
repo. The branch still renders from `HEAD`; the ahead/behind/dirty marker is left out and no
`git:` cache entry is written. The scan runs before the cache is read, so an untrusted repo never
serves a result either. As a belt-and-braces rule, any `[` followed by `filter` or `include`
anywhere in the text (a comment or a value included) also counts as untrusted; those false
positives are accepted.

A second finding from review: the scanner read the files ampline THOUGHT git would read, not the
files git reads. Three divergences existed (an embedded bare directory at the cwd that git treats
as the repository while ampline walked up to an outer one; a `commondir` value git reads
literally, minus trailing line breaks, while ampline trimmed it; and a `.git` file whose
`gitdir:` value git also reads literally while ampline's pattern skipped extra spaces). The
fixes, and what is deliberately not done:
- ampline's parsing of the gitfile and `commondir` is STRICTER than git's: git strips all trailing
  CR/LF, ampline accepts one trailing newline and treats any other oddity (leading or trailing
  whitespace, a carriage return, an embedded newline, an empty value) as untrusted and skips the
  call.
- `commondir` and the `.git` file's target are resolved the way git does it: `"<dir>/<value>"`
  handed to the real-path call as one string (symlinks followed before `..`), not collapsed
  textually; the git dir is validated and read there. A failed lookup is untrusted. The textual
  path stays only as the cache key.
- git is started with its working directory set to the directory that holds the `.git` entry
  ampline scanned (git checks `<dir>/.git` first), so its own discovery begins at that entry and
  it keeps its own ownership (`safe.directory`) check. It starts there, but git does not
  necessarily END there: a `.git` directory that fails git's `is_git_directory` check (HEAD,
  `objects/`, `refs/`) is skipped by git, which then walks up to a parent repository ampline never
  scanned. So ampline mirrors that check (failing it skips the call) and also sets
  `GIT_CEILING_DIRECTORIES` to the work tree's parent, which keeps git inside the scanned work
  tree (it fails instead of walking up) without giving up discovery or the ownership check.
  `--git-dir` and `--work-tree` were tried and rejected: they skip discovery and with it the
  ownership check (with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, unpinned git refuses and pinned git
  runs). Do not re-add them. `-c safe.bareRepository=explicit` is added; `GIT_NO_LAZY_FETCH=1`
  goes in the child's environment; and the inherited variables that name a repository
  (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`) are removed from it.
- A bare-looking directory between the cwd and the repository still skips the call, as defense in
  depth (cheap, and its only false positive is a cwd that really is a git dir).

Two more narrowings: `--ignore-submodules=dirty` (submodules have their own config, which is
not scanned, so `git status` must not recurse into them; trade-off: a submodule whose work tree
is dirty no longer sets the dirty marker, while a moved submodule commit still counts) and the
reclassification of `--no-optional-locks` as a real defense, not a courtesy: without it
`git status` refreshes and writes the index, and a repository-local post-index-change hook can
run.

What this does and does not block, stated precisely:
- Turned off or skipped: fsmonitor (overridden on the command line); optional index writes; git
  running inside submodules; and, by skipping the call, repo-local filter drivers and includes.
- Not blocked: everything else in a repository's own config is trusted as when you run git
  yourself in that repository. As with any tool that runs `git status` there, a repository's own
  configuration is trusted unless ampline detects a filter or include in it. The scan reduces,
  and does not eliminate, what a repository's own configuration can make git do on every render;
  it is not a sandbox.
- Not scanned on purpose: global and system config (a user's own LFS filter, for example, keeps
  working because it is not repo-local).

**Alternatives considered:** requiring the repo directory to be owned by the current user (cheap
but platform-specific and does not cover a user who unpacked the archive themselves); dropping
ahead/behind/dirty or making it opt-in (loses a feature for everyone to guard a narrow case);
asking git to parse the config (`git config`) would add a second subprocess to every render. The
scanner is a conservative header check, not a full config parser, and errs toward skipping the
call.

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

**Amended by D44:** Homebrew and the other version managers break that trade-off, so a stable
PATH entry for the same binary is now preferred when one exists.

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

### D33. Context percentage is per-completed-call, not a live counter

Reported from a real session: Claude's own response text said 87% context used while the
statusline showed `C78`. The obvious reading is that the statusline is stale and needs to
refresh more often. That reading is wrong, and acting on it would have meant lowering
`refreshInterval` for no benefit.

Read against Claude Code 2.1.222, the payload field `context_window.current_usage` is
documented in the CLI's own embedded schema as "token usage from last API call". The
statusline itself displays `context_window.used_percentage`, a sibling field in the same
block, not `current_usage` directly. The whole `context_window` block advances together
once per completed API call, so the claim holds for `used_percentage` too. It does not
track tokens continuously as a response streams. During one long single-call response there
is no fresher number in existence for any statusline to display.

The render path is not the bottleneck either. `tokenUsage` is a watched dependency on a
debounced re-render of roughly 300ms, so a changed value reaches the statusline almost
immediately. `refreshInterval` is documented in the same schema as re-running the status
line command every N seconds "in addition to event-driven updates". It is a supplementary
timer, not the primary mechanism.

**Decision:** `refreshInterval: 30` in `lib/install.js` is correct and stays. Lowering it
would re-invoke the hook more often with an unchanged value. The gap is documented in the
README as a property of the field rather than presented as a limitation of this tool, and
the README says explicitly that `refreshInterval` does not affect it, because that is the
wrong fix a reader would otherwise try.

Also rejected: exposing `refreshInterval` through `.amplinerc.json`. That file is read by
ampline-claude at render time, while `refreshInterval` is read by Claude Code from
`settings.json` at session start. A setting that looks live but silently needs a reinstall
to take effect is worse than no setting.

### D34. Ultracode cannot be distinguished from plain `xhigh`, so it is not displayed

Enterprise accounts offer an "ultracode" mode, announced in the CLI banner as "xhigh effort
+ dynamic workflows for maximum thoroughness". It is available on Sonnet, Opus, and Fable.
A plain `xhigh` session and an ultracode session behave very differently, so showing them
identically hides something real.

Read against Claude Code 2.1.222, the CLI's own schema documentation lists these top-level
fields for the statusline payload object: `session_id`, `model`, `workspace`,
`context_window`, `effort`, `thinking`, `rate_limits`, `vim`, `agent`, `pr`, and `worktree`.
That is the field list the schema gives for that object, not the full set of fields the
live payload carries — D7 records fields confirmed from real captures, including several
not in this list. No ultracode key exists in either source. `effort.level` is one of `low`,
`medium`, `high`, `xhigh`, or `max`, and an ultracode session reports literally `xhigh`.

Claude Code does track a distinct internal ultracode boolean, and there is a documented
field for it in the subagent and worker IPC protocol, described as whether ultracode is
active for the session. That flag is normalized to `xhigh` before the statusline payload is
built. The internal mapping table reads `{ ultracode: "xhigh" }`.

**Decision:** not displayed, because it cannot be. This is not "unverified, capture a
payload later". It is confirmed absent from the schema. Two designs were considered and
both are moot: a 17th wheel color, and a plain text marker appended to the model segment.

The wheel color was independently the wrong shape regardless of data availability. The
wheel is deliberately two-dimensional, color for model and position for effort. Ultracode
spans three model families, which makes it an orthogonal mode axis rather than a property
of either dimension. Encoding it as a hue would put a third variable into a scale built for
two and cost the glance-and-know property the wheel exists for.

If this is ever wanted, it is a feature request against Claude Code to add an `ultracode`
boolean to the statusline schema. It is not something ampline-claude can solve.

The schema docstrings behind this entry are the durable evidence. The minified internals
also inspected, the React effect driving re-renders and the normalization table, are
implementation details that can change between releases without notice. Re-verify against
the current build before relying on them.

### D35. `rate_limits` is absent on enterprise and Teams accounts

On a ConstructConnect enterprise account the `fiveHour` and `weekly` segments never
appeared. On a personal Claude.ai Pro account they appear normally. Both machines were
running Claude Code 2.1.222, so this is account entitlement and not a version difference.

Claude Code sends `rate_limits` only for account types that actually have enforced 5-hour
and weekly usage windows. Enterprise and Teams accounts do not, so the field is missing
from the payload. `lib/segments/rateLimits.js` returns `null`, and `render.js` leaves the
segments out.

**Decision:** no code change. This is the degradation contract in `CLAUDE.md` working as
designed, where a segment with insufficient data returns `null` and is omitted. It was
documented in the README rather than fixed, because there is nothing to fix.

The default `line2From` is `"fiveHour"`, and `lib/render.js` computes the line 2 split from
a segment's position in the configured list rather than from whether it rendered. On an
enterprise account the split point is therefore a segment that never renders. This does not
misbehave: every segment between `fiveHour` and the next one that does render is also null,
so the split lands in the same place a differently-chosen `line2From` would anyway. Nothing
breaks either way, since `layout.js` handles an empty line 2 and the shortened line usually
collapses back to one line. No README change or config recommendation follows from this,
since the default already produces the right result.

### D36. Real Linux verification, closing D18 and D27's open questions

Every prior claim about macOS/Linux behavior (D18's CRLF shebang fix, D26's `COLUMNS`
fallback, D27's absolute-node-path resolution) had been reasoned about but never run on
real non-Windows hardware. Run on Ubuntu 22.04 via WSL, Node 20.18.1 installed as a plain
user-space tarball rather than through a system package or PATH-managed shim, to match the
non-standard-PATH condition D27 was actually written for.

Confirmed directly, not inferred: the full fixture suite and `syntax-check` pass unchanged;
`bin/ampline-claude.js` executes directly via its shebang with no CRLF problem; the
installed copy's `--version` reports a real number; UTF-8 glyphs (box-drawing, blocks, dots)
survive intact with no replacement characters; `NO_COLOR` strips all ANSI output and the
default and `COLORTERM=truecolor` paths both produce it. `--install`, a second `--install`
(confirming the settings backup fires and is not duplicated), and `uninstall` were run
end to end against a scratch config directory: `resolveNodeCommand()` correctly wrote the
absolute path to the Node actually running the installer, not a bare `node`, exactly D27's
intended behavior, on a Node binary that was not on the system's default PATH.

**Decision:** the README's macOS/Linux caveat is corrected to reflect Linux as verified.
macOS remains unverified, since nothing here ran on macOS hardware. Also unverified: what
`COLUMNS` and other environment variables a real Claude Code process supplies when it
invokes the hook on Linux (D26 remains open on that specific point) — this pass verified
the binary's own behavior under controlled invocation, not a live Claude Code session.

**Update (2026-10-14):** v0.7.0 rendering, including the pace marker glyph, was confirmed on
a real Mac (see D39). That check does not cover the macOS install and uninstall flow, or the
environment variables a real Claude Code process supplies, so those remain open.

## Phase 3 — v0.6.0: Haiku 5.5 effort and GitLab merge requests

### D37. Haiku 5.5 gets a five-stop blue ramp; no-effort Haiku keeps its flat blue

Haiku 4.5 sent no `effort` field, so Haiku was the one flat color on the wheel (`#7DB8E8`) and
`normalizeEffortLevel` returning `null` for it was the whole story. Haiku 5.5 supports all five
effort levels (`low` to `max`, default `medium`), and Claude Code's statusline docs say
`effort.level` is present exactly when the model supports the effort parameter. So a Haiku 5.5
session now prints `Haiku 5.5 · medium`, and one flat color would have been the only model
family where the effort word has no color cue.

**Decision:** Haiku gets its own gradient: `#3D64E8`, `#4D79E8`, `#5D8EE8`, `#6DA3E8`, then
`#7DB8E8` (the old flat blue) at `max`. The wheel is 20 steps. Haiku **without** effort data
(Haiku 4.5, `effort: null`, a numeric budget, an unknown string) still returns `#7DB8E8`
exactly. Every other family keeps falling back to `high` for missing effort; Haiku does not,
because "Haiku with no effort" must look like it always has rather than jump to a mid-blue.
Subagent rows are colored by family and rarely carry effort, so they stay on the flat blue.
When a Haiku subagent task does send an effort level string, it follows the same ramp as the
main line, and a numeric token budget still normalizes to no effort (covered by tests).

**How the stops were chosen (measured, not eyeballed).** CIE76 ΔE between adjacent stops is
15 to 16, above the tightest existing wheel step (Opus high to xhigh, 10.5). Contrast of the
darkest stop on a `#1E1E1E` terminal is 3.3, the same as Opus max and better than Fable max
(2.1), so no stop is dimmer than something already on the wheel.

**Rejected:**
- *A light-blue-to-cyan ramp inside the old gap* (`#7DB8E8` toward Sonnet low `#5CE8D0`): five
  stops fit at only ΔE 5 to 7 apart, which reads as "Haiku, slightly shifting" and cannot be
  told apart at a glance.
- *A deeper navy start* (`#2846C8`): contrast 2.2 on a dark background, equal to the dimmest
  thing on the wheel, for ΔE spacing the chosen ramp already clears.
- *Leaving Haiku flat.* Viable, but then Haiku is the one family whose effort word has no color.

The ramp is a hue-and-lightness path through blue, so the wheel's overall sweep (blue, cyan,
green, yellow, orange, red, pink, violet, purple) is unchanged. `max` stays the only bold level.

### D38. GitLab merge requests render as `!N`; the number is a validated hyperlink

Claude Code v2.1.234 added GitLab merge request support: with a GitLab remote and `glab`
authenticated, `pr.number` / `pr.url` / `pr.review_state` describe the merge request and
`pr.kind` is `"mr"` (absent for GitHub). This is the capability the feature request in the
v0.5.0 notes asked for. `pr.js` was already host-agnostic, so MRs rendered as `#N`.

**Decision, label:** `pr.kind === 'mr'` (exact match only) renders `!N`, GitLab's own reference
syntax and the one Claude Code's footer badge uses. Anything else renders `#N`. The `kind`
string is never interpolated, so a hostile value cannot reach stdout. `kind` arrived in the
same Claude Code version as MR support, so absent reliably means GitHub; the URL is never
inspected to guess the host.

**Decision, link:** the label is wrapped in an OSC 8 hyperlink so it is clickable in terminals
that support it, matching the badge Claude Code shows in its own footer. `pr.url` is a foreign
string that ends up inside an escape sequence, which is exactly the shape of injection D-notes
elsewhere guard against, so the link is conditional on `safeLinkUrl()`: a string of at most
2048 characters, entirely printable ASCII (no ESC, BEL, newline, space, DEL, or non-ASCII),
that parses as a URL with scheme `https:` and no username or password. The parsed `href` is
emitted, not the raw string, and re-checked against the same character class. Failing any
check drops the link and keeps the colored number. The sequence is BEL-terminated, the form
Claude Code's own statusline docs use, and `stripAnsi` already removes it for width math, so
wrapping is unaffected. `NO_COLOR` means plain text, so no link is emitted there either, and
`"color": false` strips it through the existing `stripAnsi` pass.

**Rejected:** a host allowlist (self-managed GitLab and GitHub Enterprise hosts are arbitrary);
inferring `kind` from the URL; skipping the link because Claude Code's footer already has a
clickable badge (the statusline link is wanted, and the validation makes it safe).

**Also fixed here, found in review:** `pr.number` went through bare `Number()`, which accepted
`true`, `[5]`, `" 5 "`, `"0x10"` and `1e21` and printed something other than a PR number
(`#1e+21`, `#16`). It now takes a real number or a plain digit string and requires a positive
safe integer, otherwise the segment is omitted. The test runner also now scrubs `NO_COLOR` and
`FORCE_COLOR` from the child environment, because with color off nothing emits a link and the
hostile-URL tests would pass without testing anything.

**Also fixed here:** `REVIEW_COLORS[pr.review_state]` used a foreign string as a bare object
key, so `review_state: "constructor"` resolved to `Object.prototype.constructor` and printed
function source into the statusline. It is now an own-property lookup (`Object.hasOwn`),
covered by tests for `constructor`, `toString`, `__proto__`, and `hasOwnProperty`.

**What is verified and what is not (2026-10-07).** The payload shape comes from Claude Code's
published statusline and interactive-mode docs, not from a live GitLab capture. The fixture
suite and a 23-case replay of GitHub, GitLab, and hostile payloads through the real binary pass.
Confirming that a live Claude Code session actually sends `pr.kind: "mr"` for a GitLab branch
needs `glab` authenticated on a machine with a GitLab remote, and has not been done yet.
GitHub's `gh`-based path is the one verified live (D12). D12's "`gh` required" is also now
slightly narrower than the truth: Claude Code also accepts `GH_TOKEN` / `GITHUB_TOKEN`.

## Phase 4 — v0.7.0: pace on the usage bars

### D39. The usage bars carry a pace marker: one `┃` cell for how much of the window has elapsed

A usage bar answers "how much have I spent". It cannot answer "is that a lot, for this far into
the window". 80% used with ten minutes left is fine, and 50% used with a fifth of the window
gone is not, and a bar that shows only the fill reads both the same. The payload already carries
`resets_at`, so the elapsed fraction of the window is computable with no new data source.

**Decision:** `renderBar` takes an optional `opts.marker`, the elapsed fraction 0 to 1. One of
the eight cells is replaced by `┃` (U+2503) at `min(7, floor(marker * 8))`. A fill head ahead of
the marker means quota is being spent faster than the clock. The width stays exactly 8
(`BAR_WIDTH`, D10), and the number beside the bar stays the exact, rounded percentage.
`elapsedFraction(resetsAtMs, windowMs, now?)` in `lib/usage.js` returns that fraction, or `null`
when the reset time is missing, already past, or farther out than the window is long. `null`
draws no marker.

**Why a glyph and not a color.** `NO_COLOR` empties `fg`, `BOLD`, `DIM` and `RESET` (D32), and
inverse video is an SGR attribute so it goes the same way. Recoloring one cell would also
need a second color channel on a bar that already uses its one color for urgency. A substituted
glyph is the only technique that still reads with no color at all, and it adds no color or bold
of its own, so "color = identity, bold = urgency" is untouched. It is tested with colors on
(no escape sequence inside the bar run) and with `NO_COLOR` in a real child process.

**Why `┃`.** A full-height heavy line reads as a pole between solid `█` cells and stands out
against the `░` texture, so it is legible on both filled and empty cells. It is East Asian
Ambiguous width, the same class as the `█` and `│` the line already uses, so it adds no new
width risk. Measured on one Windows 10 machine with Windows Terminal's Cascadia Mono, Consolas
and Lucida Console: `┃` is present in Cascadia Mono and Consolas, and Windows Terminal draws
U+2500 to U+259F itself regardless of font.

**Rejected:**
- *A contrasting foreground on one cell.* Invisible without color, and weak against `░`.
- *Inverse video.* Dropped with the other SGR attributes under `NO_COLOR`, and a solid inverted
  `░` reads as "filled".
- *The thin glyphs `▏ ▎ ▕`.* They hug a cell edge so they read as a boundary, and Consolas and
  Lucida Console lack them.
- *Widening the bar by one cell for the marker.* `BAR_WIDTH` is settled (D10), and the line
  already wraps at 120 columns when every segment is present.

**The window lengths are assumptions.** The payload has `resets_at` and never the window
length, so `rateLimits.js` hardcodes 5 hours and 7 days. A wrong constant moves the marker, and removes
it when the assumed window is shorter than the real one. With `paceColors` on it also changes
the color (D40). It cannot change the percentage or the countdown. `toMs` already rejects a reset more than 60
days out.

**No marker on the stale path.** A stale bar drops its urgency signals (D11). The marker
compares quota to a live clock, so against a possibly outdated cached quota it would mislead.

**Known cosmetic cost.** The marker cell no longer shows whether it was filled, so the visible
fill can be off by one cell there. `H50 ████┃░░░` and `H60 ████┃░░░` look the same. The
number beside the bar disambiguates. Because the fill is rounded to whole cells and the marker
sits in one of them, the two can only be compared to about one cell, an eighth of the window.
In live use, 7% used with the marker in the first cell rendered as `H7 ┃░░░░░░░`: the one
filled cell is hidden under the marker, and only the number shows that anything is used.

**What is verified and what is not (2026-10-13).** The fixture suite, in-process unit tests of
the math with an injected clock, a mutation matrix over the window constants and the stale
path, and an independent review of the bar change pass. Glyph and font coverage were measured
on one Windows 10 machine by a script that is not kept in the repo. The real binary, run on
Windows 10 with Node 24.21.0, puts the marker in the expected cell at eight positions across a
5-hour window (a throwaway sweep script, also not kept). Hardening tests cover `"color": false`,
reset times given as epoch seconds, milliseconds, ISO text and a numeric string, layout parity
(the marker changes neither line width nor the wrap decision at 200, 120 and 80 columns), and a
seeded fuzz of 4000 hostile segment inputs. Each of those guards fails the suite under a
targeted mutation.

**Verified by Carter, 2026-10-14.** The throwaway sweep, `--ruler` and `--pace` runs on
Windows 10 in PowerShell were reported as verified. A live Claude Code 2.1.300 session on
Windows then showed `H7 ┃░░░░░░░ ↺ 4h52m │ W1 ░┃░░░░░░ ↺ 6d2h`: both markers sit in the
computed cells (about 2.7% and 13.1% of the window elapsed). That payload reported 4h52m
left eight minutes into a window, which is consistent with the assumed 5-hour length. Carter
also reported the build working on a Mac. The macOS terminal app, and whether that was a
live session or the check script, were not recorded.

**Not yet verified:** the macOS terminal app and font (Terminal.app or iTerm2), that
`resets_at` at the very start of a real window is exactly 5 hours out (one data point so
far), and any terminal beyond those. WSL here has only Node 16, below the `engines` floor of
24, so it was not run; Linux on Node 24 is covered by CI.

### D40. `paceColors`: the ramp can be read at projected pace, never calmer than the plain ramp and capped at orange

The marker (D39) shows pace but leaves the color on current use. 40% used with a fifth of the
window gone is on course to run out and shows a calm green. The danger ramp could be read at
where the pace is heading.

**Decision:** an opt-in boolean, `"paceColors": true`, default `false`. When on, the 5-hour and
weekly bars read the ramp at `max(used, min(84, used / elapsed))`, and only once at least 10% of
the window has elapsed. `renderBar` takes `opts.rampPct` for this and uses `max(used, rampPct)`,
so no caller can lower urgency. The displayed number and fill are never changed, only the color
the ramp is read at.

**Never calmer than the plain ramp, by construction.** The elapsed fraction is at most 1, so
`used / elapsed` is never below `used`, and the reading is clamped to at least `used` regardless.
At any given moment pace is therefore equal to or more urgent than the plain ramp. Over time a
bar can settle: 40% used reads orange at 20% elapsed and yellow at 80%, as the projection comes
down toward the real number. It also does not make "80% used with ten minutes left" calmer:
that projects to about 83% on the 5-hour bar, the same step as now. What it adds is early
warning, which is the case the plain ramp misses.

**Why capped at 84.** `dangerStyle` goes bold at 85 and adds the warning glyph at 95, and bold
is reserved for urgency now (CLAUDE.md). A projection is "on course to", not "is". Uncapped,
30% used with a fifth of the window gone would project to 150% and print a bold `⚠` beside a
"30". Capping at 84 lets pace reach orange at most, so only real consumption shouts.

**Why a 10% deadband.** One minute into a 5-hour window, 1% used projects to 300%. Below 10%
elapsed the result is noise, so the real percentage is used instead. 10% is 30 minutes of the
5-hour window and about 17 hours of the weekly one. **That is a known soft spot:** on the weekly
bar, 8% used at 11% elapsed already projects to about 73%, which is orange. That is an honest
straight-line projection but a bursty one. The constant is untuned. It is not exposed as config until real
use shows what the right number is.

**Rejected:**
- *De-escalating when little time is left.* Not possible with a projection (see above). A
  different rule would be needed and nobody has asked for one.
- *Uncapped.* See the cap above.
- *Default on.* It changes colors people already see. It ships off, and the default is to be
  revisited in v0.8.0 after real use.
- *Applying it to the context bar.* Context is not a time window, so there is no elapsed
  fraction to project from.
- *A separate hue for "projected".* That would blend the identity and urgency scales, which
  `colors.js` and CLAUDE.md both keep apart.

**Never on stale data.** The stale branch in `renderBar` returns before the marker or the ramp
reading are consulted, and a test seeds the cache and renders through the real binary to prove
it with `paceColors` on.

**What is verified and what is not (2026-10-13).** An independent review (not kept in the
repo) ran a grid of about 257,000 cases through the real functions and found no case of bold or
the warning glyph below a real 85%, and none of pace coloring a bar calmer than the plain ramp.
The repo carries a smaller grid of its own, 41 by 19 cases in `test/run.js`. A mutation matrix over the cap, the deadband, the
max-with-real clamp, the opt-in flag and the config default fails the suite on each mutation.
**Not yet verified:** whether the signal is useful or noisy in live work. That is the point of
shipping it off by default.

### D41. The subagent line prints `{"id","content"}` JSON lines, not bare text rows

The first `--subagent` implementation printed one ANSI text row per task, newline separated.
It was built from the input payload captured in Phase 1 (D2 to D5) and from the original plan.
The OUTPUT format was never checked against Claude Code. Claude Code's documentation
("Subagent status lines" on the statusline page) says the command writes one JSON line per
row, `{"id": "<task id>", "content": "<row body>"}`, with the task's `id` echoed, and that a
row with no `id` keeps the default rendering. Under that contract the bare text rows carried
no id and were most likely ignored, so `subagentStatusLine` would have changed nothing. It was
found by comparing against another statusline's implementation, not by a test or a report.

**Decision:** `renderSubagentLine` emits `JSON.stringify({ id, content }) + "\n"` for each task
whose `id` is a non-empty string, and nothing for any other task, which keeps Claude Code's
default row for it. `content` is the same row text as before, sanitized the same way. The
display name chain gains `name` and `agentType` after `label` and `description` (see D2).
No tasks, or none with a usable id, means no output at all rather than a blank line.

**Why JSON.stringify matters beyond the format.** The protocol is line based and `content` is
rendered as-is, including OSC 8 hyperlinks. `JSON.stringify` keeps every row on one physical
line and escapes control bytes, so a label with a newline cannot forge a second row. The
existing `sanitize()` still strips escape sequences before the text is built.

**Also fixed here, found in review.** The model id was the one displayed field that was not
sanitized, so a hostile `model` value became a live OSC 8 link or a clear-screen sequence in
`content`, which Claude Code renders as-is. It is now sanitized like the label. `status` was
used as a bare lookup key, so `"constructor"` printed function source into the row, the same
bug class as D38's `review_state`; it is now an own-property lookup. And the echoed `id` has
U+2028 and U+2029 escaped in the JSON text, since it is the one field that is echoed rather
than sanitized and some line readers split on those characters. Tests also now pin the raw
bytes (no blank line between rows, no carriage return, the `id` key first), because filtering
blank lines before parsing would have hidden exactly that.

**Rejected:**
- *Printing bare text as well as JSON.* A reader of JSON lines would choke on or discard the
  extra lines, and no version is known to read bare rows.
- *Echoing a non-string id with `String(id)`.* If Claude Code ever sent numbers, a guessed
  string might not match the task, and the safe failure is the default row.
- *Hiding a row with an empty `content`.* That is a documented way to hide a row. We omit the
  task instead, which keeps the default row rather than removing information.

**What is verified and what is not (2026-10-14).** The output shape is covered by tests that
parse every line as JSON, check the keys, the echoed ids and their order, the trailing newline,
the omission rules, hostile labels and `NO_COLOR`. **Not verified live:** that Claude Code now
renders these rows in the agent panel. This is to be amended after that check. Also unknown is
which Claude Code version introduced the JSON contract, so a user on a much older version may
see a difference.

### D42. Values from outside are type- and range-checked, not only sanitized

D38 found that `pr.number` went through a bare `Number()` and printed `#1e+21`, and that
`review_state` used as an object key printed function source. The escape-injection tests had
only ever covered the separator and the PR URL and kind, so the same shapes were never looked
for anywhere else. A suite that exercises every field that reaches stdout found them:

- **dir:** `workspace.repo.name` went through `sanitize(String(...))`. An object printed
  `[object Object]`, an array its first element, a number its digits and `true` printed `true`.
- **model:** `display_name || id` the same way.
- **cost:** any finite number was accepted, so a payload could print `$-5.00`, `$1e+21`,
  `+-3/--4` or `+1.5/-2.25`.
- **dir and git:** a non-string `current_dir` is truthy, so it won the `||` and either threw
  inside `path.basename` (the dir segment was dropped) or dropped the git segment even when
  `cwd` was a valid repo.

**Decision.** A text field must be a non-empty string, or it counts as absent and the next
source is used. `current_dir` and `cwd` are chosen as the first non-empty string, in both the
dir and git segments. Cost must be a finite number in 0 up to (not including) 1e9, and line
counts non-negative safe integers; anything else is left out rather than printed. Nothing is
coerced: `String(v)` of the wrong type is exactly what printed the junk.

**What held.** String sanitization was already correct everywhere it is applied. No control
sequence reached stdout in any case, including a hand-written `.git/HEAD` and todo text. The
suite asserts one whole-line invariant: once our own color codes are removed, no ESC, BEL, C1
control, U+2028, U+2029 or NUL remains, with colors on and under `NO_COLOR`.

**Rejected:** clamping cost to the cap (it would display a wrong number as if it were right),
and coercing with `String()` or `Number()` (that is the bug).

**A testing lesson, kept here because it nearly shipped.** The first hostile-branch test passed
without exercising `sanitize()` at all. The branch is read with `/^ref:\s*refs\/heads\/(.+)$/`,
and `.` does not match U+2028, so a hostile name containing it was never read. A mutation that
removed the `sanitize()` call survived, which is how it was caught. The test now leaves the
separator out, as a real attacker would, and asserts the branch is actually rendered as inert
text before it asserts that nothing leaked.

**Found by an independent review of this suite, and fixed here.** The same pass reproduced
these against the real binary:

- **Rate limits were coerced with `Number()`.** `used_percentage` of `null`, `""`, `false` or
  `[]` became a fabricated 0%, and `"0x1F"` or `"1e1"` became a percentage nobody sent. The
  value was also written through to the cache, so a later render with no `rate_limits` at all
  served that 0% for up to a day. It must now be a number, as the context segment already
  required.
- **A non-string todo printed on the second render.** The type guard sat only on the cache-miss
  path, so the first render cached the object and every later render within the fresh window
  printed `[object Object]` or its digits.
- **Session ids matched by bare prefix and doubled as cache keys.** A one-character id surfaced
  another session's task, and `x_1`, `x:1` and `x/1` all slugged to the same cache key. An id
  must now match `[A-Za-z0-9_-]{1,128}`, and a todo file belongs to a session only when it is
  `<id>.json` or `<id>-agent-<...>.json`. Real ids are UUIDs, so this costs nothing. The
  `-agent-` shape is Claude Code's convention as remembered, **not re-verified here**: there is
  no `~/.claude/todos` directory on the machine this was developed on.
- **An unanchored regex starting with `\s*` was quadratic.** `shortenModel` took 8 seconds for a
  display name of 100,000 spaces and never returned for a million, which breaks the "never a
  hang" contract with a single synchronous line. The input is now cut to 200 characters before
  any regex runs, the pattern no longer starts with `\s*`, and whitespace is collapsed and
  trimmed afterwards.
- **Names that are empty after cleaning printed an empty colored segment** and a doubled
  separator. `"\x07"` and `"Claude "` are non-blank strings that clean to nothing, so emptiness
  is now judged after cleaning: a model falls back to its id, a repo name to the directory name,
  and a blank todo is omitted.
- **The subagent path had no type checks.** An object label, a numeric description, or a
  `tokenCount` of `true` or `"5000"` printed `[object Object]`, `12345`, `1` and `5k`. Names must
  be strings, and a token count must already be a number.
- **The directory name had no length cap**, so a 10 MB repo name printed 10 MB. It is now cut
  at 40 characters, as the model (32), branch (24) and task (40) already were.

**What is verified and what is not (2026-10-14).** The cases above are covered by tests, and a
mutation matrix over each type check, each `sanitize()` call, each cap and each fallback fails
the suite. Two pairs are defense in depth on purpose (the model regex fix and the 200 character
bound), so they are mutated together. **Not covered, and handled separately:** bidirectional
override and zero-width characters, which `sanitize()` does not strip, and the width of
characters outside the old wide-character ranges. The suite is also green with `NO_COLOR`
exported in the developer's shell.

### D43. `sanitize()` also strips bidirectional and invisible characters, and cell width counts them right

D42 recorded these as not covered. A terminal control sequence is not the only way foreign text
can mislead a reader, and `sanitize()` removed only C0, DEL, C1 and the two line separators.

- **Bidirectional controls** (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C). An
  unterminated right-to-left override sitting in the directory or branch, which come first on
  the line, reorders everything after it on a bidi-capable terminal: the model name, the usage
  bars and the countdown. Windows Terminal and conhost do no bidi, so this is not visible there.
  The bytes were shown to reach stdout; **the reordering itself was not observed**, because no
  bidi terminal was available here.
- **Zero-width characters** (U+200B, U+2060 to U+2064, U+FEFF, U+180E). A name made only of them
  is blank on screen, and counted one cell each, so thirty of them made the line wrap early.
- **Tag characters** (U+E0000 to U+E007F). Invisible, and able to carry a hidden ASCII payload
  that anything reading the terminal text, a screen reader or a model, would still see.

**Decision.** All of the above are stripped by `sanitize()`, built from code points so that no
invisible character appears in the source. **Kept on purpose:** the zero-width joiner (U+200D),
the zero-width non-joiner (U+200C) and the variation selectors. Emoji sequences and Persian text
need them, and none of them can reorder or hide a run of text. Cell width now treats combining
marks, zero-width, format and tag characters as zero cells, and counts the transport (U+1F680 to
U+1F6FF) and extended pictograph (U+1FA70 to U+1FAFF) emoji blocks as two. A few code points in
the transport block are narrow; over-counting only makes the line wrap earlier, which is the
safe direction. The table is still not full UAX #11.

**A guard against the same trick in this repository.** A bidirectional override inside a source
file makes the code a reviewer sees differ from the code that runs ("Trojan Source"). The suite
now scans tracked source and documentation for these characters and fails if it finds one.
Writing this change surfaced a related hazard: a typed `\u2028` in a source file or a command
can arrive as the real character, which JavaScript treats as a line break inside a regular
expression. Every such character in the code and the tests is built from a code point instead.

**Rejected:**
- *Stripping the whole Unicode format category (Cf).* It would remove the joiners and break
  emoji and Persian text.
- *Normalizing names (NFC) or restricting them to an allowlist of scripts.* That changes text the
  user wrote, or rejects legitimate names.

**What is verified and what is not (2026-10-14).** Each stripped range, each kept character,
each rendered field and a hostile `.git/HEAD` and todo are covered by tests, and a mutation
matrix that un-strips each range, over-strips the joiners, and removes each width range fails
the suite. **Not verified:** the visual reordering on a real bidi terminal, and the width of
code points outside the ranges listed, since the table is deliberately minimal.

### D44. The installer refuses to rewrite without a backup, matches only its own commands, and prefers a durable node path

An audit of `lib/install.js`, the one module that can destroy a user's configuration, found
four ways it could do the wrong thing quietly, and that nothing tested it.

- **Backups.** `pruneBackups` removed every file that started with `settings.json.backup.`
  beyond the newest five, including copies the user made by hand, and `backup()` returned
  `null` on any failure, after which install and uninstall rewrote `settings.json` anyway. Now
  only the exact stamp ampline writes is pruned (sorted by name, which is chronological), and a
  failed backup of an existing file stops the run with exit 1 and a message, before anything is
  changed: the install takes its backup right after the first read, before the runtime is copied,
  so a failure leaves the runtime copy as it was too. Uninstall does the same, and removes nothing.
- **Which commands are ours.** `pointsAtUs` accepted any command that contained
  `ampline-claude`, so a user's `~/bin/ampline-claude-wrap.sh` was deleted by uninstall and
  replaced by install without a notice. It now accepts only `node` (bare, or an absolute path to
  a file named `node` or `node.exe`) followed by the quoted installed entry,
  `<dir>/hooks/ampline-claude/bin/ampline-claude.js`, with or without `--subagent`; the
  README's manual-install shape matches. Anything else is foreign. Install announces a foreign
  entry (now for `subagentStatusLine` as well as `statusLine`) and replaces it after a backup.
  Uninstall leaves it alone, and keeps the runtime copy and cache whenever a foreign entry that
  still names `ampline-claude` remains (a wrapper around the installed copy), including when
  uninstall removed the other entry. A foreign entry that has nothing to do with ampline does not
  keep the runtime when one of ours was removed; when nothing of ours was found and a foreign
  entry exists, uninstall touches nothing at all.
- **Node path (K2, amends D27).** D27 wrote `process.execPath`. Node resolves that through
  realpath, so Homebrew gives `/opt/homebrew/Cellar/node/<version>/bin/node`, and `brew
  upgrade` plus its cleanup deletes it: the statusline goes blank with no message, the failure
  D27 set out to prevent. `chooseNodePath` (pure, with `execPath`, the PATH entries, `realpath`
  and the file check injected) now does this: if `execPath` is in a versioned directory (Homebrew
  `Cellar`; nvm, fnm, volta, asdf, nodenv, mise, snap revisions) it looks through PATH for a
  `node` whose realpath is the same file and whose own path is not in such a directory, and
  writes that one. If there is none, it writes the real file behind `execPath` when that is not
  versioned either, and otherwise keeps `execPath`. A PATH entry inside a version directory is
  skipped, because it is no more durable, and fnm's per-shell `fnm_multishells` symlinks are
  skipped because they disappear at reboot.
- **Output contract.** The website embeds the installer's output verbatim and compares it in CI,
  so a normal install prints exactly the six lines v0.6.0 printed. Everything new is shown only
  when it applies, and the list is built by a pure function, `installMessages`: an optional
  `replacing an existing statusLine command:` notice (then the same for `subagentStatusLine`),
  `✓ ampline-claude installed.`, then, only when the Node choice is notable (`execPath` is in a
  versioned directory, or the bare `node` fallback was used), `  Node: <path written>` and
  a note that says to re-run `npx ampline-claude --install` after upgrading Node, then
  `  Previous settings backed up to <name>` only when a settings file existed, a blank line, the
  restart line, a blank line, the Customize line and the URL. When a stable PATH entry or a real
  file was written, `execPath` is necessarily versioned, so one test covers every case.
- **Smaller.** The settings temp file is created with the target's mode (it could be readable by
  more users for an instant, and an old file at that name is removed rather than written
  through). `ampline-claude.new-<pid>` and `.old-<pid>` directories are removed on install and
  uninstall only when they are older than a minute and their process no longer exists
  (`kill(pid, 0)` reporting `ESRCH`; `EPERM` counts as alive), so a second installer that is
  still running is never disturbed. `settings.json` is read again right before the final write
  and the entries are merged into that copy, which shrinks, but does not remove, the window in
  which Claude Code's own write could be lost; the backup is of the first read. Uninstall when
  `settings.json` has no ampline entries still deletes the runtime copy and cache and says so,
  unless a different statusline is configured.

**Tests.** `test/installer.js` runs the real binary in `mkdtemp` homes, with `CLAUDE_CONFIG_DIR`
removed and the working directory inside the home, and covers install, re-install, a foreign
entry, a wrapper script, an unparseable file, a symlinked file, file mode, pruning, uninstall in
each state, stale staging, the output contract, and `--help`/`--version`. In-process tests load
`lib/install.js` against a throwaway `CLAUDE_CONFIG_DIR` (set before `require`, never unset) and
wrap or fail `fs` calls to reach what a spawned run cannot on every OS: a failed backup, the
mode the temp file is created with, an edit to `settings.json` made mid-install, and a failed
swap with its rollback. The spawned-render helpers in `test/run.js` also drop `CLAUDE_CONFIG_DIR`
and use the throwaway home as the working directory, and every throwaway home starts with an
empty `.amplinerc.json`. That ends the config walk-up at the home for any render whose directory
is the home or inside it, so a `.amplinerc.json` in the user profile above `os.tmpdir()` cannot
change a result. A payload whose `cwd` is elsewhere (a fixture's `/tmp/project`) still walks that
directory's own ancestors first.

**Rejected:**
- *Always writing a bare `node`.* Brings back the blank statusline under a GUI launch that D27 fixed.
- *Following version-manager shims (volta's, asdf's) to the "stable" path.* A shim is a different
  file from the real binary, so "same binary" cannot be shown; the versioned path is kept.
- *Warning on a failed backup and continuing.* The README promises a backup first.

**Not verified:** Homebrew, nvm-windows and the other version managers were exercised only through
injected paths. No Mac was available, as for D27.
