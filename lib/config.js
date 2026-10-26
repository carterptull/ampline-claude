'use strict';
const path = require('path');
const os = require('os');
const { sanitize } = require('./colors');
const { readSmallTextFile } = require('./safeRead');

const DEFAULT_CONFIG = Object.freeze({
  segments: ['dir', 'git', 'model', 'context', 'fiveHour', 'weekly', 'cost', 'task', 'pr'],
  line2From: 'fiveHour',
  separator: ' │ ',
  color: true,
  // Opt-in: color the 5-hour and weekly bars by where the pace is heading, not only
  // where it is now. Off by default because it changes colors people already see.
  paceColors: false,
  maxBranchLength: 24,
  maxTaskLength: 40,
});

const VALID_SEGMENTS = new Set([
  'dir', 'git', 'model', 'context', 'fiveHour', 'weekly', 'cost', 'task', 'pr',
]);

const CONFIG_NAME = '.amplinerc.json';
const MAX_WALK_UP = 30;

// A config loads automatically from any checkout, so its values are bounded here: the separator
// is 16 code points at most, the two length settings stay in 5..200, and each segment can appear
// once. SEPARATOR_PRESLICE only bounds the work done before the code point cap is applied.
const MAX_SEPARATOR_CODE_POINTS = 16;
const SEPARATOR_PRESLICE = 4096;
const MIN_LENGTH_SETTING = 5;
const MAX_LENGTH_SETTING = 200;

// Config is data only — never executed, no path/command keys. Bad values are
// corrected silently rather than thrown, consistent with the degradation contract.
function validateAndMerge(user) {
  const source = user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  const merged = { ...DEFAULT_CONFIG, ...source };

  if (!Array.isArray(merged.segments)) {
    merged.segments = DEFAULT_CONFIG.segments.slice();
  } else {
    // Names are checked and deduplicated (first occurrence wins) in one pass over a Set, so a
    // list of any length costs one lookup per entry and can never hold more than nine.
    const seen = new Set();
    for (const s of merged.segments) {
      if (typeof s === 'string' && VALID_SEGMENTS.has(s)) seen.add(s);
    }
    merged.segments = Array.from(seen);
    if (!merged.segments.length) merged.segments = DEFAULT_CONFIG.segments.slice();
  }

  // A repo-local .amplinerc.json loads automatically on cwd walk-up, so
  // separator is untrusted input — sanitize like any other foreign string.
  merged.separator = typeof merged.separator === 'string'
    ? Array.from(sanitize(merged.separator.slice(0, SEPARATOR_PRESLICE))).slice(0, MAX_SEPARATOR_CODE_POINTS).join('')
    : DEFAULT_CONFIG.separator;
  if (typeof merged.color !== 'boolean') merged.color = DEFAULT_CONFIG.color;
  if (typeof merged.paceColors !== 'boolean') merged.paceColors = DEFAULT_CONFIG.paceColors;

  for (const key of ['maxBranchLength', 'maxTaskLength']) {
    const n = merged[key];
    merged[key] = typeof n === 'number' && Number.isFinite(n) && n >= MIN_LENGTH_SETTING
      ? Math.min(Math.floor(n), MAX_LENGTH_SETTING)
      : DEFAULT_CONFIG[key];
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
      // A directory, device, FIFO or oversized file is skipped like a missing one.
      const text = readSmallTextFile(p);
      if (text === null) continue;
      return validateAndMerge(JSON.parse(text));
    } catch {
      continue;
    }
  }
  return { ...DEFAULT_CONFIG, segments: DEFAULT_CONFIG.segments.slice() };
}

module.exports = { loadConfig, validateAndMerge, DEFAULT_CONFIG, VALID_SEGMENTS };
