'use strict';

// NO_COLOR: any non-empty value disables color (https://no-color.org).
// Evaluated once at module load. When disabled, every helper returns an empty
// string, so call sites stay identical — no `if (color)` branching anywhere
// else in the codebase, and no risk of a segment forgetting the check.
const COLOR_ON = !(process.env.NO_COLOR && process.env.NO_COLOR !== '');

function fg(r, g, b) {
  return COLOR_ON ? `\x1b[38;2;${r};${g};${b}m` : '';
}

const RESET = COLOR_ON ? '\x1b[0m' : '';
const BOLD  = COLOR_ON ? '\x1b[1m' : '';
const DIM   = COLOR_ON ? '\x1b[2m' : '';

function colorsEnabled() { return COLOR_ON; }

// Matches SGR (\x1b[...m and friends) and OSC (\x1b]...BEL / ...ST).
// OSC matters because Claude Code supports OSC 8 hyperlinks and a user
// config could introduce one; an unstripped OSC would corrupt width math.
const SGR_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(str) {
  return String(str == null ? '' : str).replace(OSC_RE, '').replace(SGR_RE, '');
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

const HAIKU_COLOR = [125, 184, 232];
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

// The wheel as a flat ordered array. Not used at render time; exported for
// the README table generator and for tests that assert the sweep is intact.
const WHEEL = [
  HAIKU_COLOR,
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.sonnet[l]),
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.opus[l]),
  ...EFFORT_ORDER.map((l) => MODEL_GRADIENTS.fable[l]),
];

// model.id is the stable key ("claude-opus-5"); display_name may be as short
// as "Opus" and its format is not guaranteed. Check both, id first.
function normalizeModelFamily(modelId, displayName) {
  const hay = `${modelId || ''} ${displayName || ''}`.toLowerCase();
  if (hay.includes('haiku')) return 'haiku';
  if (hay.includes('sonnet')) return 'sonnet';
  if (hay.includes('opus')) return 'opus';
  if (hay.includes('fable') || hay.includes('mythos')) return 'fable';
  return null;
}

// Returns a level string or null. NEVER a default.
//
// The null return is load-bearing in two places: `effort` is absent entirely
// for models without effort support (defaulting there would mislabel every
// Haiku session), and `task.effort` on the subagent payload can be a NUMERIC
// token budget (defaulting there would paint a wrong wheel color with no
// error). String(4096) is not in EFFORT_ORDER, so numbers fall out here.
function normalizeEffortLevel(level) {
  if (level == null) return null;
  const lvl = String(level).toLowerCase().trim();
  return EFFORT_ORDER.includes(lvl) ? lvl : null;
}

// Older models may cap at `max` with no `xhigh`. Step down to the nearest
// defined level rather than failing. Per the field reference, effort is
// ABSENT rather than downgraded for unsupported models, so this path may
// never fire in practice — it is defensive only.
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
  // No effort information: use the family's `high` slot as its representative
  // hue. `high` is Claude Code's default effort, so this reads as "this model,
  // nothing unusual" rather than implying a level we weren't told.
  const rgb = resolveGradientColor(family, lvl || 'high') || UNKNOWN_COLOR;
  return fg(...rgb);
}

// Danger ramp for context + usage. Returns { color, bold, warn } or null.
// The explicit finite guard matters: with a NaN input every comparison below
// is false, so without it NaN falls through to the 95+ branch and renders a
// bold darkest-red warning for what is actually missing data.
function dangerStyle(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct < 50) return { color: fg(96, 200, 120),  bold: false, warn: false };
  if (pct < 70) return { color: fg(245, 196, 61),  bold: false, warn: false };
  if (pct < 85) return { color: fg(239, 159, 39),  bold: false, warn: false };
  if (pct < 95) return { color: fg(232, 67, 61),   bold: true,  warn: false };
  return          { color: fg(163, 45, 45),   bold: true,  warn: true  };
}

module.exports = {
  fg, RESET, BOLD, DIM, colorsEnabled, stripAnsi,
  EFFORT_ORDER, WHEEL,
  colorForModelEffort, dangerStyle,
  normalizeModelFamily, normalizeEffortLevel,
};
