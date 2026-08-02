'use strict';
const { RESET, BOLD, DIM, dangerStyle } = require('./colors');

// 8 cells: chosen over the plan's default of 6 after a side-by-side visual
// review (6/8/10) — see DECISIONS.md. 9 fill states at ~12.5%/block, a
// noticeably finer read than 6's 16.7%/block, for two extra columns.
const BAR_WIDTH = 8;
const FILLED = '█'; // █
const EMPTY  = '░'; // ░

// Renders "<label><pct> <bar>", e.g. "C87 █████░", with danger styling
// applied to the whole unit and a ⚠ prefix at 95+.
//
// opts.stale marks a value recovered from cache before this session's first
// API response. Stale values render DIM with no danger color, no bold, and
// no warning glyph — an urgency signal derived from a possibly-outdated
// number is worse than no signal.
//
// Returns null for non-finite input. Without this guard, Math.round(NaN)
// propagates: '█'.repeat(NaN) yields '' and the bar renders the literal
// text "NaN" in whatever style dangerStyle fell through to.
function renderBar(label, usedPct, opts) {
  if (!Number.isFinite(usedPct)) return null;
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
