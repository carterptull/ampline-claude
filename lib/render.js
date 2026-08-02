'use strict';
const path = require('path');
const { loadConfig, DEFAULT_CONFIG } = require('./config');
const { layout } = require('./layout');
const { stripAnsi } = require('./colors');
const { resolveUsage } = require('./usage');

const { renderModelSegment } = require('./segments/model');
const { renderContextSegment } = require('./segments/context');
const { renderFiveHourSegment, renderWeeklySegment } = require('./segments/rateLimits');
const { renderGitSegment } = require('./segments/git');
const { renderCostSegment } = require('./segments/cost');
const { renderTaskSegment } = require('./segments/task');
const { renderPrSegment } = require('./segments/pr');

function currentDir(input) {
  return (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
}

// Prefers the repo name from the origin remote over cwd's basename — it's
// the identity you actually think in, and stays correct from a subdirectory.
function renderDirSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const repo = input.workspace && input.workspace.repo;
    if (repo && repo.name) return String(repo.name);
    const base = path.basename(currentDir(input));
    return base || null;
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
