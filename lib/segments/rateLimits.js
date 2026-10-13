'use strict';
const { renderBar } = require('../bar');
const { formatCountdown, elapsedFraction, paceRampPct } = require('../usage');
const { DIM, RESET } = require('../colors');

// The payload carries resets_at but never the window length, so these are
// assumptions about Claude's plan windows (DECISIONS.md D39). A wrong constant
// only moves the marker; it cannot change the percentage or the countdown.
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// paceColors is opt-in: the ramp is read at the projected end-of-window use instead of
// the current one. paceRampPct returns null when it cannot say, and the bar ignores that.
function render(label, entry, stale, windowMs, paceColors) {
  if (!entry) return null;
  const marker = elapsedFraction(entry.resetsAtMs, windowMs);
  const rampPct = paceColors ? paceRampPct(entry.percentage, marker) : null;
  const bar = renderBar(label, entry.percentage, { stale: !!stale, marker, rampPct });
  if (!bar) return null;
  const cd = formatCountdown(entry.resetsAtMs);
  return cd ? `${bar}${DIM} ↺ ${cd}${RESET}` : bar;
}

function wantsPace(ctx) {
  return !!(ctx && ctx.config && ctx.config.paceColors === true);
}

function renderFiveHourSegment(ctx) {
  try {
    const usage = ctx && ctx.usage;
    return usage ? render('H', usage.fiveHour, usage.stale, FIVE_HOUR_WINDOW_MS, wantsPace(ctx)) : null;
  } catch {
    return null;
  }
}

function renderWeeklySegment(ctx) {
  try {
    const usage = ctx && ctx.usage;
    return usage ? render('W', usage.weekly, usage.stale, WEEKLY_WINDOW_MS, wantsPace(ctx)) : null;
  } catch {
    return null;
  }
}

module.exports = { renderFiveHourSegment, renderWeeklySegment };
