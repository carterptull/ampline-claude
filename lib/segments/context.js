'use strict';
const { renderBar } = require('../bar');

function renderContextSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const cw = input.context_window;
    if (!cw) return null;
    // used_percentage and remaining_percentage BOTH exist. Read used
    // directly. Both may be null early in the session; Number.isFinite
    // rejects null, undefined, and NaN in one check.
    const used = cw.used_percentage;
    if (!Number.isFinite(used)) return null;
    return renderBar('C', used);
  } catch {
    return null;
  }
}

module.exports = { renderContextSegment };
