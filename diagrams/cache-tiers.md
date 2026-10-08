# State diagram: the two-tier disk cache

How one cache entry in `lib/cache.js` moves from missing to fresh to stale to expired, and which
callers decide what each age means. Three modules use the cache: usage, git state and the current
task. For where the cache sits in a render, see [`render-sequence.md`](render-sequence.md). For the
module map, see [`overview.md`](overview.md).

```mermaid
stateDiagram-v2
    state "Missing" as Missing
    state "Fresh" as Fresh
    state "Stale" as Stale
    state "Expired" as Expired

    [*] --> Missing
    Missing --> Fresh: caller calls write after computing a value
    Fresh --> Fresh: caller calls write again and the file is replaced
    Fresh --> Stale: age passes the fresh limit the caller uses
    Stale --> Fresh: caller refreshes the value and calls write
    Stale --> Expired: age passes the stale limit the caller uses
    Expired --> Fresh: caller refreshes the value and calls write
    Expired --> Missing: prune deletes a file older than 7 days

    note right of Missing
        read(key) returns null
    end note

    note right of Fresh
        read(key) returns age and value
        caller uses the value and skips the work
    end note

    note right of Stale
        read(key) returns age and value
        caller tries fresh work first
        and falls back to the value if the work fails
    end note

    note right of Expired
        read(key) still returns age and value
        caller ignores the value
    end note
```

**`cache.js` has no idea what fresh or stale means.** `read(key)` stats the file, parses it, and
returns `{ age, value }`, where `age` is `Date.now()` minus the file's mtime, clamped to zero or
more. A missing file, an unreadable file, or content that is not valid JSON all return `null`.
The fresh and stale limits live in each caller, as in the table below, so the Fresh, Stale and
Expired states are a convention the callers share, not a field in the file. An entry never
expires on its own. It stays on disk until something overwrites it or `prune()` deletes it.

**Why the split is in the caller:** the three consumers need different rules. Usage has no fresh
window at all, git wants to avoid a subprocess, and the task cache only saves some directory
reads. A single TTL in `cache.js` would have been wrong for at least two of them.

## Who uses the cache

```mermaid
flowchart LR
    U["lib/usage.js<br/>key: usage"]
    G["lib/segments/git.js<br/>key: git:gitdir"]
    T["lib/segments/task.js<br/>key: task:session_id"]
    C["lib/cache.js<br/>read, write, remove, prune"]
    D[("claudeDir()/cache/ampline/<br/>one JSON file per key")]

    U --> C
    G --> C
    T --> C
    C --> D

    style C fill:transparent,stroke:#888
    style D fill:transparent,stroke:#888
```

| Consumer | Key | Fresh | Stale | What a miss costs | Source |
|---|---|---|---|---|---|
| Usage | `usage` | none, write-through | 24h, plus a `resets_at` rollover check | nothing to show until the next payload carries `rate_limits` | `lib/usage.js` |
| Git state | `git:<gitdir>` | 5s | 60s | one `git status --porcelain=v2` subprocess, 400ms timeout | `lib/segments/git.js` |
| Current task | `task:<session_id>` | 3s | 15s | one directory listing plus one file read in `~/.claude/todos/` | `lib/segments/task.js` |

The constants in the code match the "Cache TTLs" table in [`../CLAUDE.md`](../CLAUDE.md):
`MAX_STALE_MS` is 24 hours in `usage.js`, `GIT_FRESH_MS` and `GIT_STALE_MS` are 5000 and 60000 in
`git.js`, and `FRESH_MS` and `STALE_MS` are 3000 and 15000 in `task.js`. No other segment reads
or writes the cache. The branch name itself is never cached, because `git.js` reads it straight
from `.git/HEAD` on every render.

## Usage, git and task each use the tiers differently

```mermaid
flowchart TD
    subgraph Usage["usage"]
        U1{"stdin has<br/>rate_limits?"}
        U2["write to cache<br/>return live, stale false"]
        U3{"entry exists and<br/>age is 24h or less?"}
        U4["drop any window whose<br/>resets_at has passed"]
        U5["return what is left<br/>stale true, or null if empty"]
        U1 -->|"yes"| U2
        U1 -->|"no"| U3
        U3 -->|"no"| UN["return null"]
        U3 -->|"yes"| U4
        U4 --> U5
    end

    subgraph Git["git state"]
        G1{"cached age<br/>under 5s?"}
        G2["return cached value<br/>no subprocess"]
        G3["run git status<br/>400ms timeout"]
        G4["write result<br/>return it"]
        G5{"git failed and<br/>cached age under 60s?"}
        G6["return cached value"]
        G7["return null, no sync or dirty marker"]
        G1 -->|"yes"| G2
        G1 -->|"no"| G3
        G3 -->|"ok"| G4
        G3 -->|"error or timeout"| G5
        G5 -->|"yes"| G6
        G5 -->|"no"| G7
    end
```

