'use strict';
const fs = require('fs');

// Files ampline reads from a checkout it does not control (.amplinerc.json, .git, HEAD) are
// attacker-shaped: a repo can commit a symlink to /dev/zero or /dev/tty, and an extracted
// archive can ship a FIFO. Reading one blocks or never ends, so only a small regular file is
// ever read. statSync follows symlinks, so a link to a device reports itself as a device.
const MAX_SMALL_FILE_BYTES = 64 * 1024;

// Returns the file's text, or null when the path is missing, not a regular file, larger than
// the limit, or unreadable. Never throws, so callers treat null as "no such file".
//
// A cheap statSync rejects the obvious cases before anything is opened (opening a FIFO for
// reading can block). The checks are then repeated on the open descriptor, so the file that is
// read is the file that was checked, and at most `maxBytes` are ever read from it.
function readSmallTextFile(p, maxBytes = MAX_SMALL_FILE_BYTES) {
  let fd = null;
  try {
    const pre = fs.statSync(p);
    if (!pre.isFile() || pre.size > maxBytes) return null;
    // O_NONBLOCK: if the path is swapped for a FIFO between the check above and this open, the open
    // returns at once instead of waiting for a writer (the descriptor check below then rejects it).
    // The constant is absent on Windows, where there is nothing to guard against.
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    // A file that grew after the descriptor was checked is treated as changed, not half-read.
    if (total > stat.size) return null;
    return buf.toString('utf8', 0, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = { readSmallTextFile, MAX_SMALL_FILE_BYTES };
