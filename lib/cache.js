'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeDir } = require('./claudeDir');

const CACHE_DIR = path.join(claudeDir(), 'cache', 'ampline');
const MAX_KEY_LEN = 64;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_CHANCE = 0.01;

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); return true; }
  catch { return false; }
}

// Windows forbids : \ / * ? " < > | in filenames (':' is NTFS ADS syntax, so
// e.g. `task:<id>` silently fails to round-trip); strip to [A-Za-z0-9_-] and
// hash if still too long for a path limit.
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

// TTL decisions belong to the caller; this just tolerates a missing/invalid file.
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

// Write to a pid-scoped tmp file then rename, since the main and subagent
// statuslines are separate processes that can write the same key concurrently.
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
  if (Math.random() < PRUNE_CHANCE) prune(); // probabilistic so pruning never adds latency to a normal render
}

function remove(key) {
  try { fs.rmSync(cachePath(key), { force: true }); } catch {}
}

// Nothing else ever deletes accumulated per-session/per-repo cache files.
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
