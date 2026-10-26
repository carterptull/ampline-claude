'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DIM, RESET, fg, sanitize } = require('../colors');
const cache = require('../cache');
const { readSmallTextFile } = require('../safeRead');

const DEFAULT_MAX_BRANCH_LEN = 24;
const GIT_TIMEOUT_MS = 400;
const GIT_FRESH_MS = 5000;
const GIT_STALE_MS = 60000;

// .git can be a FILE with "gitdir: <path>" (worktrees/submodules), not a dir.
function resolveGitDir(dir) {
  let cur = dir;
  for (let i = 0; i < 50 && cur; i++) {
    const candidate = path.join(cur, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        // Small regular files only: a checkout we do not control could ship a device or FIFO.
        // A bad .git entry (unreadable, oversized, no gitdir line) deliberately ends the search
        // rather than falling through to a parent directory's repository.
        const text = readSmallTextFile(candidate);
        const m = text === null ? null : text.match(/gitdir:\s*(.+)/);
        if (!m) return '';
        return path.resolve(path.dirname(candidate), m[1].trim());
      }
      if (stat.isDirectory()) return candidate;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return '';
}

// Truncate from the end — ticket IDs like "TAMA5-32796" live at the front.
// Array.from splits by code point, not UTF-16 unit, so an emoji near the
// cut point doesn't get sliced in half into a broken surrogate.
function truncateBranch(name, max) {
  const limit = Number.isFinite(max) && max > 4 ? max : DEFAULT_MAX_BRANCH_LEN;
  const chars = Array.from(name);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : name;
}

// Read directly from .git/HEAD (no subprocess) — see getGitState for why.
function getBranch(gitDir) {
  try {
    const text = readSmallTextFile(path.join(gitDir, 'HEAD'));
    if (text === null) return '';
    const head = text.trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    return '';
  } catch {
    return '';
  }
}

// "# branch.ab +<ahead> -<behind>" — ahead is first, behind second.
function parseStatusV2(out) {
  let ahead = null;
  let behind = null;
  let dirty = false;
  for (const line of String(out).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u' || line[0] === '?') {
      dirty = true;
    }
  }
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    dirty,
  };
}

// ---- Repository-local config trust (D20 follow-up) ----
//
// `git status` honors parts of a repository's OWN config that can name a command: content
// filter drivers (selected by .gitattributes) and include files (which can pull in anything).
// A repository that arrived as an archive, rather than a clone, brings its .git/config with it.
// So before the one subprocess we read the repo-local config files and, if any defines a
// `[filter ...]`, `[include]` or `[includeIf ...]` section, we do not run `git status` at all:
// the branch still comes from HEAD and the ahead/behind/dirty marker is simply left out.
//
// Not covered, on purpose: global and system config (including filters such as LFS) are the
// user's own and stay trusted, and everything else in the repository's own config is trusted
// exactly as when you run git yourself in that directory. `core.fsmonitor` is overridden on the
// command line rather than detected here.
//
// Any read or parse problem means "untrusted": the subprocess is skipped.
const CONFIG_MAX_BYTES = 256 * 1024;
const UNTRUSTED_SECTIONS = new Set(['filter', 'include', 'includeif']);

// Pure: does this config text define a filter, include or includeIf section (or look too
// malformed to say)? Section names are case-insensitive; whitespace, comments, quoted and
// legacy dotted subsections are handled; a continuation line that looks like a header errs
// toward true. Not a full git-config parser, only a conservative header scanner.
function configIsUntrusted(text) {
  if (typeof text !== 'string') return true;
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const raw of lines) {
    let s = raw.trim();
    while (s.startsWith('[')) {
      let i = 1;
      while (i < s.length && /\s/.test(s[i])) i++;
      const nameStart = i;
      while (i < s.length && /[A-Za-z0-9-]/.test(s[i])) i++;
      const name = s.slice(nameStart, i).toLowerCase();
      if (!name) return true;
      if (UNTRUSTED_SECTIONS.has(name)) return true;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '.') {
        const close = s.indexOf(']', i);
        if (close === -1) return true;
        i = close;
      } else if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
        if (i >= s.length) return true;
        i++;
        while (i < s.length && /\s/.test(s[i])) i++;
      }
      if (s[i] !== ']') return true;
      s = s.slice(i + 1).trim();
    }
  }
  return false;
}

