'use strict';
const {
  colorForModelEffort, normalizeEffortLevel, RESET, BOLD, DIM,
} = require('../colors');

// display_name carries a version suffix on the live payload ("Sonnet 5", not
// "Opus") — see DECISIONS.md D1. Rendered as-is; this strip only guards
// against a bare "claude "-prefixed id or an older "(N context)" suffix.
function shortenModel(name) {
  return String(name)
    .replace(/\s*\(\s*\d+[km]?\s*context\s*\)/i, '')
    .replace(/^claude\s+/i, '')
    .trim();
}

function renderModelSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const model = input.model || {};
    const raw = model.display_name || model.id;
    if (!raw) return null;

    const name = shortenModel(raw);
    const color = colorForModelEffort(model.id, model.display_name, input.effort && input.effort.level);

    // The effort object is ABSENT for models that do not support the effort
    // parameter. Render the model name alone — do NOT substitute a default,
    // which would label every Haiku session with an effort it never had.
    const effort = normalizeEffortLevel(input.effort && input.effort.level);
    if (!effort) return `${color}${name}${RESET}`;

    // `max` is loud enough to earn bold; everything below stays quiet so the
    // usage segments own urgency.
    const weight = effort === 'max' ? BOLD : '';
    return `${color}${name}${RESET}${DIM} · ${RESET}${weight}${color}${effort}${RESET}`;
  } catch {
    return null;
  }
}

module.exports = { renderModelSegment, shortenModel };
