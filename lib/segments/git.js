'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DIM, RESET, fg } = require('../colors');
const cache = require('../cache');

const DEFAULT_MAX_BRANCH_LEN = 24;
const GIT_TIMEOUT_MS = 400;
const GIT_FRESH_MS = 5000;
const GIT_STALE_MS = 60000;

// Walk up looking for .git. Handles the worktree/submodule case where .git
// is a FILE containing "gitdir: <path>" rather than a directory.
function resolveGitDir(dir) {
  let cur = dir;
  for (let i = 0; i < 50 && cur; i++) {
    const candidate = path.join(cur, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        const m = fs.readFileSync(candidate, 'utf8').match(/gitdir:\s*(.+)/);
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

// Head-truncate, preserving the start — ticket IDs like "TAMA5-32796" live
// at the front of branch names and are the useful part.
function truncateBranch(name, max) {
  const limit = Number.isFinite(max) && max > 4 ? max : DEFAULT_MAX_BRANCH_LEN;
  return name.length > limit ? name.slice(0, limit - 1) + '…' : name;
}

function getBranch(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7); // detached
    return '';
  } catch {
    return '';
  }
}

// "# branch.ab +<ahead> -<behind>" — note the ordering. Only present when an
// upstream is configured, so ahead/behind stay null on a fresh local branch.
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

// One subprocess for ahead, behind, and dirty — cached together so it is one
// call per TTL window rather than two independent ones.
function getGitState(dir, gitDir) {
  const key = `git:${gitDir}`;
  const cached = cache.read(key);
  if (cached && cached.age < GIT_FRESH_MS && cached.value) return cached.value;

  try {
    const out = execFileSync(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
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
    const dir = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();

    const gitDir = resolveGitDir(dir);
    if (!gitDir) return null;

    const rawBranch = getBranch(gitDir);
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

module.exports = { renderGitSegment, resolveGitDir, parseStatusV2 };
