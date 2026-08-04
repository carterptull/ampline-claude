'use strict';
const os = require('os');
const path = require('path');

// Claude Code honors CLAUDE_CONFIG_DIR for a redirected config location —
// hardcoding ~/.claude everywhere would write to a path it never reads.
function claudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
}

module.exports = { claudeDir };
