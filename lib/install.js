'use strict';
const fs = require('fs');
const path = require('path');
const { claudeDir } = require('./claudeDir');

const CLAUDE_DIR = claudeDir();
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const INSTALL_DIR = path.join(CLAUDE_DIR, 'hooks', 'ampline-claude');
const CACHE_DIR = path.join(CLAUDE_DIR, 'cache', 'ampline');
const PACKAGE_ROOT = path.join(__dirname, '..');
const MAX_BACKUPS = 5;

// Forward slashes: valid on Windows, avoids escaping backslashes in JSON, and
// avoids `~` which cmd.exe does not expand.
const ENTRY = path.join(INSTALL_DIR, 'bin', 'ampline-claude.js').replace(/\\/g, '/');

// A bare `node` relies on inherited PATH, which a GUI-launched app on macOS/Linux with a
// version-managed Node may not have, so the absolute path to the Node running this installer is
// written instead (D27). That path can itself be the problem: Homebrew's Cellar directory and the
// version directories of nvm, fnm, volta, asdf, nodenv and mise hold ONE version, and the
// directory goes away on an upgrade or cleanup, which blanks the statusline with no diagnostic.
// When a stable PATH entry (for example `/opt/homebrew/bin/node`) resolves to the very same
// binary, that entry is written instead (D44).
const VERSIONED_NODE_DIRS = [
  /\/Cellar\//i,                           // Homebrew
  /\/\.?nvm\/versions\//i,                 // nvm
  /\/\.?nvm\/v\d+\./i,                     // nvm-windows
  /\/\.?fnm\/node-versions\//i,            // fnm
  /\/fnm_multishells\//i,                  // fnm's per-shell symlinks: gone after a reboot
  /\/\.?volta\/tools\/image\/node\//i,     // volta
  /\/\.?asdf\/installs\/nodejs\//i,        // asdf
  /\/\.?nodenv\/versions\//i,              // nodenv
  /\/mise\/installs\/node\//i,             // mise
];

function isVersionedNodePath(p) {
  const norm = String(p).replace(/\\/g, '/');
  return VERSIONED_NODE_DIRS.some((re) => re.test(norm));
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Pure apart from the injected lookups, so it can be tested for any platform. Returns
// { path, source: 'execPath' | 'path' } or null when execPath is not a usable absolute file (the
// caller then falls back to a bare `node`).
function chooseNodePath({ execPath, pathEntries, platform = process.platform, realpath = fs.realpathSync, isFile = defaultIsFile }) {
  const plat = platform === 'win32' ? path.win32 : path.posix;
  if (typeof execPath !== 'string' || !plat.isAbsolute(execPath) || !isFile(execPath)) return null;
  const keep = { path: execPath, source: 'execPath' };
  if (!isVersionedNodePath(execPath)) return keep;

  const norm = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  let self;
  try { self = norm(realpath(execPath)); } catch { return keep; }
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of Array.isArray(pathEntries) ? pathEntries : []) {
    if (typeof dir !== 'string' || !dir || !plat.isAbsolute(dir)) continue;
    const candidate = plat.join(dir, exe);
    // A PATH entry inside a version directory is no more durable than execPath itself.
    if (isVersionedNodePath(candidate)) continue;
    try {
      if (isFile(candidate) && norm(realpath(candidate)) === self) return { path: candidate, source: 'path' };
    } catch {}
  }
  return keep;
}

