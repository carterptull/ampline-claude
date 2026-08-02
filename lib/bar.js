'use strict';
const { RESET, BOLD, DIM, dangerStyle } = require('./colors');

// 8 cells chosen over 6 after a visual side-by-side review (see DECISIONS.md).
const BAR_WIDTH = 8;
const FILLED = '█';
const EMPTY  = '░';

// opts.stale renders dim with no danger color/bold/glyph — an urgency signal
// from a possibly-outdated cached value is worse than no signal.
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

  const style = dangerStyle(pct);
  if (!style) return `${label}${shown} ${bar}`;

  const weight = style.bold ? BOLD : '';
  const prefix = style.warn ? '⚠ ' : '';
  return `${weight}${style.color}${prefix}${label}${shown} ${bar}${RESET}`;
}

module.exports = { renderBar, BAR_WIDTH };
