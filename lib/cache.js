'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto'); // Node builtin — not a dependency

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'ampline');
const MAX_KEY_LEN = 64;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_CHANCE = 0.01;

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); return true; }
  catch { return false; }
}

// Windows forbids : \ / * ? " < > | in filenames, and ':' in particular is
// alternate-data-stream syntax on NTFS — a key like `task:<session_id>` does
// not fail loudly there, it just never round-trips. Strip everything outside
// [A-Za-z0-9_-], then hash anything still long enough to threaten a path
// limit (git keys embed an absolute path).
function safeKey(key) {
  const raw = String(key);
  const slug = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (slug.length <= MAX_KEY_LEN) return slug;
  const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  return `${slug.slice(0, MAX_KEY_LEN - 17)}-${digest}`;
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${safeKey(key)}.json`);
}

// Returns { age, value } or null. TTL decisions belong to the caller.
// Tolerates: missing file, unreadable file, invalid JSON, wrong shape.
function read(key) {
  try {
    const p = cachePath(key);
    const stat = fs.statSync(p);
    const text = fs.readFileSync(p, 'utf8');
    const value = JSON.parse(text);
    const age = Date.now() - stat.mtimeMs;
    return { age: Number.isFinite(age) ? Math.max(0, age) : Infinity, value };
  } catch {
    return null;
  }
}

// Atomic: write to a pid-scoped temp file, then rename over the target.
// The main statusline and the subagent statusline are separate processes
// firing on the same tick against the same files. A plain writeFileSync
// lets a reader observe a truncated file (throws, recoverable) or — worse —
// a valid-but-partial one (renders garbage). renameSync is atomic on POSIX
// and replaces the destination on Windows.
function write(key, value) {
  if (!ensureDir()) return;
  const target = cachePath(key);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return;
  }
  // Prune probabilistically so it never adds latency to a normal render.
  if (Math.random() < PRUNE_CHANCE) prune();
}

function remove(key) {
  try { fs.rmSync(cachePath(key), { force: true }); } catch {}
}

// task:<session_id> and git:<gitdir> keys accumulate one file per session
// and per repo, forever. Nothing else ever deletes them.
function prune() {
  try {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

module.exports = { read, write, remove, prune, CACHE_DIR };
