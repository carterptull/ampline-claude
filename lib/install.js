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
  /\/snap\/node\/\d+\//i,                  // snap: one directory per revision
];

function isVersionedNodePath(p) {
  const norm = String(p).replace(/\\/g, '/');
  return VERSIONED_NODE_DIRS.some((re) => re.test(norm));
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Pure apart from the injected lookups, so it can be tested for any platform. Returns
// { path, source: 'execPath' | 'path' | 'realpath' } or null when execPath is not a usable absolute file (the
// caller then falls back to a bare `node`).
function chooseNodePath({ execPath, pathEntries, platform = process.platform, realpath = fs.realpathSync, isFile = defaultIsFile }) {
  const plat = platform === 'win32' ? path.win32 : path.posix;
  if (typeof execPath !== 'string' || !plat.isAbsolute(execPath) || !isFile(execPath)) return null;
  const keep = { path: execPath, source: 'execPath' };
  if (!isVersionedNodePath(execPath)) return keep;

  const norm = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  let selfRaw;
  try { selfRaw = realpath(execPath); } catch { return keep; }
  const self = norm(selfRaw);
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
  // No stable PATH entry: the real file behind execPath, when that is not itself versioned.
  try {
    if (selfRaw !== execPath && !isVersionedNodePath(selfRaw) && plat.isAbsolute(selfRaw) && isFile(selfRaw)) {
      return { path: selfRaw, source: 'realpath' };
    }
  } catch {}
  return keep;
}

// { command, display, chosen }: command is what goes into settings.json, display what the install
// output shows, chosen is the chooser's answer (null for a bare `node`).
function resolveNodeCommand() {
  let chosen = null;
  try {
    const entries = String(process.env.PATH || '').split(path.delimiter).map((e) => e.replace(/^"(.*)"$/, '$1'));
    chosen = chooseNodePath({ execPath: process.execPath, pathEntries: entries });
  } catch {}
  if (!chosen) return { command: 'node', display: 'node (looked up on PATH each time Claude Code runs it)', chosen: null };
  const shown = chosen.path.replace(/\\/g, '/');
  return { command: `"${shown}"`, display: shown, chosen };
}

// The success output of an install, as lines for console.log. The first six lines of a normal
// install, with no foreign entry and no existing settings.json, are exactly what v0.6.0 printed,
// because the website embeds them verbatim. The Node and upgrade-note lines are added only when
// the choice is worth a user's attention: a bare `node` fallback, or a Node that lives in a
// versioned directory (whether a stable PATH entry, the real file behind a symlink, or the
// versioned path itself was written). execPath is necessarily versioned when a PATH entry or a
// real file was preferred over it, so one test covers all three.
function installMessages({ chosen, display, execPath, saved, foreignStatus, foreignSubagent }) {
  const notable = !chosen || isVersionedNodePath(execPath);
  const lines = [];
  if (foreignStatus) lines.push(`ampline-claude: replacing an existing statusLine command:\n  ${foreignStatus}`);
  if (foreignSubagent) lines.push(`ampline-claude: replacing an existing subagentStatusLine command:\n  ${foreignSubagent}`);
  lines.push('✓ ampline-claude installed.');
  if (notable) {
    lines.push(`  Node: ${display}`);
    lines.push('  Note: re-run `npx ampline-claude --install` after upgrading Node.');
  }
  if (saved) lines.push(`  Previous settings backed up to ${saved}`);
  lines.push('\nRestart Claude Code or start a new session.\n');
  lines.push('Customize with ~/.amplinerc.json or a project .amplinerc.json:');
  lines.push('https://github.com/carterptull/ampline-claude#configuration');
  return lines;
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
// else that merely starts with "settings.json.backup." is the user's and is never touched.
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
// copy fails: a caller that carried on would rewrite the file with no way back.
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
// A directory is removed only when it is both older than a minute and named for a process that no
// longer exists, so another install that is still running is never disturbed. Returns how many
// directories were removed.
const STAGING_NAME = /^ampline-claude\.(?:new|old)-(\d+)$/;
const STAGING_MAX_AGE_MS = 60 * 1000;
// ESRCH means no such process. EPERM means it exists but belongs to someone else, so it is alive.
// Anything else is treated as alive too: leaving a directory is the safe mistake.
function pidIsGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (err) { return !!(err && err.code === 'ESRCH'); }
}
function cleanStaleStaging(now = Date.now()) {
  const dir = path.dirname(INSTALL_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const m = STAGING_NAME.exec(name);
    if (!m || !pidIsGone(Number(m[1]))) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < STAGING_MAX_AGE_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
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

// True for the commands this installer writes: a node interpreter (bare, or an absolute path whose
// file name is one a Node install uses, see NODE_NAME) running
// <config dir>/hooks/ampline-claude/bin/ampline-claude.js, with or without --subagent. A command
// that merely contains the name, such as a user's ampline-claude-wrap.sh, is the user's own.
const OUR_COMMAND = /^("[^"]+"|[^\s"]+)\s+"[^"]*\/hooks\/ampline-claude\/bin\/ampline-claude\.js"(?:\s+--subagent)?$/;
// The interpreter names this installer can write: node, node.exe, nodejs (Debian and Ubuntu), and
// versioned binaries such as node24 or node-24.1, each with an optional .exe. The quoted installed
// entry that follows is the real signal; this only keeps a user's own wrapper (node-wrapper.sh)
// from counting as ours.
const NODE_NAME = /^node(?:js)?(?:[-_.]?v?\d[\w.-]*)?(?:\.exe)?$/i;
function pointsAtUs(entry) {
  if (!entry || typeof entry.command !== 'string') return false;
  const m = OUR_COMMAND.exec(entry.command.replace(/\\/g, '/').trim());
  if (!m) return false;
  const exe = m[1].replace(/^"|"$/g, '').split('/').pop();
  // The file name of the Node running this process is accepted too: it is what install writes
  // when no better path is found, whatever the file is called.
  return NODE_NAME.test(exe) || exe.toLowerCase() === path.basename(process.execPath).toLowerCase();
}

