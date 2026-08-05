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
// emoji can't cut a surrogate pair in half.
function truncate(str, max) {
  const s = String(str);
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

// Observed as a bare id string; object form kept as a defensive fallback.
function modelIdOf(model) {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') return model.id || model.display_name || '';
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

  // No `name` field on this payload; `type` is always "local_agent", never useful
  // for display. label/description come from model output, hence sanitize.
  const name = sanitize(task.label || task.description || 'agent') || 'agent';
  const status = String(task.status || 'running').toLowerCase();
  const arrow = STATUS_COLORS[status] || DIM;

  const nameBudget = columns > 40 ? Math.min(32, Math.floor(columns * 0.4)) : 24;
  const shownName = truncate(name, nameBudget);

  const modelId = modelIdOf(task.model);
  // effort is normally absent (subagents inherit session effort), and may be a
  // numeric token budget — normalizeEffortLevel returns null for both.
  const effort = normalizeEffortLevel(task.effort);

  let modelStr = '';
  if (modelId) {
    const color = colorForModelEffort(modelId, modelId, effort);
    modelStr = ` ${color}${shortModelLabel(modelId)}${RESET}`;
  }

  const tokens = formatTokens(Number(task.tokenCount));
  const tokenStr = tokens ? ` ${DIM}${tokens}${RESET}` : '';

  return `${arrow}↳ ${shownName}${RESET}${modelStr}${tokenStr}`;
}

function renderSubagentLine(input) {
  try {
    const tasks = input && Array.isArray(input.tasks) ? input.tasks : null;
    if (!tasks || !tasks.length) return '';

    // Width comes from the payload; COLUMNS is undefined in this invocation.
    const raw = Number(input.columns);
    const columns = Number.isFinite(raw) && raw > 0 ? raw : 0;

    return tasks
      .map((t) => {
        try { return renderTaskRow(t, columns); } catch { return null; }
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

module.exports = { renderSubagentLine, renderTaskRow };
