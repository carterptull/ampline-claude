'use strict';
const {
  colorForModelEffort, normalizeEffortLevel, RESET, BOLD, DIM,
} = require('../colors');

// display_name is rendered as-is (see DECISIONS.md D1); this only strips a
// bare "claude " prefix or a legacy "(N context)" suffix.
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

    // effort is absent for models without it (e.g. Haiku) — never default it.
    const effort = normalizeEffortLevel(input.effort && input.effort.level);
    if (!effort) return `${color}${name}${RESET}`;

    // Only `max` is bold; other levels stay quiet so usage segments own urgency.
    const weight = effort === 'max' ? BOLD : '';
    return `${color}${name}${RESET}${DIM} · ${RESET}${weight}${color}${effort}${RESET}`;
  } catch {
    return null;
  }
}

module.exports = { renderModelSegment, shortenModel };
