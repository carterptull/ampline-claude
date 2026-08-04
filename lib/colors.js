'use strict';

// NO_COLOR (https://no-color.org), evaluated once so every helper below can
// return '' when disabled instead of every call site branching on it.
const COLOR_ON = !(process.env.NO_COLOR && process.env.NO_COLOR !== '');

function fg(r, g, b) {
  return COLOR_ON ? `\x1b[38;2;${r};${g};${b}m` : '';
}

const RESET = COLOR_ON ? '\x1b[0m' : '';
const BOLD  = COLOR_ON ? '\x1b[1m' : '';
const DIM   = COLOR_ON ? '\x1b[2m' : '';

function colorsEnabled() { return COLOR_ON; }

// OSC (hyperlink) sequences are also stripped, not just SGR, since an
// unstripped OSC 8 link would corrupt width math.
const SGR_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(str) {
  return String(str == null ? '' : str).replace(OSC_RE, '').replace(SGR_RE, '');
}

// Strips control chars (incl. ESC) from foreign strings before they reach
// a segment, so untrusted text cannot smuggle a terminal escape onto stdout.
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
function sanitize(str) {
  return String(str == null ? '' : str).replace(CONTROL_RE, '');
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// Haiku has no gradient table (single-color family); handled as a special
// case in colorForModelEffort().
const HAIKU_COLOR = [125, 184, 232];
// Neutral grey outside the wheel's hue sweep — for an unrecognized family,
// not a guessed color.
const UNKNOWN_COLOR = [160, 160, 160];

const MODEL_GRADIENTS = {
  sonnet: {
    low:    [92, 232, 208],
    medium: [74, 201, 140],
    high:   [122, 204, 61],
    xhigh:  [196, 204, 61],
    max:    [232, 178, 61],
  },
  opus: {
    low:    [232, 150, 61],
    medium: [232, 118, 61],
    high:   [232, 90, 61],
    xhigh:  [232, 67, 61],
    max:    [216, 32, 61],
  },
  fable: {
    low:    [232, 140, 200],
    medium: [232, 92, 179],
    high:   [196, 61, 232],
    xhigh:  [179, 0, 216],
    max:    [128, 0, 192],
  },
};

// Exported for the README table generator and tests; not used at render time.
const WHEEL = [
  HAIKU_COLOR,
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.sonnet[l]),
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.opus[l]),
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.fable[l]),
];

// display_name format isn't guaranteed, so check id first and displayName as fallback.
function normalizeModelFamily(modelId, displayName) {
  const hay = `${modelId || ''} ${displayName || ''}`.toLowerCase();
  if (hay.includes('haiku')) return 'haiku';
  if (hay.includes('sonnet')) return 'sonnet';
  if (hay.includes('opus')) return 'opus';
  if (hay.includes('fable') || hay.includes('mythos')) return 'fable';
  return null;
}

// Never defaults — absent effort (e.g. Haiku) or a numeric token budget
// (subagent payload) must fall through to null, not a guessed level.
function normalizeEffortLevel(level) {
  if (level == null) return null;
  const lvl = String(level).toLowerCase().trim();
  return EFFORT_ORDER.includes(lvl) ? lvl : null;
}

// Defensive: steps down to the nearest defined level if a model lacks one
// (e.g. no `xhigh`). May never fire in practice.
function resolveGradientColor(family, level) {
  const table = MODEL_GRADIENTS[family];
  if (!table) return null;
  if (table[level]) return table[level];
  const idx = EFFORT_ORDER.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    if (table[EFFORT_ORDER[i]]) return table[EFFORT_ORDER[i]];
  }
  return table.high || null;
}

function colorForModelEffort(modelId, displayName, level) {
  const family = normalizeModelFamily(modelId, displayName);
  if (!family) return fg(...UNKNOWN_COLOR);
  if (family === 'haiku') return fg(...HAIKU_COLOR);

  const lvl = normalizeEffortLevel(level);
  // No effort info: fall back to `high`, Claude Code's default effort level.
  const rgb = resolveGradientColor(family, lvl || 'high') || UNKNOWN_COLOR;
  return fg(...rgb);
}

function dangerStyle(pct) {
  if (!Number.isFinite(pct)) return null; // NaN would otherwise fall through to the 95+ branch
  if (pct < 50) return { color: fg(96, 200, 120),  bold: false, warn: false };
  if (pct < 70) return { color: fg(245, 196, 61),  bold: false, warn: false };
  if (pct < 85) return { color: fg(239, 159, 39),  bold: false, warn: false };
  if (pct < 95) return { color: fg(232, 67, 61),   bold: true,  warn: false };
  return          { color: fg(163, 45, 45),   bold: true,  warn: true  };
}

module.exports = {
  fg, RESET, BOLD, DIM, colorsEnabled, stripAnsi, sanitize,
  EFFORT_ORDER, WHEEL,
  colorForModelEffort, dangerStyle,
  normalizeModelFamily, normalizeEffortLevel,
};
