'use strict';
const {
  colorForModelEffort, normalizeEffortLevel, sanitize, RESET, BOLD, DIM,
} = require('../colors');

// display_name is rendered as-is (see DECISIONS.md D1); this only strips a
// bare "claude " prefix or a legacy "(N context)" suffix.
function shortenModel(name) {
  return String(name)
    .replace(/\s*\(\s*\d+[km]?\s*context\s*\)/i, '')
    .replace(/^claude\s+/i, '')
    .trim();
}

// Never fires on a real display_name (D1, ~10-15 chars) — guards the
// fallback-to-`id` path, where a Bedrock/Vertex model id can be 40-100+ chars.
const MAX_MODEL_LEN = 32;
function capModel(name) {
  const chars = Array.from(name);
  return chars.length > MAX_MODEL_LEN ? chars.slice(0, MAX_MODEL_LEN - 1).join('') + '…' : name;
}

function renderModelSegment(ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    const model = input.model || {};
    const raw = model.display_name || model.id;
    if (!raw) return null;

    const name = capModel(shortenModel(sanitize(raw)));
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
