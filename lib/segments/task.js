'use strict';
const fs = require('fs');
const path = require('path');
const { DIM, RESET, sanitize } = require('../colors');
const cache = require('../cache');
const { claudeDir } = require('../claudeDir');

const FRESH_MS = 3000;
const STALE_MS = 15000;
const DEFAULT_MAX_TASK_LEN = 40;

// session_id is a lookup key into ~/.claude/todos and into the cache. Real ids are UUIDs, so a
// narrow character set loses nothing, and it keeps two different ids from slugging to the same
// cache key (cache.js maps every other character to "_").
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// A todo file belongs to a session when it is exactly "<id>.json" or "<id>-agent-<...>.json".
// A bare prefix match would let a short or truncated id surface another session's task.
function belongsTo(fileName, sessionId) {
  if (!fileName.endsWith('.json')) return false;
  return fileName === sessionId + '.json' || fileName.startsWith(sessionId + '-agent-');
}

function readTask(sessionId) {
  const dir = path.join(claudeDir(), 'todos');
  let names;
  try { names = fs.readdirSync(dir); } catch { return ''; }

  // Filter before statting — todos/ accumulates one file per session forever.
  const candidates = names.filter((f) => belongsTo(f, sessionId));
  if (!candidates.length) return '';

  const scored = [];
  for (const name of candidates) {
    try {
      scored.push({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs });
    } catch {}
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.mtime - a.mtime);

  let todos;
  try {
    todos = JSON.parse(fs.readFileSync(path.join(dir, scored[0].name), 'utf8'));
  } catch {
    return '';
  }
  if (!Array.isArray(todos)) return '';

  // The text is model output on disk. Only a non-blank STRING is a task: an object would
  // print as "[object Object]", and this value is cached, so it would print on every render
  // after the first.
  const active = todos.find((t) => t && t.status === 'in_progress');
  if (!active) return '';
  const text = [active.activeForm, active.content].find((v) => typeof v === 'string' && v.trim() !== '');
  return text || '';
}

function renderTaskSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const config = (ctx && ctx.config) || {};
    const sessionId = input.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;

    const key = `task:${sessionId}`;
    const cached = cache.read(key);
    if (cached && cached.age < FRESH_MS) {
      return typeof cached.value === 'string' && cached.value ? decorate(cached.value, config) : null;
    }

    let task;
    try {
      task = readTask(sessionId);
      cache.write(key, task);
    } catch {
      if (cached && cached.age < STALE_MS) task = cached.value;
      else return null;
    }

    if (!task || typeof task !== 'string') return null;
    return decorate(task, config);
  } catch {
    return null;
  }
}

function decorate(task, config) {
  // Blank after cleaning (control characters only, or whitespace) means there is no task to
  // show; returning a styled empty string would leave an empty segment and a doubled separator.
  const clean = sanitize(task).trim();
  if (!clean) return null;
  const limit = Number.isFinite(config.maxTaskLength) && config.maxTaskLength > 4
    ? config.maxTaskLength
    : DEFAULT_MAX_TASK_LEN;
  // Array.from splits by code point, not UTF-16 unit — a truncated emoji
  // shouldn't leave a broken surrogate half in the output. Sliced first so a huge string
  // is never expanded into an array of code points just to keep the first few dozen.
  const chars = Array.from(clean.slice(0, limit * 4));
  const shown = chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : clean;
  return `${DIM}${shown}${RESET}`;
}

module.exports = { renderTaskSegment };
