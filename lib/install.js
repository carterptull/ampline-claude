'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const INSTALL_DIR = path.join(CLAUDE_DIR, 'hooks', 'ampline-claude');
const CACHE_DIR = path.join(CLAUDE_DIR, 'cache', 'ampline');
const PACKAGE_ROOT = path.join(__dirname, '..');
const MAX_BACKUPS = 5;

// Forward slashes: valid on Windows, avoids escaping backslashes in JSON, and
// avoids `~` which cmd.exe does not expand.
const ENTRY = path.join(INSTALL_DIR, 'bin', 'ampline-claude.js').replace(/\\/g, '/');

// A null `settings` means "exists but unusable" and MUST abort the install —
// starting from {} here would overwrite every hook and MCP server the user has.
function readSettings() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { settings: {}, existed: false, error: null };
    return { settings: null, existed: true, error: err };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: null, existed: true, error: new Error('settings.json is not a JSON object') };
    }
    return { settings: parsed, existed: true, error: null };
  } catch (err) {
    return { settings: null, existed: true, error: err };
  }
}

function writeSettings(settings) {
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function pruneBackups() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    const base = path.basename(SETTINGS_PATH);
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.backup.`))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const extra of backups.slice(MAX_BACKUPS)) {
      try { fs.rmSync(path.join(dir, extra.f), { force: true }); } catch {}
    }
  } catch {}
}

// Call only after deciding to modify something, so a refused uninstall leaves
// no stray backup behind.
function backup() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${SETTINGS_PATH}.backup.${stamp}`;
    fs.copyFileSync(SETTINGS_PATH, target);
    pruneBackups();
    return target;
  } catch {
    return null;
  }
}

// Stage into a sibling dir, then swap. Never removes the live install before
// the replacement exists, and refuses to run from inside it (EBUSY on Windows).
function copyRuntime() {
  if (path.resolve(PACKAGE_ROOT) === path.resolve(INSTALL_DIR)) {
    throw new Error(
      'Refusing to reinstall from the installed copy. Run `npx ampline-claude@latest` instead.'
    );
  }

  const staging = `${INSTALL_DIR}.new-${process.pid}`;
  const retired = `${INSTALL_DIR}.old-${process.pid}`;

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const dir of ['bin', 'lib']) {
    fs.cpSync(path.join(PACKAGE_ROOT, dir), path.join(staging, dir), { recursive: true });
  }

  fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  let hadPrevious = false;
  try {
    if (fs.existsSync(INSTALL_DIR)) { fs.renameSync(INSTALL_DIR, retired); hadPrevious = true; }
  } catch {}

  try {
    fs.renameSync(staging, INSTALL_DIR);
  } catch (err) {
    // Roll the previous install back rather than leaving nothing in place.
    if (hadPrevious) { try { fs.renameSync(retired, INSTALL_DIR); } catch {} }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw err;
  }

  if (hadPrevious) { try { fs.rmSync(retired, { recursive: true, force: true }); } catch {} }
}

function pointsAtUs(entry) {
  return !!(entry && typeof entry.command === 'string' && entry.command.includes('ampline-claude'));
}

function runInstaller(options) {
  const { uninstall = false } = options || {};
  const { settings, existed, error } = readSettings();

  if (settings === null) {
    console.error(
      `ampline-claude: ${SETTINGS_PATH} exists but could not be parsed.\n` +
      `  ${error && error.message}\n` +
      `  Refusing to overwrite it. Fix the file (or move it aside) and re-run.`
    );
    process.exitCode = 1;
    return;
  }

  if (uninstall) {
    const ours =
      pointsAtUs(settings.statusLine) || pointsAtUs(settings.subagentStatusLine);
    const foreign =
      (settings.statusLine && !pointsAtUs(settings.statusLine)) ||
      (settings.subagentStatusLine && !pointsAtUs(settings.subagentStatusLine));

    if (!ours) {
      console.log(
        foreign
          ? 'ampline-claude: settings.json points at a different statusline — left untouched.'
          : 'ampline-claude: no statusline entries found — nothing to remove.'
      );
      return;
    }

    const saved = backup();
    if (pointsAtUs(settings.statusLine)) delete settings.statusLine;
    if (pointsAtUs(settings.subagentStatusLine)) delete settings.subagentStatusLine;

    try { writeSettings(settings); }
    catch (err) {
      console.error(`ampline-claude: could not write ${SETTINGS_PATH}\n  ${err.message}`);
      process.exitCode = 1;
      return;
    }
    try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}

    console.log('ampline-claude removed.' + (saved ? ` Backup: ${path.basename(saved)}` : ''));
    return;
  }

  if (settings.statusLine && !pointsAtUs(settings.statusLine)) {
    console.log(
      `ampline-claude: replacing an existing statusLine command:\n  ${settings.statusLine.command}`
    );
  }

  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    copyRuntime();
  } catch (err) {
    console.error(`ampline-claude: could not install to ${INSTALL_DIR}\n  ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const saved = existed ? backup() : null;
  const cmd = `node "${ENTRY}"`;

  settings.statusLine = {
    type: 'command',
    command: cmd,
    padding: 0,
    // Event-driven updates go quiet while idle; the reset countdown and git
    // state both need a timer to stay honest.
    refreshInterval: 30,
  };
  settings.subagentStatusLine = { type: 'command', command: `${cmd} --subagent` };

  try { writeSettings(settings); }
  catch (err) {
    console.error(`ampline-claude: could not write ${SETTINGS_PATH}\n  ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('✓ ampline-claude installed.');
  if (saved) console.log(`  Previous settings backed up to ${path.basename(saved)}`);
  console.log('\nRestart Claude Code or start a new session.\n');
  console.log('Customize with ~/.amplinerc.json or a project .amplinerc.json:');
  console.log('https://github.com/carterptull/ampline-claude#configuration');
}

module.exports = { runInstaller, readSettings, INSTALL_DIR, CACHE_DIR, ENTRY };
