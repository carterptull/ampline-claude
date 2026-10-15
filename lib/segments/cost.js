'use strict';
const { DIM, RESET, fg } = require('../colors');

// These numbers arrive from outside. A finite number is not enough: toFixed(2) of 1e21 is
// "1e+21", a negative prints "$-5.00" or "+-3", and a fractional line count is not a count
// (the same class as pr.number in D38). Anything outside a sane range is left out.
const MAX_COST_USD = 1e9;
function usd(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < MAX_COST_USD ? v : null;
}
function count(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// Diff colors (green/red) stay unthemed — their own universal convention.
function renderCostSegment(ctx) {
  try {
    const cost = (ctx && ctx.input && ctx.input.cost) || null;
    if (!cost) return null;

    let money = '';
    const spent = usd(cost.total_cost_usd);
    if (spent !== null) {
      money = `${DIM}$${spent.toFixed(2)}${RESET}`;
    }

    let lines = '';
    const added = count(cost.total_lines_added);
    const removed = count(cost.total_lines_removed);
    if (added !== null || removed !== null) {
      lines =
        `${fg(96, 200, 120)}+${added || 0}${RESET}` +
        `${DIM}/${RESET}` +
        `${fg(232, 67, 61)}-${removed || 0}${RESET}`;
    }

    if (!money && !lines) return null;
    return [money, lines].filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

module.exports = { renderCostSegment };
