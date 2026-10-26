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

// A .git FILE holds "gitdir: <path>". Git takes everything after "gitdir: " as the path (it strips
// trailing line breaks), so " g" and "g" are different directories. ampline is STRICTER than git
// here: it accepts only the exact shape git itself writes (the prefix, a value with no leading or
// trailing whitespace, at most one trailing newline) and treats anything else (extra spaces, a
// carriage return, an embedded newline, an empty value) as untrusted, so the call is skipped.
function parseGitFileStrict(text) {
  if (typeof text !== 'string' || !text.startsWith('gitdir: ')) return null;
  let value = text.slice('gitdir: '.length);
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value === '' || /[\r\n]/.test(value) || /^\s|\s$/.test(value)) return null;
  return value;
}

// Does this directory look like a git dir (an embedded bare repository)? Git no longer starts
// inside one (it is started in the work tree that holds the scanned .git entry, and
// safe.bareRepository=explicit is set), so this is defense in depth, kept because it is cheap
// (three stats per directory level walked, none when the cwd is the repository root) and its only
// false positive is a working directory that really is a git dir, where an outer repository's
// status is not what the user is looking at anyway.
function looksLikeGitDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile()
      && fs.statSync(path.join(dir, 'objects')).isDirectory()
      && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

// Finds the repository for `dir`: { gitDir, workTree, pinnable } or null.
// .git can be a FILE with "gitdir: <path>" (worktrees/submodules), not a dir. `workTree` is the
// directory that holds the .git entry; git is later started there, so its own discovery begins at
// exactly the entry that was scanned. `pinnable` is false when ampline's reading and git's could
// differ (a .git file that is not in git's exact shape, or a bare-looking directory on the way
// up); then the branch still renders but `git status` is not run.
function resolveRepo(dir) {
  // Absolute first, so the directory that is scanned and the one git runs in are the same.
  let cur = path.resolve(dir);
  let sawGitDirLike = false;
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
        if (!m) return null;
        const strict = parseGitFileStrict(text);
        const target = strict !== null ? strict : m[1].trim();
        return {
          gitDir: path.resolve(path.dirname(candidate), target),
          workTree: cur,
          pinnable: strict !== null && !sawGitDirLike,
        };
      }
      if (stat.isDirectory()) return { gitDir: candidate, workTree: cur, pinnable: !sawGitDirLike };
    } catch {}
    if (looksLikeGitDir(cur)) sawGitDirLike = true;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolveGitDir(dir) {
  const repo = resolveRepo(dir);
  return repo ? repo.gitDir : '';
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
// A repository directory that arrives with its own config (an extracted archive, an embedded bare
// directory inside a clone) brings that config with it. So before the one subprocess we read the
// repo-local config files and, if any defines a `[filter ...]`, `[include]` or `[includeIf ...]`
// section, we do not run `git status` at all: the branch still comes from HEAD and the
// ahead/behind/dirty marker is simply left out.
//
// What this is, and is not:
//  - Turned off or skipped: fsmonitor (overridden on the command line); filters and includes in
//    the repository's own config (the call is skipped); optional index writes
//    (--no-optional-locks); git running inside submodules (--ignore-submodules=dirty).
//  - Aligned: git is started in the work tree that holds the .git entry ampline scanned, so its
//    discovery begins at that entry, and it keeps its own ownership (safe.directory) check.
//    ampline's reading of .git files and commondir is stricter than git's: anything but a clean
//    value skips the call.
//  - Not blocked: everything else in the repository's own config is trusted as when you run git
//    yourself in that directory. Global and system config (a Git LFS filter you installed, for
//    example) are the user's own and are not scanned. The scan reduces, and does not eliminate,
//    what a repository's own configuration can make git do on every render; it is not a sandbox.
//
// Any read or parse problem means "untrusted": the subprocess is skipped.
const CONFIG_MAX_BYTES = 256 * 1024;
const UNTRUSTED_SECTIONS = new Set(['filter', 'include', 'includeif']);

// Pure: does this config text define a filter, include or includeIf section (or look too
// malformed to say)? Section names are case-insensitive; whitespace, comments, quoted and
// legacy dotted subsections are handled; a continuation line that looks like a header errs
// toward true. Not a full git-config parser, only a conservative header scanner.
//
// Belt and braces: separately from the header walk, any "[" followed (after optional whitespace)
// by "filter" or "include" ANYWHERE in the text, in a comment or a value included, makes the text
// untrusted. That also flags words such as "[filters]" or "[includes]". These false positives
// are accepted on purpose; the cost is a missing marker, never a missed section.
function configIsUntrusted(text) {
  if (typeof text !== 'string') return true;
  if (/\[\s*(filter|include)/i.test(text)) return true;
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
      // Legacy dotted base ("[section.sub"): git allows letters, digits, "-" and "." here, then
      // optional whitespace and a quoted subsection, exactly as for a plain name.
      while (i < s.length && /[A-Za-z0-9.-]/.test(s[i])) i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '"') {
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

// The value in <gitdir>/commondir. Git drops line breaks at the end and trims nothing else, so
// " c" names a directory called " c". ampline is STRICTER than git: one trailing newline is
// dropped, and a value with leading or trailing whitespace, a carriage return, an embedded newline
// or no characters at all returns null (untrusted, call skipped) instead of being guessed at.
function parseCommonDir(text) {
  let value = text;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value === '' || /[\r\n]/.test(value) || /^\s|\s$/.test(value)) return null;
  return value;
}

// True only when every repo-local config file ampline can find is readable and clean:
// <gitdir>/config and config.worktree, plus, for a linked worktree, the same two in the common
// directory named by <gitdir>/commondir. Git resolves that directory by joining
// "<gitdir>/<commondir>" and asking the file system for the real path, which follows symlinks
// before any ".." is applied; so the string is handed to realpath unnormalised (path.join or
// path.resolve would collapse ".." first). If realpath fails the repository is untrusted.
// `opts.realpath` is a test seam.
function repoConfigIsTrusted(gitDir, opts) {
  const realpath = (opts && opts.realpath) || fs.realpathSync.native;
  try {
    const dirs = [gitDir];
    const commonText = readRepoConfig(path.join(gitDir, 'commondir'));
    if (commonText === 'bad') return false;
    if (commonText !== 'absent') {
      const value = parseCommonDir(commonText);
      if (value === null) return false;
      const joined = path.isAbsolute(value) ? value : gitDir + '/' + value;
      const common = realpath(joined);
      if (typeof common !== 'string' || common === '') return false;
      if (common !== gitDir) dirs.push(common);
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

// The exact `git status` command line. What each part does (D20 and its follow-up):
//  - `-c core.fsmonitor=` overrides the fsmonitor hook command for this call.
//  - `-c safe.bareRepository=explicit` stops git from treating a bare-looking directory it
//    happens to be inside as the repository (older gits ignore the setting).
//  - `--no-optional-locks` is a defense, not only a courtesy: without it `git status` refreshes
//    and writes the index, and a repository-local post-index-change hook can run.
//  - `--ignore-submodules=dirty` stops git from running inside submodules, whose own config is
//    not scanned. The trade-off: a submodule whose work tree is dirty no longer sets the dirty
//    marker, while a moved submodule commit still counts as a change.
// DO NOT add --git-dir or --work-tree. They would make git skip its repository discovery, and
// with it its dubious-ownership (safe.directory) check, so a repository owned by someone else
// would be inspected instead of refused. Instead git is started with cwd set to the directory
// that holds the .git entry ampline scanned (see getGitState): git checks <dir>/.git first, so
// its discovery begins at that entry and it keeps its ownership check.
// This reduces, and does not eliminate, what a repository's own configuration can make git do:
// repo-local filter drivers and includes are caught by the scan, and the call is skipped; the rest
// of the repository's own config is trusted as when you run git yourself there. Not a sandbox.
function buildStatusArgs() {
  return [
    '-c', 'core.fsmonitor=',
    '-c', 'safe.bareRepository=explicit',
    '--no-optional-locks',
    'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules=dirty',
  ];
}

// The child's environment: ours, plus GIT_NO_LAZY_FETCH=1 so a partial clone never makes the
// statusline fetch from a remote (a cheap guard; the status call needs no objects it lacks).
function buildStatusEnv(env) {
  return { ...env, GIT_NO_LAZY_FETCH: '1' };
}

// One cached `git status` call for ahead/behind/dirty — execFileSync blocks
// the event loop and can't be timeout-bounded, so we avoid extra calls.
function getGitState(dir, repo) {
  // Checked before the cache is read, so an untrusted repository never serves, or leaves behind,
  // a result from a subprocess it influenced.
  if (!repo.pinnable || !repoConfigIsTrusted(repo.gitDir)) return null;
  const key = `git:${repo.gitDir}`;
  const cached = cache.read(key);
  if (cached && cached.age < GIT_FRESH_MS && cached.value) return cached.value;

  try {
    const out = execFileSync(
      'git',
      buildStatusArgs(),
      {
        // The work tree that holds the scanned .git entry, not the (possibly deeper) cwd.
        cwd: repo.workTree, env: buildStatusEnv(process.env), encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      }
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

    const repo = resolveRepo(dir);
    if (!repo) return null;
    const gitDir = repo.gitDir;

    const rawBranch = sanitize(getBranch(gitDir));
    if (!rawBranch) return null;
    const branch = truncateBranch(rawBranch, config.maxBranchLength);

    const state = getGitState(dir, repo);

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

module.exports = {
  renderGitSegment, resolveGitDir, resolveRepo, parseStatusV2, buildStatusArgs, buildStatusEnv,
  configIsUntrusted, repoConfigIsTrusted,
};