// 'absent' (no such file, which is normal for config.worktree), 'bad' (present but not a small
// readable regular file), or the text.
function readRepoConfig(p) {
  try {
    fs.statSync(p);
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'absent' : 'bad';
  }
  const text = readSmallTextFile(p, CONFIG_MAX_BYTES);
  return text === null ? 'bad' : text;
}

// True only when every repo-local config file ampline can find is readable and clean:
// <gitdir>/config and config.worktree, plus, for a linked worktree, the same two in the common
// directory named by <gitdir>/commondir.
function repoConfigIsTrusted(gitDir) {
  try {
    const dirs = [gitDir];
    const commonText = readRepoConfig(path.join(gitDir, 'commondir'));
    if (commonText === 'bad') return false;
    if (commonText !== 'absent') {
      const rel = commonText.trim();
      if (!rel) return false;
      const common = path.resolve(gitDir, rel);
      if (common !== path.resolve(gitDir)) dirs.push(common);
    }
    for (const dir of dirs) {
      for (const name of ['config', 'config.worktree']) {
        const text = readRepoConfig(path.join(dir, name));
        if (text === 'absent') continue;
        if (text === 'bad' || configIsUntrusted(text)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// One cached `git status` call for ahead/behind/dirty — execFileSync blocks
// the event loop and can't be timeout-bounded, so we avoid extra calls.
function getGitState(dir, gitDir) {
  // Checked before the cache is read, so an untrusted repository never serves, or leaves behind,
  // a result from a subprocess it influenced.
  if (!repoConfigIsTrusted(gitDir)) return null;
  const key = `git:${gitDir}`;
  const cached = cache.read(key);
  if (cached && cached.age < GIT_FRESH_MS && cached.value) return cached.value;

  try {
    // What this call blocks and what it does not (D20, and its follow-up):
    //  - `-c core.fsmonitor=` overrides the fsmonitor hook command for this call.
    //  - Repo-local filter drivers and include/includeIf sections never reach this line: the
    //    scan above skips the call for such a repository.
    //  - Everything else in the repository's own config is trusted exactly as when you run git
    //    yourself in that directory. Global and system config are not scanned.
    //  - `--no-optional-locks` avoids taking the index lock (it is a courtesy, not a defense).
    const out = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const value = parseStatusV2(out);
    cache.write(key, value);
    return value;
  } catch {
    if (cached && cached.age < GIT_STALE_MS && cached.value) return cached.value;
    return null;
  }
}

function renderGitSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const config = (ctx && ctx.config) || {};
    // Same rule as the dir segment (lib/render.js): the first non-empty STRING wins, so an
    // object or number in current_dir falls back to cwd instead of dropping the segment.
    const fromWorkspace = input.workspace && input.workspace.current_dir;
    const dir = [fromWorkspace, input.cwd].find((v) => typeof v === 'string' && v !== '') || process.cwd();

    const gitDir = resolveGitDir(dir);
    if (!gitDir) return null;

    const rawBranch = sanitize(getBranch(gitDir));
    if (!rawBranch) return null;
    const branch = truncateBranch(rawBranch, config.maxBranchLength);

    const state = getGitState(dir, gitDir);

    let sync = '';
    if (state && state.ahead) sync += `${fg(96, 200, 120)}↑${state.ahead}${RESET}`;
    if (state && state.behind) sync += `${fg(232, 67, 61)}↓${state.behind}${RESET}`;

    let marker = '';
    if (state) {
      marker = state.dirty
        ? ` ${fg(245, 196, 61)}●${RESET}`
        : ` ${fg(96, 200, 120)}✓${RESET}`;
    }

    return `${DIM}⎇ ${branch}${RESET}${sync ? ' ' + sync : ''}${marker}`;
  } catch {
    return null;
  }
}

module.exports = { renderGitSegment, resolveGitDir, parseStatusV2, configIsUntrusted, repoConfigIsTrusted };
