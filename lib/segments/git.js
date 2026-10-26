'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DIM, RESET, fg, sanitize } = require('../colors');
const cache = require('../cache');
const { readSmallTextFile } = require('../safeRead');
const { MAX_WALK_UP } = require('../config');

const DEFAULT_MAX_BRANCH_LEN = 24;
const GIT_TIMEOUT_MS = 400;
const GIT_FRESH_MS = 5000;
const GIT_STALE_MS = 60000;
// A `git status` that failed or timed out is remembered this long, so a slow repository does
// not cost the full timeout on every render.
const GIT_FAILURE_MS = 30000;

// Git reads the value in a .git file ("gitdir: <path>") and in <gitdir>/commondir literally,
// minus trailing line breaks, so " g" and "g" are different directories. ampline is STRICTER than
// git here: it accepts only the exact shape git itself writes (a value with no leading or trailing
// whitespace and at most one trailing newline) and treats anything else (extra spaces, a carriage
// return, an embedded newline, an empty value) as untrusted, so the call is skipped.
function parseStrictValue(text) {
  if (typeof text !== 'string') return null;
  let value = text;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value === '' || /[\r\n]/.test(value) || /^\s|\s$/.test(value)) return null;
  return value;
}

function parseGitFileStrict(text) {
  if (typeof text !== 'string' || !text.startsWith('gitdir: ')) return null;
  return parseStrictValue(text.slice('gitdir: '.length));
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

// Finds the repository for `dir`: { gitDir, realGitDir, workTree, pinnable } or null.
// .git can be a FILE with "gitdir: <path>" (worktrees/submodules), not a dir. `workTree` is the
// directory that holds the .git entry; git is later started there (by its real path, see
// gitStartDir), so its discovery begins at that entry and GIT_CEILING_DIRECTORIES limits how far it
// can climb if the entry is rejected (see buildStatusEnv).
// `gitDir` is the textual path (used as the cache key); `realGitDir` is where git actually reads:
// for a .git file, "<dir>/<value>" resolved on disk by realpath, symlinks followed before ".."
// (null if that fails). `pinnable` is true only when git would accept that entry too: the .git
// file is in git's exact shape, the real git dir passes a mirror of git's is_git_directory check,
// and no bare-looking directory sits between `dir` and the entry. When it is false the branch
// still renders but `git status` is not run. `opts.realpath` is a test seam.
function resolveRepo(dir, opts) {
  const realpath = (opts && opts.realpath) || fs.realpathSync.native;
  // Absolute first, so the directory that is scanned and the one git runs in are the same.
  let cur = path.resolve(dir);
  let sawGitDirLike = false;
  for (let i = 0; i < MAX_WALK_UP && cur; i++) {
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
        let realGitDir = null;
        if (strict !== null) {
          try {
            const real = realpath(path.isAbsolute(strict) ? strict : path.dirname(candidate) + '/' + strict);
            if (typeof real === 'string' && real !== '') realGitDir = real;
          } catch {}
        }
        return {
          gitDir: path.resolve(path.dirname(candidate), target),
          realGitDir,
          workTree: cur,
          pinnable: strict !== null && !sawGitDirLike && realGitDir !== null && isGitDirectory(realGitDir, realpath),
        };
      }
      if (stat.isDirectory()) {
        return {
          gitDir: candidate,
          realGitDir: candidate,
          workTree: cur,
          pinnable: !sawGitDirLike && isGitDirectory(candidate, realpath),
        };
      }
    } catch {}
    if (looksLikeGitDir(cur)) sawGitDirLike = true;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
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
//  - Aligned: git is started in the work tree that holds the .git entry ampline scanned, by its
//    real path, with GIT_CEILING_DIRECTORIES set to that real path's parent, so a rejected entry
//    makes git fail rather than climb into a repository ampline never scanned. git keeps its own
//    ownership (safe.directory) check. ampline's reading of .git files and commondir is stricter than
//    git's, and it mirrors the parts of git's is_git_directory check listed below (HEAD, objects/,
//    refs/). That mirror is not complete; the ceiling at the real path is the backstop for any gap.
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

// ABSENT (no such file, which is normal for config.worktree), BAD (present but not a small
// readable regular file), or the text. The first two are Symbols, never strings, so no file
// content (a commondir that says "absent", say) can be mistaken for them.
const ABSENT = Symbol('absent');
const BAD = Symbol('bad');
function readRepoConfig(p) {
  const text = readSmallTextFile(p, CONFIG_MAX_BYTES);
  if (text !== null) return text;
  // The read found nothing usable; one stat tells a missing file from a bad one.
  try {
    fs.statSync(p);
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? ABSENT : BAD;
  }
  return BAD;
}

// The value in <gitdir>/commondir: the same strict shape as a .git file's target (see
// parseStrictValue); null means untrusted and the call is skipped.
const parseCommonDir = parseStrictValue;

// The directory holding objects/ and refs/ for `gitDir`: the git dir itself, or, for a linked
// worktree, the one named by <gitdir>/commondir. Git resolves that by joining
// "<gitdir>/<commondir>" and asking the file system for the real path, which follows symlinks
// before any ".." is applied; so the string is handed to realpath unnormalised (path.join or
// path.resolve would collapse ".." first). Returns null (untrusted) when the file is unreadable,
// not a clean value, or realpath fails.
function resolveCommonDir(gitDir, realpath) {
  const commonText = readRepoConfig(path.join(gitDir, 'commondir'));
  if (commonText === BAD) return null;
  if (commonText === ABSENT) return gitDir;
  const value = parseCommonDir(commonText);
  if (value === null) return null;
  try {
    const common = realpath(path.isAbsolute(value) ? value : gitDir + '/' + value);
    return typeof common === 'string' && common !== '' ? common : null;
  } catch {
    return null;
  }
}

// A mirror of git's is_git_directory: a HEAD that is a ref or an object id, plus objects/ and
// refs/ directories that git can search (access X_OK) in the git dir (the common dir for a linked
// worktree). Git only accepts a .git directory that passes; otherwise it silently keeps walking
// up to a repository ampline never scanned. HEAD is tested exactly as it is on disk: git skips no
// leading whitespace before "ref:" or an object id, so neither does this (a trimmed copy would
// pass a HEAD that git rejects). Failing the mirror skips the call; it does not claim to cover every
// way git can decide differently, which is what the ceiling at the real path is for. The
// whitespace after "ref:" is git's own set (space, tab, newline, carriage return), not JS's \s,
// which also matches \v, \f and no-break space.
const HEAD_REF = /^ref:[ \t\n\r]*refs\//;
const HEAD_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$/i;
function isSearchableDir(p) {
  if (!fs.statSync(p).isDirectory()) return false;
  fs.accessSync(p, fs.constants.X_OK);
  return true;
}
function isGitDirectory(gitDir, realpath) {
  try {
    const head = readSmallTextFile(path.join(gitDir, 'HEAD'));
    if (head === null) return false;
    if (!HEAD_REF.test(head) && !HEAD_OBJECT_ID.test(head)) return false;
    const common = resolveCommonDir(gitDir, realpath);
    if (common === null) return false;
    return isSearchableDir(path.join(common, 'objects')) && isSearchableDir(path.join(common, 'refs'));
  } catch {
    return false;
  }
}

// True only when every repo-local config file ampline can find is readable and clean:
// <gitdir>/config and config.worktree, plus, for a linked worktree, the same two in the common
// directory named by <gitdir>/commondir (see resolveCommonDir). `opts.realpath` is a test seam.
function repoConfigIsTrusted(gitDir, opts) {
  const realpath = (opts && opts.realpath) || fs.realpathSync.native;
  try {
    const dirs = [gitDir];
    const common = resolveCommonDir(gitDir, realpath);
    if (common === null) return false;
    if (common !== gitDir) dirs.push(common);
    for (const dir of dirs) {
      for (const name of ['config', 'config.worktree']) {
        const text = readRepoConfig(path.join(dir, name));
        if (text === ABSENT) continue;
        if (text === BAD || configIsUntrusted(text)) return false;
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
// its discovery begins at that entry; if the entry is rejected, GIT_CEILING_DIRECTORIES
// (buildStatusEnv) makes git fail instead of climbing into a repository ampline never scanned; and
// it keeps its ownership check. Both the cwd and the ceiling are REAL paths (gitStartDir): git
// compares the ceiling with the real path of its cwd, so a work tree reached through a symlink or
// junction would otherwise slip past a ceiling built from the logical path.
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

// The child's environment: ours, minus every variable that tells git where a repository is (they
// would override the discovery that starts at the scanned work tree), plus:
//  - GIT_CEILING_DIRECTORIES = the parent of the work tree (pass the REAL path, see gitStartDir),
//    so a rejected .git entry makes git fail instead of discovering a repository ampline never
//    scanned. Omitted at a filesystem root, where there is no parent. It keeps git's discovery and
//    ownership check. It is a ceiling on how far git climbs, not a sandbox.
//  - GIT_NO_LAZY_FETCH=1, so a partial clone never makes the statusline fetch from a remote (a
//    cheap guard; the status call needs no objects it lacks). Git before 2.39.4/2.45.1
//    (depending on the release series) ignores it, as before 2.38 it ignores safe.bareRepository:
//    accepted residuals, see the D20 follow-up.
const GIT_LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];
// The directory git is started in, and whose parent becomes its ceiling: the REAL path of the work
// tree, or null (the call is skipped) when it cannot be resolved or its parent contains the
// list separator, which git would split into two ceilings. `realpath` is a test seam.
function gitStartDir(workTree, realpath) {
  const resolve = realpath || fs.realpathSync.native;
  try {
    const real = resolve(workTree);
    if (typeof real !== 'string' || real === '' || !path.isAbsolute(real)) return null;
    if (path.dirname(real).includes(path.delimiter)) return null;
    return real;
  } catch {
    return null;
  }
}

function buildStatusEnv(env, workTree) {
  const out = { ...env };
  for (const name of GIT_LOCATION_VARS) delete out[name];
  out.GIT_NO_LAZY_FETCH = '1';
  if (typeof workTree === 'string' && workTree !== '') {
    const parent = path.dirname(workTree);
    if (parent !== workTree) out.GIT_CEILING_DIRECTORIES = parent;
  }
  return out;
}

// One cached `git status` call for ahead/behind/dirty — execFileSync blocks
// the event loop and can't be timeout-bounded, so we avoid extra calls.
function getGitState(repo) {
  // Checked before the cache is read, so an untrusted repository never serves, or leaves behind,
  // a result from a subprocess it influenced.
  if (!repo.pinnable || !repoConfigIsTrusted(repo.realGitDir)) return null;
  const startDir = gitStartDir(repo.workTree);
  if (startDir === null) return null;
  const key = `git:${repo.gitDir}`;
  const cached = cache.read(key);
  // An entry is either a status ({ ahead, behind, dirty }) or a failure marker ({ failed: true }).
  const entry = cached && cached.value && typeof cached.value === 'object' ? cached.value : null;
  const lastFailed = !!entry && entry.failed === true;
  if (entry && lastFailed && cached.age < GIT_FAILURE_MS) return null;
  if (entry && !lastFailed && cached.age < GIT_FRESH_MS) return entry;

  try {
    const out = execFileSync(
      'git',
      buildStatusArgs(),
      {
        // The real path of the work tree that holds the scanned .git entry, not the (possibly
        // deeper, possibly linked) cwd.
        cwd: startDir, env: buildStatusEnv(process.env, startDir), encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const value = parseStatusV2(out);
    cache.write(key, value);
    return value;
  } catch {
    // A recent good status is better than nothing, and is left in place. Without one, remember
    // the failure so the next renders skip the subprocess for GIT_FAILURE_MS.
    if (entry && !lastFailed && cached.age < GIT_STALE_MS) return entry;
    cache.write(key, { failed: true });
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

    const rawBranch = sanitize(getBranch(repo.realGitDir || gitDir));
    if (!rawBranch) return null;
    const branch = truncateBranch(rawBranch, config.maxBranchLength);

    const state = getGitState(repo);

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
  renderGitSegment, resolveRepo, gitStartDir, parseStatusV2, buildStatusArgs, buildStatusEnv,
  configIsUntrusted, repoConfigIsTrusted,
};
