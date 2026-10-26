'use strict';
// Installer, uninstaller and CLI help tests. lib/install.js is the one module that can destroy a
// user's configuration, so everything here runs the real binary inside a throwaway home
// (mkdtemp) with CLAUDE_CONFIG_DIR unset and the working directory inside that home. Nothing in
// this file reads or writes the developer's real home or ~/.claude. The two in-process tests
// point CLAUDE_CONFIG_DIR at a throwaway directory for the duration of the call.
//
// Called from test/run.js with its helpers, so failures count toward the same exit code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function runInstallerTests({ ROOT, BIN, makeTempHome, cleanEnv, fail }) {
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok    installer: ${name}`);
    else fail(`installer: ${name}`, detail);
  };
  const WIN = process.platform === 'win32';
  const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
  const fwd = (p) => p.replace(/\\/g, '/');

  // ---- harness ---------------------------------------------------------------------------

  // Runs the real binary in `home`. The environment is the developer's minus everything that
  // steers ampline, with HOME/USERPROFILE pointed at the throwaway directory.
  const run = (home, args, { env } = {}) => {
    const res = spawnSync(process.execPath, [BIN, ...args], {
      input: '', encoding: 'utf8', timeout: 20000, cwd: home,
      env: { ...cleanEnv(), HOME: home, USERPROFILE: home, COLUMNS: '120', ...(env || {}) },
    });
    return { status: res.status, out: res.stdout || '', err: res.stderr || '', error: res.error };
  };
  const withHome = (fn) => {
    const home = makeTempHome();
    try { return fn(home); }
    finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
  };
  const claude = (home) => path.join(home, '.claude');
  const settingsPath = (home) => path.join(claude(home), 'settings.json');
  const runtimeDir = (home) => path.join(claude(home), 'hooks', 'ampline-claude');
  const cacheDir = (home) => path.join(claude(home), 'cache', 'ampline');
  const writeSettings = (home, value) => fs.writeFileSync(
    settingsPath(home), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', 'utf8');
  const readSettings = (home) => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
  const backups = (home) => fs.readdirSync(claude(home)).filter((f) => f.startsWith('settings.json.backup.')).sort();
  const lines = (s) => s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const entry = (home) => `${fwd(runtimeDir(home))}/bin/ampline-claude.js`;
  const stamp = (n) => `2026-01-${String(n).padStart(2, '0')}T10-00-00-000Z`;

  // What a user's own settings might hold besides the statusline entries.
  const USER_SETTINGS = () => ({
    env: { SOME_KEY: 'value' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    mcpServers: { demo: { command: 'demo-server' } },
  });

  // ---- fresh install ---------------------------------------------------------------------

  withHome((home) => {
    fs.rmSync(claude(home), { recursive: true, force: true }); // no ~/.claude at all
    const r = run(home, ['--install']);
    check('a fresh install exits 0 and prints nothing on stderr', r.status === 0 && r.err === '', `status ${r.status}, stderr ${JSON.stringify(r.err)}`);

    const s = fs.existsSync(settingsPath(home)) ? readSettings(home) : null;
    check('a fresh install creates settings.json', !!s, 'settings.json is missing');
    const cmd = s && s.statusLine && s.statusLine.command;
    check('statusLine is a command entry that runs the installed copy',
      !!s && s.statusLine.type === 'command' && s.statusLine.padding === 0 && s.statusLine.refreshInterval === 30
        && typeof cmd === 'string' && cmd.endsWith(`"${entry(home)}"`),
      JSON.stringify(s && s.statusLine));
    check('subagentStatusLine is the same command plus --subagent',
      !!s && s.subagentStatusLine.type === 'command' && s.subagentStatusLine.command === `${cmd} --subagent`,
      JSON.stringify(s && s.subagentStatusLine));
    check('the command names the node that ran the installer (or a stable path to the same binary), quoted',
      typeof cmd === 'string' && /^"[^"]+" "/.test(cmd), String(cmd));

    for (const rel of ['bin/ampline-claude.js', 'lib/render.js', 'lib/install.js', 'package.json']) {
      check(`the runtime copy has ${rel}`, fs.existsSync(path.join(runtimeDir(home), rel)), 'missing');
    }
    check('no backup is written when there was no settings.json', !fs.existsSync(claude(home)) || backups(home).length === 0, JSON.stringify(backups(home)));

    const out = lines(r.out);
    const nodeLine = out[1] || '';
    const nodeInCmd = /^"([^"]+)"/.exec(cmd || '');
    check('the transcript is: installed, the node path chosen, the upgrade note, restart, customize',
      out[0] === '✓ ampline-claude installed.'
        && nodeInCmd && nodeLine === `  Node: ${nodeInCmd[1]}`
        && out[2] === '  Note: re-run `npx ampline-claude --install` after upgrading Node.'
        && out[3] === '' && out[4] === 'Restart Claude Code or start a new session.' && out[5] === ''
        && out[6] === 'Customize with ~/.amplinerc.json or a project .amplinerc.json:'
        && out[7] === 'https://github.com/carterptull/ampline-claude#configuration' && out.length === 8,
      JSON.stringify(out));

    // The installed copy really runs.
    const rendered = spawnSync(process.execPath, [path.join(runtimeDir(home), 'bin', 'ampline-claude.js'), '--version'], {
      encoding: 'utf8', cwd: home, env: { ...cleanEnv(), HOME: home, USERPROFILE: home },
    });
    check('the installed copy runs and reports the package version', rendered.status === 0 && rendered.stdout.trim() === PKG_VERSION, JSON.stringify(rendered.stdout));
  });

  // ---- second install: idempotent, backs up ---------------------------------------------

  withHome((home) => {
    writeSettings(home, USER_SETTINGS());
    const first = run(home, ['--install']);
    const afterFirst = fs.readFileSync(settingsPath(home), 'utf8');
    const firstBackups = backups(home);
    const second = run(home, ['--install']);
    const afterSecond = fs.readFileSync(settingsPath(home), 'utf8');
    check('both installs exit 0', first.status === 0 && second.status === 0, `${first.status}, ${second.status}`);
    check('the first install over an existing file backs it up', firstBackups.length === 1 && first.out.includes('Previous settings backed up to settings.json.backup.'), JSON.stringify(firstBackups));
    check('a second install leaves settings.json byte-identical', afterFirst === afterSecond, 'settings.json changed');
    check('a second install backs the previous file up again', backups(home).length === 2 && second.out.includes('Previous settings backed up to'), JSON.stringify(backups(home)));
    check('the backup holds the settings from before the install', (() => {
      const first0 = JSON.parse(fs.readFileSync(path.join(claude(home), firstBackups[0]), 'utf8'));
      return JSON.stringify(first0) === JSON.stringify(USER_SETTINGS());
    })(), 'backup differs from the original');
    const s = readSettings(home);
    check('install keeps the user\'s other settings (env, hooks, mcpServers)',
      JSON.stringify(s.env) === JSON.stringify(USER_SETTINGS().env)
        && JSON.stringify(s.hooks) === JSON.stringify(USER_SETTINGS().hooks)
        && JSON.stringify(s.mcpServers) === JSON.stringify(USER_SETTINGS().mcpServers),
      JSON.stringify(s));
    check('a second install leaves no staging directories behind',
      !fs.readdirSync(path.dirname(runtimeDir(home))).some((f) => /\.(new|old)-/.test(f)), JSON.stringify(fs.readdirSync(path.dirname(runtimeDir(home)))));
  });

  // ---- a foreign statusLine: today it is replaced, with a notice -------------------------

  withHome((home) => {
    writeSettings(home, { statusLine: { type: 'command', command: 'bash ~/my-statusline.sh' }, env: { A: '1' } });
    const r = run(home, ['--install']);
    const s = readSettings(home);
    check('installing over a foreign statusLine prints a notice naming the old command',
      r.status === 0 && r.out.includes('ampline-claude: replacing an existing statusLine command:') && r.out.includes('bash ~/my-statusline.sh'), JSON.stringify(r.out));
    check('installing over a foreign statusLine replaces it and backs the old file up',
      s.statusLine.command.includes('ampline-claude.js') && backups(home).length === 1
        && JSON.parse(fs.readFileSync(path.join(claude(home), backups(home)[0]), 'utf8')).statusLine.command === 'bash ~/my-statusline.sh',
      JSON.stringify(s.statusLine));
  });

  // A wrapper script whose name merely contains "ampline-claude" is foreign, not ours.
  withHome((home) => {
    const wrapper = '~/bin/ampline-claude-wrap.sh';
    writeSettings(home, { statusLine: { type: 'command', command: wrapper }, subagentStatusLine: { type: 'command', command: `${wrapper} --subagent` } });
    const r = run(home, ['--install']);
    check('a wrapper named ampline-claude-wrap.sh is announced before it is replaced',
      r.status === 0 && r.out.includes('replacing an existing statusLine command:') && r.out.includes(wrapper), JSON.stringify(r.out));
    check('a foreign subagentStatusLine is announced too',
      r.out.includes('replacing an existing subagentStatusLine command:') && r.out.includes(`${wrapper} --subagent`), JSON.stringify(r.out));
  });
  withHome((home) => {
    const before = { statusLine: { type: 'command', command: '~/bin/ampline-claude-wrap.sh' }, subagentStatusLine: { type: 'command', command: '~/bin/ampline-claude-wrap.sh --subagent' }, env: { A: '1' } };
    writeSettings(home, before);
    const bytes = fs.readFileSync(settingsPath(home), 'utf8');
    const r = run(home, ['uninstall']);
    check('uninstall leaves a wrapper script entry alone and says so',
      r.status === 0 && fs.readFileSync(settingsPath(home), 'utf8') === bytes && /different statusline/.test(r.out) && backups(home).length === 0, JSON.stringify(r.out));
  });

  // ---- unparseable settings.json ---------------------------------------------------------

  for (const [label, content] of [['invalid JSON', '{ "statusLine": '], ['a JSON array', '[1, 2, 3]'], ['JSON null', 'null']]) {
    withHome((home) => {
      writeSettings(home, content);
      const before = fs.readFileSync(settingsPath(home));
      const r = run(home, ['--install']);
      check(`an install over settings.json that is ${label} exits 1 and says why`,
        r.status === 1 && r.err.includes('exists but could not be parsed') && r.err.includes('Refusing to overwrite'), `status ${r.status}, stderr ${JSON.stringify(r.err)}`);
      check(`... and leaves the ${label} file byte-identical, with no backup and no runtime copy`,
        Buffer.compare(before, fs.readFileSync(settingsPath(home))) === 0 && backups(home).length === 0 && !fs.existsSync(runtimeDir(home)), 'something was written');
      const u = run(home, ['uninstall']);
      check(`an uninstall over settings.json that is ${label} also exits 1 and changes nothing`,
        u.status === 1 && Buffer.compare(before, fs.readFileSync(settingsPath(home))) === 0, `status ${u.status}`);
    });
  }

  // ---- symlink and mode ------------------------------------------------------------------

  withHome((home) => {
    const real = path.join(home, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify(USER_SETTINGS()) + '\n', 'utf8');
    let linked = true;
    try { fs.symlinkSync(real, settingsPath(home), 'file'); } catch { linked = false; }
    if (!linked) {
      check('a symlinked settings.json is written through (skipped: this account cannot create symlinks)', true);
      return;
    }
    const r = run(home, ['--install']);
    const stillLink = fs.lstatSync(settingsPath(home)).isSymbolicLink();
    const viaTarget = JSON.parse(fs.readFileSync(real, 'utf8'));
    check('a symlinked settings.json stays a symlink and the target receives the change',
      r.status === 0 && stillLink && !!viaTarget.statusLine && viaTarget.env.SOME_KEY === 'value', `status ${r.status}, link ${stillLink}`);
    const u = run(home, ['uninstall']);
    const afterUninstall = JSON.parse(fs.readFileSync(real, 'utf8'));
    check('uninstall writes through the symlink too',
      u.status === 0 && fs.lstatSync(settingsPath(home)).isSymbolicLink() && !afterUninstall.statusLine && afterUninstall.env.SOME_KEY === 'value', `status ${u.status}`);
  });

  if (WIN) {
    check('file mode is preserved across install (skipped on Windows: no POSIX permission bits)', true);
  } else {
    withHome((home) => {
      writeSettings(home, USER_SETTINGS());
      fs.chmodSync(settingsPath(home), 0o600);
      const r = run(home, ['--install']);
      check('install preserves a chmod 600 settings.json', r.status === 0 && (fs.statSync(settingsPath(home)).mode & 0o777) === 0o600, (fs.statSync(settingsPath(home)).mode & 0o777).toString(8));
      const u = run(home, ['uninstall']);
      check('uninstall preserves a chmod 600 settings.json', u.status === 0 && (fs.statSync(settingsPath(home)).mode & 0o777) === 0o600, (fs.statSync(settingsPath(home)).mode & 0o777).toString(8));
      fs.chmodSync(settingsPath(home), 0o640);
      run(home, ['--install']);
      check('install preserves a chmod 640 settings.json', (fs.statSync(settingsPath(home)).mode & 0o777) === 0o640, (fs.statSync(settingsPath(home)).mode & 0o777).toString(8));
    });
  }

  // ---- backups: pruned to five, and only the files ampline wrote -------------------------

  withHome((home) => {
    writeSettings(home, USER_SETTINGS());
    for (let n = 1; n <= 8; n++) fs.writeFileSync(path.join(claude(home), `settings.json.backup.${stamp(n)}`), `old ${n}\n`);
    // Names that begin the same way but are not ampline's: the user's own files. (A name with
    // colons cannot exist on Windows.)
    const mine = ['settings.json.backup.before-experiment', 'settings.json.backup.2026-01-01', 'settings.json.backup.2026-01-01T10-00-00-000Z.bak', 'settings.json.backup.']
      .concat(WIN ? [] : ['settings.json.backup.2026-01-01T10:00:00.000Z']);
    for (const f of mine) fs.writeFileSync(path.join(claude(home), f), 'mine\n');
    const r = run(home, ['--install']);
    const left = backups(home);
    const stamped = left.filter((f) => /^settings\.json\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(f));
    check('backups are pruned to the newest five', r.status === 0 && stamped.length === 5, JSON.stringify(stamped));
    check('the newest backup is the one just taken and the oldest stamps went first',
      !stamped.includes(`settings.json.backup.${stamp(1)}`) && !stamped.includes(`settings.json.backup.${stamp(3)}`) && stamped.includes(`settings.json.backup.${stamp(8)}`), JSON.stringify(stamped));
    check('files that only look like backups are never pruned',
      mine.every((f) => fs.existsSync(path.join(claude(home), f)) && fs.readFileSync(path.join(claude(home), f), 'utf8') === 'mine\n'), JSON.stringify(left));
  });

  // ---- uninstall -------------------------------------------------------------------------

  withHome((home) => {
    writeSettings(home, USER_SETTINGS());
    run(home, ['--install']);
    fs.mkdirSync(cacheDir(home), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(home), 'usage.json'), '{}\n');
    fs.mkdirSync(path.join(claude(home), 'cache', 'other'), { recursive: true });
    fs.writeFileSync(path.join(claude(home), 'cache', 'other', 'keep.txt'), 'keep\n');
    fs.mkdirSync(path.join(claude(home), 'hooks', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(claude(home), 'hooks', 'mine', 'keep.sh'), 'keep\n');
    const installed = fs.readFileSync(settingsPath(home), 'utf8');
    const backupsBefore = backups(home).length;

    const r = run(home, ['uninstall']);
    check('uninstall exits 0 and reports the removal with the backup name', r.status === 0 && /^ampline-claude removed\. Backup: settings\.json\.backup\./m.test(r.out), JSON.stringify(r.out));
    const s = readSettings(home);
    check('uninstall removes statusLine and subagentStatusLine and nothing else',
      !('statusLine' in s) && !('subagentStatusLine' in s) && JSON.stringify(s) === JSON.stringify(USER_SETTINGS()), JSON.stringify(s));
    check('uninstall deletes the runtime and the ampline cache but not its neighbours',
      !fs.existsSync(runtimeDir(home)) && !fs.existsSync(cacheDir(home))
        && fs.existsSync(path.join(claude(home), 'cache', 'other', 'keep.txt')) && fs.existsSync(path.join(claude(home), 'hooks', 'mine', 'keep.sh')), 'wrong files removed');
    check('uninstall backs up the settings it is about to change',
      backups(home).length === backupsBefore + 1
        && fs.readFileSync(path.join(claude(home), backups(home).slice(-1)[0]), 'utf8') === installed, JSON.stringify(backups(home)));

    const again = run(home, ['--uninstall']);
    check('a second uninstall (--uninstall) has nothing to remove and exits 0',
      again.status === 0 && /nothing to remove/.test(again.out), JSON.stringify(again.out));
  });

  // Only one of the two entries is ours: remove just that one.
  withHome((home) => {
    run(home, ['--install']);
    const s = readSettings(home);
    s.subagentStatusLine = { type: 'command', command: 'bash ~/sub.sh' };
    writeSettings(home, s);
    const r = run(home, ['uninstall']);
    const after = readSettings(home);
    check('uninstall removes our statusLine and leaves a foreign subagentStatusLine',
      r.status === 0 && !('statusLine' in after) && after.subagentStatusLine.command === 'bash ~/sub.sh', JSON.stringify(after));
  });

  // Settings already lack the entries (Minor 17): the runtime and cache still go.
  withHome((home) => {
    run(home, ['--install']);
    writeSettings(home, USER_SETTINGS()); // the user removed the entries by hand
    fs.mkdirSync(cacheDir(home), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(home), 'usage.json'), '{}\n');
    const bytes = fs.readFileSync(settingsPath(home), 'utf8');
    const r = run(home, ['uninstall']);
    check('uninstall with no entries left still removes the runtime and cache, and says so',
      r.status === 0 && !fs.existsSync(runtimeDir(home)) && !fs.existsSync(cacheDir(home)) && /removed the runtime copy and cache/.test(r.out), JSON.stringify(r.out));
    check('... and does not touch or back up settings.json',
      fs.readFileSync(settingsPath(home), 'utf8') === bytes && backups(home).length === 0, JSON.stringify(backups(home)));
  });
  withHome((home) => {
    run(home, ['--install']);
    fs.rmSync(settingsPath(home), { force: true });
    const r = run(home, ['uninstall']);
    check('uninstall with no settings.json at all still removes the runtime',
      r.status === 0 && !fs.existsSync(runtimeDir(home)) && !fs.existsSync(settingsPath(home)), JSON.stringify(r.out));
  });
  withHome((home) => {
    const r = run(home, ['uninstall']);
    check('uninstall on a machine with nothing installed says there is nothing to remove',
      r.status === 0 && /nothing to remove/.test(r.out) && !fs.existsSync(settingsPath(home)), JSON.stringify(r.out));
  });
  // A foreign statusline may call the installed runtime, so it stays when settings point elsewhere.
  withHome((home) => {
    run(home, ['--install']);
    writeSettings(home, { statusLine: { type: 'command', command: 'bash ~/mine.sh' } });
    const r = run(home, ['uninstall']);
    check('uninstall keeps the runtime when settings point at a different statusline',
      r.status === 0 && fs.existsSync(runtimeDir(home)) && /different statusline/.test(r.out), JSON.stringify(r.out));
  });

  // ---- stale staging directories (Minor 9) -----------------------------------------------

  withHome((home) => {
    const hooks = path.join(claude(home), 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const old = ['ampline-claude.new-111', 'ampline-claude.old-222'];
    const fresh = 'ampline-claude.new-333';
    const unrelated = 'ampline-claude-extra.new-1';
    for (const d of [...old, fresh, unrelated]) {
      fs.mkdirSync(path.join(hooks, d), { recursive: true });
      fs.writeFileSync(path.join(hooks, d, 'f.txt'), 'x\n');
    }
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    for (const d of [...old, unrelated]) fs.utimesSync(path.join(hooks, d), longAgo, longAgo);
    const r = run(home, ['--install']);
    check('install removes staging directories older than a minute',
      r.status === 0 && old.every((d) => !fs.existsSync(path.join(hooks, d))), JSON.stringify(fs.readdirSync(hooks)));
    check('... but not a fresh one (another install may be running) or an unrelated name',
      fs.existsSync(path.join(hooks, fresh)) && fs.existsSync(path.join(hooks, unrelated)), JSON.stringify(fs.readdirSync(hooks)));
  });

  // ---- --version / --help ----------------------------------------------------------------

  withHome((home) => {
    for (const flag of ['--version', '-v']) {
      const r = run(home, [flag]);
      check(`${flag} prints the package version and exits 0`, r.status === 0 && r.out.trim() === PKG_VERSION && r.err === '', JSON.stringify(r.out));
    }
    const long = run(home, ['--help']);
    const short = run(home, ['-h']);
    check('--help prints usage that names every documented command',
      long.status === 0 && long.out.includes('Usage:') && ['--install', 'uninstall', '--version', '--help'].every((w) => long.out.includes(w)), JSON.stringify(long.out.slice(0, 200)));
    check('-h prints the same text as --help', short.status === 0 && short.out === long.out, 'different output');
    check('--help writes nothing to stderr and changes nothing on disk', long.err === '' && !fs.existsSync(settingsPath(home)) && !fs.existsSync(runtimeDir(home)), long.err);
  });

  // ---- test isolation (K3) ---------------------------------------------------------------

  {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'ampline-never-created');
    try {
      const env = cleanEnv();
      check('cleanEnv drops CLAUDE_CONFIG_DIR, NO_COLOR and FORCE_COLOR', !('CLAUDE_CONFIG_DIR' in env) && !('NO_COLOR' in env) && !('FORCE_COLOR' in env), JSON.stringify(Object.keys(env).filter((k) => /CLAUDE|COLOR/.test(k))));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }

  // ---- in-process: node path chooser (K2), command matching and backup names (S4) --------

  const install = require('../lib/install');

  {
    const { chooseNodePath, isVersionedNodePath } = install;
    const real = (map) => (p) => { if (p in map) return map[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    const exists = (set) => (p) => set.includes(p);
    const posix = (o) => chooseNodePath({ platform: 'darwin', ...o });
    const cellar = '/opt/homebrew/Cellar/node/24.1.0/bin/node';

    check('versioned detection: Homebrew Cellar, nvm, fnm, volta, asdf, nodenv, mise and nvm-windows',
      [cellar, '/usr/local/Cellar/node@24/24.1.0/bin/node', '/home/u/.nvm/versions/node/v24.1.0/bin/node',
        '/home/u/.local/share/fnm/node-versions/v24.1.0/installation/bin/node', '/home/u/.volta/tools/image/node/24.1.0/bin/node',
        '/home/u/.asdf/installs/nodejs/24.1.0/bin/node', '/home/u/.nodenv/versions/24.1.0/bin/node',
        '/home/u/.local/share/mise/installs/node/24.1.0/bin/node', 'C:\\Users\\u\\AppData\\Roaming\\nvm\\v24.1.0\\node.exe'].every(isVersionedNodePath),
      'a versioned path was not recognised');
    check('versioned detection: ordinary install locations are not versioned',
      ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node', 'C:\\Program Files\\nodejs\\node.exe', '/home/u/node-v24-linux-x64/bin/node'].every((p) => !isVersionedNodePath(p)),
      'a stable path was flagged');

    const brew = posix({
      execPath: cellar, pathEntries: ['/usr/bin', '/opt/homebrew/bin'],
      realpath: real({ [cellar]: cellar, '/opt/homebrew/bin/node': cellar }), isFile: exists([cellar, '/opt/homebrew/bin/node']),
    });
    check('Homebrew: the stable PATH entry is written instead of the Cellar path', !!brew && brew.path === '/opt/homebrew/bin/node' && brew.source === 'path', JSON.stringify(brew));

    const intel = posix({
      execPath: '/usr/local/Cellar/node/24.1.0/bin/node', pathEntries: ['/usr/local/bin'],
      realpath: real({ '/usr/local/Cellar/node/24.1.0/bin/node': '/usr/local/Cellar/node/24.1.0/bin/node', '/usr/local/bin/node': '/usr/local/Cellar/node/24.1.0/bin/node' }),
      isFile: exists(['/usr/local/Cellar/node/24.1.0/bin/node', '/usr/local/bin/node']),
    });
    check('Homebrew on Intel: /usr/local/bin/node', !!intel && intel.path === '/usr/local/bin/node', JSON.stringify(intel));

    const nvmPath = '/home/u/.nvm/versions/node/v24.1.0/bin/node';
    const nvm = posix({
      execPath: nvmPath, pathEntries: ['/home/u/.nvm/versions/node/v24.1.0/bin'],
      realpath: real({ [nvmPath]: nvmPath }), isFile: exists([nvmPath]),
    });
    check('nvm: a PATH entry that is itself a versioned directory is no better, so execPath stays (D27)', !!nvm && nvm.path === nvmPath && nvm.source === 'execPath', JSON.stringify(nvm));

    const fnmReal = '/home/u/.local/share/fnm/node-versions/v24.1.0/installation/bin/node';
    const multishell = '/run/user/1000/fnm_multishells/123_456/bin/node';
    const fnm = posix({
      execPath: fnmReal, pathEntries: ['/run/user/1000/fnm_multishells/123_456/bin'],
      realpath: real({ [fnmReal]: fnmReal, [multishell]: fnmReal }), isFile: exists([fnmReal, multishell]),
    });
    check('fnm: a temporary multishell symlink is never written', !!fnm && fnm.path === fnmReal && fnm.source === 'execPath', JSON.stringify(fnm));

    const other = posix({
      execPath: cellar, pathEntries: ['/usr/bin'],
      realpath: real({ [cellar]: cellar, '/usr/bin/node': '/usr/bin/node' }), isFile: exists([cellar, '/usr/bin/node']),
    });
    check('a PATH node that is a different binary is ignored', !!other && other.path === cellar && other.source === 'execPath', JSON.stringify(other));

    const shadowed = posix({
      execPath: cellar, pathEntries: ['/usr/bin', '/opt/homebrew/bin'],
      realpath: real({ [cellar]: cellar, '/usr/bin/node': '/usr/bin/node', '/opt/homebrew/bin/node': cellar }), isFile: exists([cellar, '/usr/bin/node', '/opt/homebrew/bin/node']),
    });
    check('a different node earlier on PATH does not stop a later stable path to the same binary', !!shadowed && shadowed.path === '/opt/homebrew/bin/node', JSON.stringify(shadowed));

    const stable = posix({
      execPath: '/usr/bin/node', pathEntries: ['/opt/homebrew/bin'],
      realpath: () => { throw new Error('realpath must not be needed'); }, isFile: exists(['/usr/bin/node']),
    });
    check('a non-versioned execPath is used as is, without scanning PATH', !!stable && stable.path === '/usr/bin/node' && stable.source === 'execPath', JSON.stringify(stable));

    const junk = posix({
      execPath: cellar, pathEntries: ['', 'relative/bin', '/does/not/exist', '/opt/homebrew/bin'],
      realpath: real({ [cellar]: cellar, '/opt/homebrew/bin/node': cellar }), isFile: exists([cellar, '/opt/homebrew/bin/node']),
    });
    check('empty, relative and missing PATH entries are skipped', !!junk && junk.path === '/opt/homebrew/bin/node', JSON.stringify(junk));

    const broken = posix({
      execPath: cellar, pathEntries: ['/opt/homebrew/bin'],
      realpath: real({ [cellar]: cellar }), isFile: exists([cellar, '/opt/homebrew/bin/node']),
    });
    check('a PATH entry whose realpath fails is skipped', !!broken && broken.path === cellar && broken.source === 'execPath', JSON.stringify(broken));

    const noExec = posix({ execPath: '/gone/node', pathEntries: ['/usr/bin'], realpath: real({}), isFile: exists([]) });
    const relExec = posix({ execPath: 'node', pathEntries: ['/usr/bin'], realpath: real({}), isFile: exists(['node']) });
    check('an execPath that is missing or relative yields null (the caller falls back to bare node)', noExec === null && relExec === null, JSON.stringify([noExec, relExec]));

    const wExec = 'C:\\Users\\u\\AppData\\Roaming\\nvm\\v24.1.0\\node.exe';
    const wStable = 'C:\\Program Files\\nodejs\\node.exe';
    const win = chooseNodePath({
      platform: 'win32', execPath: wExec, pathEntries: ['C:\\Windows\\System32', 'C:\\Program Files\\nodejs'],
      realpath: real({ [wExec]: wExec, [wStable]: wExec }), isFile: exists([wExec, wStable]),
    });
    check('Windows: node.exe is looked up on PATH with win32 path rules', !!win && win.path === wStable && win.source === 'path', JSON.stringify(win));
  }

  {
    const { pointsAtUs } = install;
    const e = '/home/u/.claude/hooks/ampline-claude/bin/ampline-claude.js';
    const yes = [
      `"/usr/bin/node" "${e}"`, `"/usr/bin/node" "${e}" --subagent`, `node "${e}"`, `node "${e}" --subagent`,
      `"C:/Program Files/nodejs/node.exe" "C:/Users/u/.claude/hooks/ampline-claude/bin/ampline-claude.js"`,
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.claude\\hooks\\ampline-claude\\bin\\ampline-claude.js"`,
      `node "/custom/config/hooks/ampline-claude/bin/ampline-claude.js"`,
    ];
    const no = [
      '~/bin/ampline-claude-wrap.sh', '~/bin/ampline-claude-wrap.sh --subagent', 'bash ampline-claude.sh', 'npx ampline-claude',
      `node "${e}" --other-flag`, `node "${e}"; rm -rf ~`, `node "${e}" && echo hi`, `echo "${e}"`,
      `node "/x/hooks/ampline-claude/bin/ampline-claude.js.bak"`, `node "/x/hooks/ampline-claude-two/bin/ampline-claude.js"`, '', 'ampline-claude',
    ];
    check('pointsAtUs accepts the exact command shapes the installer writes', yes.every((c) => pointsAtUs({ command: c })), JSON.stringify(yes.filter((c) => !pointsAtUs({ command: c }))));
    check('pointsAtUs rejects wrappers, other flags, chained commands and look-alike paths', no.every((c) => !pointsAtUs({ command: c })), JSON.stringify(no.filter((c) => pointsAtUs({ command: c }))));
    check('pointsAtUs rejects missing and non-string commands', [null, undefined, {}, { command: 5 }, { command: null }, 'x', []].every((v) => !pointsAtUs(v)), 'accepted junk');
  }

  {
    const { isBackupName } = install;
    check('isBackupName accepts only the stamp ampline writes',
      isBackupName('settings.json.backup.2026-10-09T14-03-22-123Z')
        && ['settings.json.backup.', 'settings.json.backup.mine', 'settings.json.backup.2026-10-09', 'settings.json.backup.2026-10-09T14-03-22-123Z.bak',
          'x.settings.json.backup.2026-10-09T14-03-22-123Z', 'settings.json.backup.2026-10-09T14:03:22.123Z', 'settings.json.backup.2026-10-09T14-03-22-123Z\n'].every((n) => !isBackupName(n)),
      'wrong match');
  }

  // ---- in-process: a failed backup aborts instead of rewriting without one (S4) -----------

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-test-cfg-'));
    const savedEnv = process.env.CLAUDE_CONFIG_DIR;
    const realCopy = fs.copyFileSync;
    const realLog = console.log;
    const realErr = console.error;
    const savedExit = process.exitCode;
    const outs = [];
    const errs = [];
    const modules = [path.join(ROOT, 'lib', 'install.js'), path.join(ROOT, 'lib', 'claudeDir.js')];
    let sandboxed = null;
    try {
      process.env.CLAUDE_CONFIG_DIR = dir;
      for (const m of modules) delete require.cache[require.resolve(m)];
      sandboxed = require(modules[0]);
      const settings = path.join(dir, 'settings.json');
      const original = JSON.stringify({ env: { KEEP: '1' }, statusLine: { type: 'command', command: 'bash ~/mine.sh' } }, null, 2) + '\n';
      fs.writeFileSync(settings, original);
      fs.copyFileSync = (src, dest, ...rest) => {
        if (path.resolve(String(src)) === path.resolve(settings)) { const e = new Error('EACCES: simulated backup failure'); e.code = 'EACCES'; throw e; }
        return realCopy.call(fs, src, dest, ...rest);
      };
      console.log = (...a) => outs.push(a.join(' '));
      console.error = (...a) => errs.push(a.join(' '));
      process.exitCode = 0;
      sandboxed.runInstaller();
      const installCode = process.exitCode;
      console.error = realErr;
      fs.copyFileSync = realCopy;
      check('an install whose backup fails exits 1 with a clear message and leaves settings.json untouched',
        installCode === 1 && errs.some((e) => /could not back up/.test(e) && /Refusing to modify/.test(e)) && fs.readFileSync(settings, 'utf8') === original, JSON.stringify({ installCode, errs }));

      // The same for uninstall: settings that point at us, a backup that fails, nothing removed.
      const ours = JSON.stringify({ env: { KEEP: '1' }, statusLine: { type: 'command', command: `node "${sandboxed.ENTRY}"` } }, null, 2) + '\n';
      fs.writeFileSync(settings, ours);
      fs.mkdirSync(sandboxed.INSTALL_DIR, { recursive: true });
      fs.writeFileSync(path.join(sandboxed.INSTALL_DIR, 'marker.txt'), 'x\n');
      errs.length = 0;
      fs.copyFileSync = (src, dest, ...rest) => {
        if (path.resolve(String(src)) === path.resolve(settings)) { const e = new Error('EACCES: simulated backup failure'); e.code = 'EACCES'; throw e; }
        return realCopy.call(fs, src, dest, ...rest);
      };
      console.error = (...a) => errs.push(a.join(' '));
      process.exitCode = 0;
      sandboxed.runInstaller({ uninstall: true });
      const uninstallCode = process.exitCode;
      console.error = realErr;
      fs.copyFileSync = realCopy;
      check('an uninstall whose backup fails exits 1, rewrites nothing and removes nothing',
        uninstallCode === 1 && errs.some((e) => /could not back up/.test(e)) && fs.readFileSync(settings, 'utf8') === ours && fs.existsSync(path.join(sandboxed.INSTALL_DIR, 'marker.txt')), JSON.stringify({ uninstallCode, errs }));
    } finally {
      console.log = realLog;
      console.error = realErr;
      fs.copyFileSync = realCopy;
      process.exitCode = savedExit;
      if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedEnv;
      for (const m of modules) delete require.cache[require.resolve(m)];
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = { runInstallerTests };
