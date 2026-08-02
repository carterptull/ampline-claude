'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG = Object.freeze({
  segments: ['dir', 'git', 'model', 'context', 'fiveHour', 'weekly', 'cost', 'task', 'pr'],
  line2From: 'fiveHour',
  separator: ' │ ',
  color: true,
  maxBranchLength: 24,
  maxTaskLength: 40,
});

const VALID_SEGMENTS = new Set([
  'dir', 'git', 'model', 'context', 'fiveHour', 'weekly', 'cost', 'task', 'pr',
]);

const CONFIG_NAME = '.amplinerc.json';
const MAX_WALK_UP = 30;

// Config is data only — never executed, no path/command keys. Bad values are
// corrected silently rather than thrown, consistent with the degradation contract.
function validateAndMerge(user) {
  const source = user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  const merged = { ...DEFAULT_CONFIG, ...source };

  if (!Array.isArray(merged.segments)) {
    merged.segments = DEFAULT_CONFIG.segments.slice();
  } else {
    merged.segments = merged.segments.filter((s) => VALID_SEGMENTS.has(s));
    if (!merged.segments.length) merged.segments = DEFAULT_CONFIG.segments.slice();
  }

  if (typeof merged.separator !== 'string') merged.separator = DEFAULT_CONFIG.separator;
  if (typeof merged.color !== 'boolean') merged.color = DEFAULT_CONFIG.color;

  for (const key of ['maxBranchLength', 'maxTaskLength']) {
    if (!Number.isFinite(merged[key]) || merged[key] < 5) merged[key] = DEFAULT_CONFIG[key];
  }

  // Validated against the user's actual segment list, not the full allowlist —
  // otherwise removing `fiveHour` while leaving the default line2From passes
  // validation and wrapping silently breaks.
  if (!merged.segments.includes(merged.line2From)) {
    merged.line2From = merged.segments.includes(DEFAULT_CONFIG.line2From)
      ? DEFAULT_CONFIG.line2From
      : merged.segments[Math.floor(merged.segments.length / 2)];
  }

  return merged;
}

function candidatePaths(cwd) {
  const out = [];
  let cur = cwd;
  for (let i = 0; i < MAX_WALK_UP && cur; i++) {
    out.push(path.join(cur, CONFIG_NAME));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const home = path.join(os.homedir(), CONFIG_NAME);
  if (!out.includes(home)) out.push(home);
  return out;
}

// Walks cwd upward to root, then home. First file found wins entirely — no
// merging across files, since partial overrides would be hard to debug.
function loadConfig(cwd) {
  const start = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  for (const p of candidatePaths(start)) {
    try {
      return validateAndMerge(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      continue;
    }
  }
  return { ...DEFAULT_CONFIG, segments: DEFAULT_CONFIG.segments.slice() };
}

module.exports = { loadConfig, validateAndMerge, DEFAULT_CONFIG, VALID_SEGMENTS };
