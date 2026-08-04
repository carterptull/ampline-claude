'use strict';
const os = require('os');
const path = require('path');

// Claude Code itself honors CLAUDE_CONFIG_DIR for a redirected config
// location (roaming profiles, org-managed machines, multi-account setups).
// Hardcoding ~/.claude everywhere would let the installer report success
// while writing to a path Claude Code never actually reads.
function claudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
}

module.exports = { claudeDir };
