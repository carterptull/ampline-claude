'use strict';
const { DIM, RESET, fg } = require('../colors');

const REVIEW_COLORS = {
  approved: fg(96, 200, 120),
  pending: fg(245, 196, 61),
  changes_requested: fg(232, 67, 61),
  draft: DIM,
};

function renderPrSegment(ctx) {
  try {
    const pr = (ctx && ctx.input && ctx.input.pr) || null;
    if (!pr) return null;
    const number = Number(pr.number);
    if (!Number.isFinite(number)) return null;

    // review_state is independently absent even when pr is present.
    const color = REVIEW_COLORS[pr.review_state] || DIM;
    return `${color}#${number}${RESET}`;
  } catch {
    return null;
  }
}

module.exports = { renderPrSegment };
