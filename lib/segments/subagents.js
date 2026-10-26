'use strict';
const {
  DIM, RESET, fg, sanitize, colorForModelEffort, normalizeEffortLevel, normalizeModelFamily,
} = require('../colors');

const STATUS_COLORS = {
  running: fg(96, 200, 120),
  pending: fg(245, 196, 61),
  queued: fg(245, 196, 61),
  completed: DIM,
  failed: fg(232, 67, 61),
  error: fg(232, 67, 61),
};

// Array.from splits by code point, not UTF-16 unit, so truncating near an
// emoji can't cut a surrogate pair in half. The string is cut to max*4 code units BEFORE it is
// expanded: a code point is at most two units, so that always keeps more than max of them, and a
// huge label never becomes a huge array.
function truncate(str, max) {
  const s = String(str);
  const chars = Array.from(s.slice(0, max * 4));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

// A token count is a positive safe integer; a fraction, an exponent form or anything else is
// left out instead of printed. The `k` form rounds to one decimal, so the step to `M` is taken
// where that rounding would otherwise print "1000k" (999,950 and up).
function formatTokens(n) {
  if (!Number.isSafeInteger(n) || n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 999950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

// Observed as a bare id string; object form kept as a defensive fallback. Only strings count:
// an object here would print as "[object Object]".
function modelIdOf(model) {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    if (typeof model.id === 'string' && model.id) return model.id;
    if (typeof model.display_name === 'string') return model.display_name;
  }
  return '';
}

// First candidate that is a string and still has text after cleaning. A number, object or
// array is not a name, and a string of control characters or spaces is not one either.
function firstText(candidates) {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const cleaned = sanitize(c).trim();
    if (cleaned) return cleaned;
  }
  return '';
}

// Raw ids are long ("claude-haiku-4-5-20251001" survives an 18-char truncate
// whole), so collapse to the family label when recognized.
function shortModelLabel(modelId) {
  const family = normalizeModelFamily(modelId, '');
  if (family) return family;
  return truncate(String(modelId).replace(/^claude-/, ''), 18);
}

function renderTaskRow(task, columns) {
  if (!task || typeof task !== 'object') return null;

  // `type` is always "local_agent", never useful for display. Prefer the progress
  // label, then the description, then the optional `name` and `agentType` (both added
  // to the payload after D2 was written). All of these come from model output or from
  // agent definitions, hence sanitize.
  const name = firstText([task.label, task.description, task.name, task.agentType]) || 'agent';
  // status is a foreign string used as a lookup key: an own-property check keeps names that
  // exist on Object.prototype ("constructor", "__proto__") from resolving to a non-color (D38).
  // A non-string status is not a status at all.
  const status = (typeof task.status === 'string' && task.status ? task.status : 'running').toLowerCase();
  const arrow = Object.hasOwn(STATUS_COLORS, status) ? STATUS_COLORS[status] : DIM;

  const nameBudget = columns > 40 ? Math.min(32, Math.floor(columns * 0.4)) : 24;
  const shownName = truncate(name, nameBudget);

  // The model id is rendered as text and Claude Code shows `content` as-is, OSC 8 links
  // included, so it is a foreign string like the label and is sanitized the same way.
  const modelId = sanitize(modelIdOf(task.model));
  // effort is normally absent (subagents inherit session effort), and may be a
  // numeric token budget — normalizeEffortLevel returns null for both.
  const effort = normalizeEffortLevel(task.effort);

  let modelStr = '';
  if (modelId) {
    const color = colorForModelEffort(modelId, modelId, effort);
    modelStr = ` ${color}${shortModelLabel(modelId)}${RESET}`;
  }

  // Number() would read true as 1 and "5000" as 5k; a count must already be a number.
  const tokens = typeof task.tokenCount === 'number' ? formatTokens(task.tokenCount) : '';
  const tokenStr = tokens ? ` ${DIM}${tokens}${RESET}` : '';

  return `${arrow}↳ ${shownName}${RESET}${modelStr}${tokenStr}`;
}

// JSON.stringify leaves U+2028 and U+2029 raw, and some line readers treat them as line
// breaks. The id is echoed from the payload and never rendered, so it is the one field that
// is not sanitized; escape the two characters in the JSON text so a row is always one line.
// Built from char codes so no separator literal appears in this source file.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);
function jsonLine(obj) {
  return JSON.stringify(obj)
    .split(LINE_SEP).join(BACKSLASH + 'u2028')
    .split(PARA_SEP).join(BACKSLASH + 'u2029') + '\n';
}

// Claude Code's contract for subagentStatusLine output is one JSON line per row,
// {"id": "<task id>", "content": "<row body>"}, with the id echoed from the task. A row
// whose id is not echoed keeps the default rendering, so a task without a usable id is left
// out rather than printed as bare text that the parser would ignore. JSON.stringify keeps
// each row on one physical line and escapes control bytes, so a label cannot split a row.
// Every line ends in a newline so a line-based reader never holds the last row back.
function renderSubagentLine(input) {
  try {
    const tasks = input && Array.isArray(input.tasks) ? input.tasks : null;
    if (!tasks || !tasks.length) return '';

    // Width comes from the payload; COLUMNS is undefined in this invocation. It must already be
    // a positive integer number: Number() would read true as 1 and "500" as 500.
    const columns = Number.isSafeInteger(input.columns) && input.columns > 0 ? input.columns : 0;

    const lines = [];
    for (const t of tasks) {
      try {
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || t.id === '') continue;
        const content = renderTaskRow(t, columns);
        if (content) lines.push(jsonLine({ id: t.id, content }));
      } catch {
        // a row that cannot render keeps Claude Code's default rendering
      }
    }
    return lines.join('');
  } catch {
    return '';
  }
}

module.exports = { renderSubagentLine, renderTaskRow };
