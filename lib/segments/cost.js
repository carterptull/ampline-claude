'use strict';
const { DIM, RESET, fg } = require('../colors');

// Diff colors (green/red) stay unthemed — their own universal convention.
function renderCostSegment(ctx) {
  try {
    const cost = (ctx && ctx.input && ctx.input.cost) || null;
    if (!cost) return null;

    let money = '';
    if (Number.isFinite(cost.total_cost_usd)) {
      money = `${DIM}$${cost.total_cost_usd.toFixed(2)}${RESET}`;
    }

    let lines = '';
    const added = Number.isFinite(cost.total_lines_added) ? cost.total_lines_added : null;
    const removed = Number.isFinite(cost.total_lines_removed) ? cost.total_lines_removed : null;
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
