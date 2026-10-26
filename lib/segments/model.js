'use strict';
const {
  colorForModelEffort, normalizeEffortLevel, sanitize, RESET, BOLD, DIM,
} = require('../colors');
const { visibleWidth } = require('../layout');

// A real display name is 10-15 characters (D1) and an id is at most ~100. Anything longer is
// foreign junk, so it is cut BEFORE it reaches a regex.
const MAX_RAW_MODEL_LEN = 200;

// display_name is rendered as-is (see DECISIONS.md D1); only strip known noise.
// The context note has no leading \s*: an unanchored pattern that starts with \s* is quadratic
// on a long run of whitespace (100,000 spaces took 8 seconds). Whitespace is collapsed and
// trimmed afterwards instead, which also removes the space the note leaves behind.
function shortenModel(name) {
  return String(name)
    .slice(0, MAX_RAW_MODEL_LEN)
    .replace(/\(\s*\d+[km]?\s*context\s*\)/i, ' ')
    .replace(/^claude\s+/i, '')
    .replace(/\s+/g, ' ')
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
    // Both fields are foreign. Only a non-empty string is a name: an object would print as
    // "[object Object]" and a number or boolean as digits or "true".
    const asText = (v) => (typeof v === 'string' && v.trim() !== '' ? v : '');
    const displayName = asText(model.display_name);
    const modelId = asText(model.id);

    // Emptiness has to be judged AFTER cleaning, and by what is visible: "\x07" and "Claude "
    // clean to nothing, and a name of only combining marks is text that occupies no cell. Any of
    // them would otherwise print an empty colored segment.
    const clean = (v) => {
      const name = v ? capModel(shortenModel(sanitize(v))) : '';
      return visibleWidth(name) > 0 ? name : '';
    };
    const name = clean(displayName) || clean(modelId);
    if (!name) return null;

    const color = colorForModelEffort(modelId, displayName, input.effort && input.effort.level);

    // effort is absent for models without it (e.g. Haiku 4.5) — never default it.
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