function resolveNodeCommand() {
  let chosen = null;
  try {
    const entries = String(process.env.PATH || '').split(path.delimiter).map((e) => e.replace(/^"(.*)"$/, '$1'));
    chosen = chooseNodePath({ execPath: process.execPath, pathEntries: entries });
  } catch {}
  if (!chosen) return { command: 'node', display: 'node (looked up on PATH each time Claude Code runs it)' };
  const shown = chosen.path.replace(/\\/g, '/');
  return { command: `"${shown}"`, display: shown };
}

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
  // Write through a symlink (dotfiles managers commonly use one) instead of
  // replacing it. ENOENT means a fresh install with no existing file.
  let target = SETTINGS_PATH;
  try { target = fs.realpathSync(SETTINGS_PATH); } catch {}

  // Preserve the original file's permissions (e.g. a deliberate chmod 600,
  // since this file can hold API keys) across the atomic rename.
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch {}

  const tmp = `${target}.${process.pid}.tmp`;
  try {
    // A leftover or planted file at this name is removed, never written through ('wx' below
    // refuses to open an existing path).
    fs.rmSync(tmp, { force: true });
    // Created with the target's mode so the contents are never readable by more people than they
    // were before, not even for an instant. The chmod then restores any bits the umask masked.
    const opts = { encoding: 'utf8', flag: 'wx' };
    if (mode != null) opts.mode = mode;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', opts);
    if (mode != null) {
      try { fs.chmodSync(tmp, mode); } catch {}
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

// Exactly the name backup() writes: settings.json.backup.<ISO time, with : and . as ->. Anything
// else that merely starts with "settings.json.backup." is the user's and is never touched (S4).
const BACKUP_NAME = /^settings\.json\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
function isBackupName(name) {
  return typeof name === 'string' && BACKUP_NAME.test(name);
}

function pruneBackups() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    // The stamp sorts chronologically, so the newest MAX_BACKUPS are the last ones by name.
    const backups = fs.readdirSync(dir)
      .filter(isBackupName)
      .filter((f) => { try { return fs.lstatSync(path.join(dir, f)).isFile(); } catch { return false; } })
      .sort()
      .reverse();
    for (const extra of backups.slice(MAX_BACKUPS)) {
      try { fs.rmSync(path.join(dir, extra), { force: true }); } catch {}
    }
  } catch {}
}

// Returns the backup's path, or null when there is no settings file to back up. THROWS when the
// copy fails: a caller that carried on would rewrite the file with no way back (S4).
// Call only after deciding to modify something, so a refused uninstall leaves no stray backup.
function backup() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${SETTINGS_PATH}.backup.${stamp}`;
  fs.copyFileSync(SETTINGS_PATH, target);
  pruneBackups();
  return target;
}

// The backup's path, null when there was nothing to back up, or false after reporting a failure
// (the caller must stop and leave settings.json alone).
function backupOrReport() {
  try {
    return backup();
  } catch (err) {
    console.error(
      `ampline-claude: could not back up ${SETTINGS_PATH}\n` +
      `  ${err && err.message}\n` +
      '  Refusing to modify it without a backup. Fix the problem (permissions, free space) and re-run.'
    );
    process.exitCode = 1;
    return false;
  }
}

function reportUnparseable(error) {
  console.error(
    `ampline-claude: ${SETTINGS_PATH} exists but could not be parsed.\n` +
    `  ${error && error.message}\n` +
    '  Refusing to overwrite it. Fix the file (or move it aside) and re-run.'
  );
  process.exitCode = 1;
}

// A crash between staging and the swap leaves ampline-claude.new-<pid> or .old-<pid> behind.
// Anything not touched for a minute belongs to a run that is no longer going.
const STAGING_NAME = /^ampline-claude\.(?:new|old)-\d+$/;
const STAGING_MAX_AGE_MS = 60 * 1000;
function cleanStaleStaging(now = Date.now()) {
  const dir = path.dirname(INSTALL_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!STAGING_NAME.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < STAGING_MAX_AGE_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

// Stage into a sibling dir, then swap. Never removes the live install before
// the replacement exists, and refuses to run from inside it (EBUSY on Windows).
function copyRuntime() {
  if (path.resolve(PACKAGE_ROOT) === path.resolve(INSTALL_DIR)) {
    throw new Error(
      'Refusing to reinstall from the installed copy. Run `npx ampline-claude@latest --install` instead.'
    );
  }

  const staging = `${INSTALL_DIR}.new-${process.pid}`;
  const retired = `${INSTALL_DIR}.old-${process.pid}`;

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const dir of ['bin', 'lib']) {
    fs.cpSync(path.join(PACKAGE_ROOT, dir), path.join(staging, dir), { recursive: true });
  }
  // bin/ampline-claude.js reads ../package.json for --version. Without this,
  // every installed copy reports "unknown" instead of a real version.
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(staging, 'package.json'));

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

// True only for the commands this installer writes: a node (bare, or an absolute path) running
// <config dir>/hooks/ampline-claude/bin/ampline-claude.js, with or without --subagent. A command
// that merely contains the name, such as a user's ampline-claude-wrap.sh, is the user's own (S4).
const OUR_COMMAND = /^("[^"]+"|[^\s"]+)\s+"[^"]*\/hooks\/ampline-claude\/bin\/ampline-claude\.js"(?:\s+--subagent)?$/;
function pointsAtUs(entry) {
  if (!entry || typeof entry.command !== 'string') return false;
  const m = OUR_COMMAND.exec(entry.command.replace(/\\/g, '/').trim());
  if (!m) return false;
  const exe = m[1].replace(/^"|"$/g, '').split('/').pop();
  return /^node(?:\.exe)?$/i.test(exe);
}

function noticeIfForeign(key, entry) {
  if (entry && !pointsAtUs(entry)) {
    const shown = typeof entry.command === 'string' ? entry.command : JSON.stringify(entry);
    console.log(`ampline-claude: replacing an existing ${key} command:\n  ${shown}`);
  }
}

function removeRuntimeAndCache() {
  const had = fs.existsSync(INSTALL_DIR) || fs.existsSync(CACHE_DIR);
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  return had;
}

function runUninstall(initial) {
  const ours = pointsAtUs(initial.statusLine) || pointsAtUs(initial.subagentStatusLine);
  const foreign =
    (initial.statusLine && !pointsAtUs(initial.statusLine)) ||
    (initial.subagentStatusLine && !pointsAtUs(initial.subagentStatusLine));

  if (!ours) {
    // A different statusline may call the installed copy, so it stays.
    if (foreign) {
      console.log('ampline-claude: settings.json points at a different statusline — left untouched.');
      return;
    }
    // Nothing in settings.json refers to us (removed by hand, or no file at all), but the runtime
    // and cache can still be there.
    console.log(
      removeRuntimeAndCache()
        ? 'ampline-claude: settings.json has no ampline entries; removed the runtime copy and cache.'
        : 'ampline-claude: no statusline entries found — nothing to remove.'
    );
    return;
  }

  // Read again just before writing, so a change Claude Code made since the first read is kept.
  const fresh = readSettings();
  if (fresh.settings === null) { reportUnparseable(fresh.error); return; }
  const settings = fresh.settings;
  let saved = null;
  const mine = ['statusLine', 'subagentStatusLine'].filter((key) => pointsAtUs(settings[key]));
  if (mine.length) {
    saved = backupOrReport();
    if (saved === false) return;
    for (const key of mine) delete settings[key];
    try { writeSettings(settings); }
    catch (err) {
      console.error(`ampline-claude: could not write ${SETTINGS_PATH}\n  ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  removeRuntimeAndCache();

  console.log('ampline-claude removed.' + (saved ? ` Backup: ${path.basename(saved)}` : ''));
}

