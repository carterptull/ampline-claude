'use strict';
const { DIM, RESET, fg, colorsEnabled } = require('../colors');

const REVIEW_COLORS = {
  approved: fg(96, 200, 120),
  pending: fg(245, 196, 61),
  changes_requested: fg(232, 67, 61),
  draft: DIM,
};

const ESC = '\x1b';
const BEL = '\x07';
const MAX_URL_LENGTH = 2048;
// Anything but printable ASCII: controls (ESC, BEL, newline), space, DEL, and
// all non-ASCII. A URL containing any of these never becomes a link.
const NOT_PRINTABLE_ASCII = /[^\x21-\x7e]/;

// pr.url comes from the payload, so it is a foreign string. It ends up inside an
// OSC 8 escape sequence, which makes it a live injection vector if a BEL or ESC
// can slip through. Returns the normalized href only for a plain https URL with
// no credentials, otherwise null (the label then renders without a link).
function safeLinkUrl(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_URL_LENGTH) return null;
  if (NOT_PRINTABLE_ASCII.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  // Emit the parsed form, not the raw string, and re-check it.
  const href = url.href;
  if (href.length > MAX_URL_LENGTH || NOT_PRINTABLE_ASCII.test(href)) return null;
  return href;
}

function renderPrSegment(ctx) {
  try {
    const pr = (ctx && ctx.input && ctx.input.pr) || null;
    if (!pr) return null;
    // Number(null) / Number('') / Number(false) / Number([]) all coerce to 0
    // and pass Number.isFinite — require a real positive PR number instead,
    // since GitHub/GitLab issue numbers start at 1.
    const number = Number(pr.number);
    if (!Number.isInteger(number) || number <= 0) return null;

    // review_state is independently absent even when pr is present. It is also
    // a foreign string, so look it up as an own property only: names like
    // "constructor" would otherwise resolve to Object.prototype members.
    const color = Object.hasOwn(REVIEW_COLORS, pr.review_state) ? REVIEW_COLORS[pr.review_state] : DIM;

    // Claude Code sets kind: "mr" for a GitLab merge request (absent for a
    // GitHub PR). Only the exact value picks GitLab's `!N` syntax; the string
    // itself is never printed.
    const label = `${pr.kind === 'mr' ? '!' : '#'}${number}`;

    // NO_COLOR means plain text, which includes no link escapes.
    const href = colorsEnabled() ? safeLinkUrl(pr.url) : null;
    const text = href ? `${ESC}]8;;${href}${BEL}${label}${ESC}]8;;${BEL}` : label;
    return `${color}${text}${RESET}`;
  } catch {
    return null;
  }
}

module.exports = { renderPrSegment, safeLinkUrl };
