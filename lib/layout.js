'use strict';
const { stripAnsi } = require('./colors');

const SEGMENT_SEP = ' │ ';
// Non-zero on purpose: terminal width reporting isn't exact and Claude Code
// applies its own padding.
const WIDTH_MARGIN = 2;

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
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  );
}

function visibleWidth(str) {
  let width = 0;
  for (const ch of stripAnsi(str)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // ZWJ / variation selectors
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
  const cols = Number.parseInt(process.env.COLUMNS, 10);
  if (Number.isFinite(cols) && cols > 0 && visibleWidth(single) > cols - WIDTH_MARGIN) {
    return a.join(sep) + '\n' + b.join(sep);
  }
  return single;
}

module.exports = { layout, visibleWidth, SEGMENT_SEP, WIDTH_MARGIN };
