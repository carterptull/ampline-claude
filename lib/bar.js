'use strict';
const { RESET, BOLD, DIM, dangerStyle } = require('./colors');

// 8 cells chosen over 6 after a visual side-by-side review (see DECISIONS.md).
const BAR_WIDTH = 8;
const FILLED = '█';
const EMPTY  = '░';
// Full-height heavy line: a pole between solid cells and clearly not the ░ texture,
// so it reads in both regions with no color at all (D32 empties every attribute).
const MARKER = '┃';

// Swaps one cell for the marker. `marker` is the elapsed fraction 0..1; anything
// else draws nothing rather than a wrong position. Width never changes.
function withMarker(bar, marker) {
  if (typeof marker !== 'number' || !Number.isFinite(marker) || marker < 0 || marker > 1) return bar;
  const at = Math.min(BAR_WIDTH - 1, Math.floor(marker * BAR_WIDTH));
  return bar.slice(0, at) + MARKER + bar.slice(at + 1);
}

// opts.stale renders dim with no danger color/bold/glyph — an urgency signal
// from a possibly-outdated cached value is worse than no signal. It also draws
// no marker: the marker compares quota to a live clock, and a stale quota would
// make that comparison wrong.
// opts.marker (0..1) is the fraction of the window already elapsed.
// opts.rampPct is the percentage the danger ramp is READ at, when that should differ
// from the one shown (pace-aware coloring). It can only raise urgency: a value below
// the real percentage is ignored, so no caller can make a nearly-full bar look calm.
function renderBar(label, usedPct, opts) {
  if (!Number.isFinite(usedPct)) return null; // guards against NaN -> literal "NaN" in output
  const options = opts || {};

  const pct = Math.max(0, Math.min(100, usedPct));
  const shown = Math.round(pct);
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
  const bar = FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);

  if (options.stale) {
    return `${DIM}${label}${shown} ${bar}${RESET}`;
  }

  const marked = withMarker(bar, options.marker);
  const rampAt = typeof options.rampPct === 'number' && Number.isFinite(options.rampPct)
    ? Math.max(pct, options.rampPct)
    : pct;
  const style = dangerStyle(rampAt);
  if (!style) return `${label}${shown} ${marked}`;

  const weight = style.bold ? BOLD : '';
  const prefix = style.warn ? '⚠ ' : '';
  return `${weight}${style.color}${prefix}${label}${shown} ${marked}${RESET}`;
}

module.exports = { renderBar, BAR_WIDTH };
