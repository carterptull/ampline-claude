# Security Policy

## Supported versions

Only the latest published version on npm is supported. Please upgrade
(`npx ampline-claude@latest --install`) before reporting an issue to confirm it isn't already fixed.

## Why this matters for a statusline

ampline-claude runs on every Claude Code render, writes to `~/.claude/settings.json`, and
copies executable JavaScript into `~/.claude/hooks/ampline-claude/`. It makes no network calls
and reads no credentials by design (see `CLAUDE.md`/`DECISIONS.md`), but its blast radius —
a user's Claude Code configuration and local filesystem — is large enough to take reports
seriously.

## What it does with input it does not control

A statusline reads things its user did not necessarily write: the JSON payload on stdin, and, from
whatever directory Claude Code was opened in, `.amplinerc.json`, `.git/HEAD` and the repository's
own git configuration. Terminal escape sequences, bidirectional and invisible characters are
stripped from every string that reaches stdout, and values are checked for type and range as well
(`CLAUDE.md` and `DECISIONS.md` D19, D42, D43). The rest of this section covers the two places
where input from a directory can cost more than a wrong character.

### Running `git status`: what is covered, and what is not

The git segment reads the branch straight from `.git/HEAD`, then runs one `git status` call for the
ahead, behind and dirty marker, on every render. `git status` follows the repository's own
configuration, so a repository that arrives with its own config (an extracted archive, or an
embedded bare directory inside a clone) could make git run things on every render. ampline narrows
that. It does not remove it, and it is not a sandbox.

What ampline does (`DECISIONS.md` D20 and its follow-ups):

- Before the call, it reads the repository's own config files (`config` and `config.worktree`, and for
  a linked worktree the same two in the common directory). If any of them defines a `[filter ...]`
  section, an `[include]` or an `[includeIf ...]` section, or cannot be read and parsed, it skips
  `git status` entirely: the branch still shows from `HEAD`, with no ahead/behind/dirty marker and no
  cache entry. The scan runs before the cache is read.
- The call turns off `core.fsmonitor`, does not write the index (`--no-optional-locks`, so no
  post-index-change hook), does not look inside submodules (`--ignore-submodules=dirty`), refuses a
  bare repository it was not pointed at (`safe.bareRepository=explicit`), and runs with
  `GIT_NO_LAZY_FETCH=1` and none of the inherited variables that name a repository.
- git is started in the real path of the work tree whose `.git` entry ampline scanned, with
  `GIT_CEILING_DIRECTORIES` set to that directory's parent, so that if git rejects the entry it
  fails instead of climbing into a repository ampline never scanned. git's own ownership
  (`safe.directory`) check still applies, which is why `--git-dir` and `--work-tree` are not used.
- ampline mirrors git's check that a `.git` directory is a git directory, and is stricter than git
  about the `gitdir:` and `commondir` files (any odd whitespace skips the call). It skips the call too
  when a bare-looking directory sits between the working directory and the repository, and when the
  parent of the work tree's real path contains the path-list separator (`:` on macOS and Linux, `;`
  on Windows). A timeout of 400 ms and an argument array, with no shell, bound the call.

What is not covered:

- Everything else in a repository's own config is trusted as when you run git there yourself. A
  repository's own configuration is trusted unless ampline detects a filter or an include in it.
- Global and system config are never scanned: a filter you installed yourself, such as Git LFS,
  keeps working.
- Older git, accepted residuals. Before git 2.39.4 or 2.45.1 (depending on the release series)
  `GIT_NO_LAZY_FETCH` is ignored, so a partial clone can fetch from its remote during the status
  call, and a lazy fetch can run the transport the repository's own config names (a remote URL with
  a helper, `core.sshCommand` and the like), which the scan does not cover. Before git 2.38
  `safe.bareRepository` is ignored. ampline does not run `git --version` on every render to detect
  either, and a partial clone is a normal repository, so it is not skipped. Use a current git.

Treat a directory you did not clone yourself, such as an unpacked archive, as you would before
running git in it.

### Limits on what it reads

A file or stream from a checkout cannot make a render hang or flood the line:

- `.amplinerc.json`, a `.git` file and `HEAD` are read only if they are regular files of at most
  64 KB. An oversized, unreadable or non-regular `.amplinerc.json` is skipped like a missing one and
  the search continues. An oversized, unreadable or non-regular `HEAD`, or an oversized or unreadable
  `.git` file, leaves the git segment out. A `.git` that is a directory, or absent, behaves as it
  always did.
- A repository's own git config is read up to 256 KB. A larger or unreadable one counts as untrusted,
  and the `git status` call is skipped.
- stdin is read up to 8 Mi characters, 8,388,608 (UTF-16 units of the decoded text, about 8 MB for ASCII).
  Past that nothing is rendered, and the exit code is still 0.
- The config search looks at no more than 30 directories, starting with the session directory, and
  then tries your home directory. The git repository search stops after the same 30.
- Config values are bounded: the separator is cut to 16 characters, branch and task lengths are
  capped at 200, and a segment is kept once (`DECISIONS.md` D48).

Known and accepted: the config search climbs from the session directory toward the root, so a
`.amplinerc.json` planted in a shared parent directory such as `/tmp` can be loaded. A config only
chooses which segments show and how the line looks, never a path or a command, and every value is
validated and bounded, so the worst case is a different-looking line (`DECISIONS.md` D48). The
synchronous file reads of the cache and the todo files have no time limit, so a `~/.claude` on a
slow network mount can slow a render down.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Instead, use GitHub's private vulnerability reporting for this repository:
[github.com/carterptull/ampline-claude/security/advisories/new](https://github.com/carterptull/ampline-claude/security/advisories/new).
This opens a private channel with the maintainer and does not disclose the issue publicly until
a fix is ready.

Please include:
- The version affected (`npx ampline-claude --version`)
- A minimal reproduction — a payload fixture shape, a config file, or a repo state that triggers it
- What you'd expect to happen instead

## Scope

In scope: anything that could make ampline-claude read a credential, make a network call, write
outside `~/.claude/` (or a `CLAUDE_CONFIG_DIR` override), execute unintended code, or inject
terminal control sequences from untrusted input (repo content, config files, payload fields)
into stdout.

The git behavior described above is the boundary: a way to make the `git status` call run something
that the scan, the flags or the ceiling should have stopped is in scope. A repository's own configuration
that ampline does not look for, global or system config, and the older-git cases listed under "What is
not covered" are documented limits, not vulnerabilities.

Out of scope: vulnerabilities in Claude Code itself, in `git`, or in the `gh` and `glab` tools Claude
Code uses to fill the `pr` field (ampline-claude never runs them) — please report those to their
respective projects.
