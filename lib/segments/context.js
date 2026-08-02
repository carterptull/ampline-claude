'use strict';
const { renderBar } = require('../bar');

function renderContextSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const cw = input.context_window;
    if (!cw) return null;
    // Read used_percentage directly (not derived); it's null early in a session.
    const used = cw.used_percentage;
    if (!Number.isFinite(used)) return null;
    return renderBar('C', used);
  } catch {
    return null;
  }
}

module.exports = { renderContextSegment };
