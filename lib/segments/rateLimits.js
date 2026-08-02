'use strict';
const { renderBar } = require('../bar');
const { formatCountdown } = require('../usage');
const { DIM, RESET } = require('../colors');

function render(label, entry, stale) {
  if (!entry) return null;
  const bar = renderBar(label, entry.percentage, { stale: !!stale });
  if (!bar) return null;
  const cd = formatCountdown(entry.resetsAtMs);
  return cd ? `${bar}${DIM} ↺ ${cd}${RESET}` : bar;
}

function renderFiveHourSegment(ctx) {
  const usage = ctx && ctx.usage;
  return usage ? render('H', usage.fiveHour, usage.stale) : null;
}

function renderWeeklySegment(ctx) {
  const usage = ctx && ctx.usage;
  return usage ? render('W', usage.weekly, usage.stale) : null;
}

module.exports = { renderFiveHourSegment, renderWeeklySegment };
