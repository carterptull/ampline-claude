'use strict';
const path = require('path');
const { loadConfig, DEFAULT_CONFIG } = require('./config');
const { layout } = require('./layout');
const { stripAnsi, sanitize } = require('./colors');
const { resolveUsage } = require('./usage');

const { renderModelSegment } = require('./segments/model');
const { renderContextSegment } = require('./segments/context');
const { renderFiveHourSegment, renderWeeklySegment } = require('./segments/rateLimits');
const { renderGitSegment } = require('./segments/git');
const { renderCostSegment } = require('./segments/cost');
const { renderTaskSegment } = require('./segments/task');
const { renderPrSegment } = require('./segments/pr');

// First non-empty STRING among the payload's directory fields. An object or a number there
// would otherwise reach path.basename and either throw or print as object text.
function currentDir(input) {
  const fromWorkspace = input.workspace && input.workspace.current_dir;
  for (const v of [fromWorkspace, input.cwd]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return process.cwd();
}

// Every other text segment is bounded (model 32, branch 24, task 40); a repo name of
// ten megabytes printed ten megabytes. Cut by code point, and sliced first so a huge string is
// never expanded into an array.
const MAX_DIR_LEN = 40;
function capDir(name) {
  const chars = Array.from(name.slice(0, MAX_DIR_LEN * 4));
  return chars.length > MAX_DIR_LEN ? chars.slice(0, MAX_DIR_LEN - 1).join('') + '…' : chars.join('');
}

// Prefers the repo name from the origin remote over cwd's basename — it's
// the identity you actually think in, and stays correct from a subdirectory.
// repo.name must be a string: String({}) is "[object Object]" and String(5) is "5". A name
// that is blank after cleaning falls back to the directory name rather than printing nothing.
function renderDirSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const repo = input.workspace && input.workspace.repo;
    if (repo && typeof repo.name === 'string') {
      const named = sanitize(repo.name).trim();
      if (named) return capDir(named);
    }
    const base = sanitize(path.basename(currentDir(input))).trim();
    return base ? capDir(base) : null;
  } catch {
    return null;
  }
}

const RENDERERS = {
  dir: renderDirSegment,
  git: renderGitSegment,
  model: renderModelSegment,
  context: renderContextSegment,
  fiveHour: renderFiveHourSegment,
  weekly: renderWeeklySegment,
  cost: renderCostSegment,
  task: renderTaskSegment,
  pr: renderPrSegment,
};

function renderStatusline(input) {
  const data = input && typeof input === 'object' ? input : {};

  let config;
  try { config = loadConfig(currentDir(data)); }
  catch { config = DEFAULT_CONFIG; }

  let usage = null;
  try { usage = resolveUsage(data); }
  catch { usage = null; }

  const ctx = { input: data, config, usage };

  const segments = Array.isArray(config.segments) && config.segments.length
    ? config.segments
    : DEFAULT_CONFIG.segments;

  let splitIdx = segments.indexOf(config.line2From);
  if (splitIdx <= 0) splitIdx = -1; // 0 would push everything to line 2, emptying line 1

  const line1 = [];
  const line2 = [];

  segments.forEach((name, i) => {
    const fn = RENDERERS[name];
    if (!fn) return;
    let out = null;
    try { out = fn(ctx); } catch { out = null; }
    if (!out) return;
    if (splitIdx > 0 && i >= splitIdx) line2.push(out);
    else line1.push(out);
  });

  if (!line1.length && !line2.length) return '';

  let line = layout(line1, line2, config.separator);
  if (config.color === false) line = stripAnsi(line);
  return line;
}

module.exports = { renderStatusline, renderDirSegment, RENDERERS };
