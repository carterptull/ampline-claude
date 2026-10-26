'use strict';
const fs = require('fs');

// Files ampline reads from a checkout it does not control (.amplinerc.json, .git, HEAD) are
// attacker-shaped: a repo can commit a symlink to /dev/zero or /dev/tty, and an extracted
// archive can ship a FIFO. Reading one blocks or never ends, so only a small regular file is
// ever opened. statSync follows symlinks, so a link to a device reports itself as a device.
const MAX_SMALL_FILE_BYTES = 64 * 1024;

// Returns the file's text, or null when the path is missing, not a regular file, larger than
// the limit, or unreadable. Never throws, so callers treat null as "no such file".
function readSmallTextFile(p, maxBytes = MAX_SMALL_FILE_BYTES) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

module.exports = { readSmallTextFile, MAX_SMALL_FILE_BYTES };