// The text shown for a foreign entry, or null when the entry is ours or absent.
function foreignText(entry) {
  if (!entry || pointsAtUs(entry)) return null;
  return typeof entry.command === 'string' ? entry.command : JSON.stringify(entry);
}

// Whether an entry that is not ours still refers to ampline-claude (a wrapper script around the
// installed copy, say). Uninstall keeps the runtime for as long as one remains.
function mentionsAmpline(entry) {
  if (!entry || pointsAtUs(entry)) return false;
  try { return /ampline-claude/i.test(typeof entry.command === 'string' ? entry.command : JSON.stringify(entry)); }
  catch { return false; }
}

// True when anything was there to remove, including leftover staging directories of ours.
function removeRuntimeAndCache() {
  const had = fs.existsSync(INSTALL_DIR) || fs.existsSync(CACHE_DIR);
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  return cleanStaleStaging() > 0 || had;
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
  // A remaining entry that is not ours but still names ampline-claude may call the installed
  // copy, so the runtime and cache stay for it, exactly as when nothing of ours was found.
  const stillUsed = ['statusLine', 'subagentStatusLine'].find((key) => mentionsAmpline(settings[key]));
  if (!stillUsed) removeRuntimeAndCache();

  console.log(
    'ampline-claude removed.' + (saved ? ` Backup: ${path.basename(saved)}` : '') +
    (stillUsed ? `\n  Kept the runtime copy: ${stillUsed} is not ampline's own command but still names ampline-claude.` : '')
  );
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

  const foreignStatus = foreignText(first.settings.statusLine);
  const foreignSubagent = foreignText(first.settings.subagentStatusLine);

  // The backup comes before anything is changed on disk, so a failed one leaves the runtime copy
  // exactly as it was as well as settings.json.
  let saved = first.existed ? backupOrReport() : null;
  if (saved === false) return;

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
  // settings.json too, and anything it wrote since the first read is carried over. (The backup
  // above is of the first read; a write that lands in between is kept but not in the backup.)
  const fresh = readSettings();
  if (fresh.settings === null) { reportUnparseable(fresh.error); return; }
  const settings = fresh.settings;
  if (saved === null && fresh.existed) {
    saved = backupOrReport(); // the file appeared after the first read
    if (saved === false) return;
  }

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

  for (const line of installMessages({
    chosen: node.chosen, display: node.display, execPath: process.execPath,
    saved: saved ? path.basename(saved) : null, foreignStatus, foreignSubagent,
  })) console.log(line);
}

module.exports = {
  runInstaller, readSettings, chooseNodePath, isVersionedNodePath, installMessages, pointsAtUs, isBackupName,
  cleanStaleStaging, INSTALL_DIR, CACHE_DIR, ENTRY,
};