**Usage is write-through, not read-through.** When the payload carries `rate_limits`, the value
is written to the cache on every render and returned as live, so the cache never decides anything
while stdin is present. It only matters on a render where the payload lacks `rate_limits`, such
as a cold start before the first API response. In that case the entry is used only if it is
24 hours old or less, each window is dropped once its own `resets_at` has passed (its percentage
describes a window that has rolled over, so it is wrong and not merely old), and whatever is left
is returned with `stale: true`. The rendering of that stale flag is covered in `DECISIONS.md` D11.

**Git has all three tiers.** Under 5 seconds it returns the cached ahead, behind and dirty state
and runs nothing. Past that it runs the one `git status` call and overwrites the entry. If the call
fails or times out, an entry up to 60 seconds old is still used, and anything older yields `null`,
so the branch renders without the sync arrows and the dirty marker. A successful call always
rewrites the entry, so a repo that keeps rendering stays in the Fresh state. See `DECISIONS.md`
D20 for why this is the only subprocess.

**Task has a fresh tier and a nominal stale tier.** Under 3 seconds the cached string is returned,
and an empty string means "no in-progress todo" and renders nothing. Past that, `readTask()`
scans `todos/` and the result, including an empty one, is written back. The 15 second stale
fallback runs only if the refresh throws, and `readTask()` catches its own filesystem errors and
returns an empty string, so that path is rarely reached in practice.

## Writes, key names and pruning

```mermaid
sequenceDiagram
    participant C as caller
    participant K as cache.js
    participant F as cache dir

    C->>K: write(key, value)
    K->>F: mkdir -p cache/ampline
    K->>K: safeKey turns key into a filename
    K->>F: write name.json.PID.tmp
    K->>F: rename tmp over name.json
    Note over K,F: if write or rename fails the tmp file is removed and the error is swallowed
    K->>K: 1 in 100 writes also call prune
    K->>F: delete files with mtime older than 7 days
```

**Atomic writes.** The main statusline and the subagent statusline are separate processes that
can write the same key at the same moment. Each writer puts its JSON in a file named for its own
process id, then renames it over the real file. A concurrent reader sees either the old complete
file or the new complete file, never a half-written one. A failed write is dropped silently, which
fits the degradation contract in [`../CLAUDE.md`](../CLAUDE.md): a missing cache entry just means
the caller does the work again.

**Windows filenames.** Keys like `task:<id>` and `git:<path>` contain characters Windows will not
accept in a filename, and `:` is NTFS alternate data stream syntax, so such a name does not round
trip. `safeKey()` replaces every character outside `[A-Za-z0-9_-]` with `_`. If the result is
longer than 64 characters, it keeps the first 47 characters and appends a dash and 16 hex digits
of the SHA-1 of the original key, so a long repo path still maps to a stable 64 character name.

**`prune()`** walks the cache directory and deletes every file whose mtime is more than 7 days
old, which also sweeps up any `.tmp` file left behind by a crash. Nothing else deletes per-session
and per-repo files, because every new session and every new repo adds a key. It runs from inside
`write()` on a 1% dice roll, not on a schedule, so normal renders pay nothing for it. `remove(key)`
exists in the module but has no callers in `lib/` or `bin/` today. Uninstall removes the whole
cache directory instead, see [`install-flow.md`](install-flow.md).

**The directory** is `claudeDir()` plus `cache/ampline`, so it follows `CLAUDE_CONFIG_DIR`. It is
resolved once when the module loads.

## Known gap

The "never a hang" guarantee has a real timeout only on the single `execFileSync('git', ...)` call.
The synchronous reads in `cache.js` (`statSync`, `readFileSync`, `readdirSync` in `prune`) and in
`segments/task.js` (`readdirSync`, `statSync`, `readFileSync`) have no ceiling. On a network
mounted `~/.claude`, a render can block for as long as that I/O takes. Fixing it means moving
those paths off synchronous I/O, which conflicts with `resolveUsage` and `renderStatusline` being
deliberately synchronous. [`../CLAUDE.md`](../CLAUDE.md) flags this and it is not addressed yet.
See also [`deployment-security.md`](deployment-security.md).

---
_Last updated: 2026-10-07 · reflects v0.6.0_
