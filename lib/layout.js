'use strict';
const { stripAnsi } = require('./colors');

const SEGMENT_SEP = ' │ ';
// Non-zero on purpose: terminal width reporting isn't exact and Claude Code
// applies its own padding.
const WIDTH_MARGIN = 2;
// COLUMNS may be unset on bash/zsh (a shell var, not always exported) —
// fall back to a sane guess rather than never wrapping.
const DEFAULT_COLUMNS = 120;

// Minimal East-Asian Wide/Fullwidth + emoji ranges — not full UAX #11, just
// what a statusline realistically hits, to stay dependency-free.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    // Transport and map symbols (the rocket lives here). A few code points in the block are
    // narrow, and over-counting only makes the line wrap earlier, which is the safe direction.
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff)
  );
}

// Code points that occupy no terminal cell: combining marks, joiners and variation selectors,
// zero-width and format characters, and tag characters. Counting them as one cell each made
// the line wrap when it did not need to.
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], // combining marks
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], // variation selectors, combining half marks
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], // zero-width and format
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef], // tag characters, variation selectors supplement
];
function isZeroWidth(cp) {
  for (const [lo, hi] of ZERO_WIDTH_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function visibleWidth(str) {
  let width = 0;
  for (const ch of stripAnsi(str)) {
    const cp = ch.codePointAt(0);
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function layout(line1Parts, line2Parts, separator) {
  const sep = typeof separator === 'string' ? separator : SEGMENT_SEP;
  const a = (Array.isArray(line1Parts) ? line1Parts : []).filter(Boolean);
  const b = (Array.isArray(line2Parts) ? line2Parts : []).filter(Boolean);

  if (!a.length && !b.length) return '';
  if (!b.length) return a.join(sep);
  if (!a.length) return b.join(sep);

  const single = [...a, ...b].join(sep);
  const parsed = Number.parseInt(process.env.COLUMNS, 10);
  const cols = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COLUMNS;
  if (visibleWidth(single) > cols - WIDTH_MARGIN) {
    return a.join(sep) + '\n' + b.join(sep);
  }
  return single;
}

module.exports = { layout, visibleWidth, SEGMENT_SEP, WIDTH_MARGIN, DEFAULT_COLUMNS };