function runInstaller(options) {
  const { uninstall = false } = options || {};
  const first = readSettings();

  if (first.settings === null) {
    reportUnparseable(first.error);
    return;
  }

  if (uninstall) {
    runUninstall(first.settings);
    return;
  }

  noticeIfForeign('statusLine', first.settings.statusLine);
  noticeIfForeign('subagentStatusLine', first.settings.subagentStatusLine);

  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    cleanStaleStaging();
    copyRuntime();
  } catch (err) {
    console.error(`ampline-claude: could not install to ${INSTALL_DIR}\n  ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Read the file again right before writing and merge into that copy: Claude Code writes
  // settings.json too, and anything it wrote since the first read must survive.
  const fresh = readSettings();
  if (fresh.settings === null) { reportUnparseable(fresh.error); return; }
  const settings = fresh.settings;

  const saved = fresh.existed ? backupOrReport() : null;
  if (saved === false) return;

  const node = resolveNodeCommand();
  const cmd = `${node.command} "${ENTRY}"`;

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
  console.log(`  Node: ${node.display}`);
  console.log('  Note: re-run `npx ampline-claude --install` after upgrading Node.');
  if (saved) console.log(`  Previous settings backed up to ${path.basename(saved)}`);
  console.log('\nRestart Claude Code or start a new session.\n');
  console.log('Customize with ~/.amplinerc.json or a project .amplinerc.json:');
  console.log('https://github.com/carterptull/ampline-claude#configuration');
}

module.exports = {
  runInstaller, readSettings, chooseNodePath, isVersionedNodePath, pointsAtUs, isBackupName,
  INSTALL_DIR, CACHE_DIR, ENTRY,
};
