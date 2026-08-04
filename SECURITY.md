# Security Policy

## Supported versions

Only the latest published version on npm is supported. Please upgrade
(`npx ampline-claude@latest`) before reporting an issue to confirm it isn't already fixed.

## Why this matters for a statusline

ampline-claude runs on every Claude Code render, writes to `~/.claude/settings.json`, and
copies executable JavaScript into `~/.claude/hooks/ampline-claude/`. It makes no network calls
and reads no credentials by design (see `CLAUDE.md`/`DECISIONS.md`), but its blast radius —
a user's Claude Code configuration and local filesystem — is large enough to take reports
seriously.

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

Out of scope: vulnerabilities in Claude Code itself, in `git`, or in the `gh` CLI that
ampline-claude's `pr` segment depends on but never invokes directly — please report those to
their respective projects.
