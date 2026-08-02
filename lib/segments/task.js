'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIM, RESET } = require('../colors');
const cache = require('../cache');

const FRESH_MS = 3000;
const STALE_MS = 15000;
const DEFAULT_MAX_TASK_LEN = 40;

function readTask(sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'todos');
  let names;
  try { names = fs.readdirSync(dir); } catch { return ''; }

  // Filter before statting — todos/ accumulates one file per session forever.
  const candidates = names.filter((f) => f.startsWith(sessionId) && f.endsWith('.json'));
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

  const active = todos.find((t) => t && t.status === 'in_progress');
  return (active && (active.activeForm || active.content)) || '';
}

function renderTaskSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const config = (ctx && ctx.config) || {};
    const sessionId = input.session_id;
    if (!sessionId) return null;

    const key = `task:${sessionId}`;
    const cached = cache.read(key);
    if (cached && cached.age < FRESH_MS) {
      return cached.value ? decorate(cached.value, config) : null;
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
  const limit = Number.isFinite(config.maxTaskLength) && config.maxTaskLength > 4
    ? config.maxTaskLength
    : DEFAULT_MAX_TASK_LEN;
  const shown = task.length > limit ? task.slice(0, limit - 1) + '…' : task;
  return `${DIM}${shown}${RESET}`;
}

module.exports = { renderTaskSegment };
