'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'ampline-claude.js');
const FIXTURES = path.join(__dirname, 'fixtures');

// Each fixture gets its OWN throwaway HOME/USERPROFILE. A shared one isn't
// enough: an earlier fixture with live rate_limits legitimately write-throughs
// a cache entry that a later fixture (e.g. no-rate-limits.json) would then
// inherit. Per-fixture isolation is what makes each scenario independent.
function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-test-home-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// Config-file loading and the todos-backed task segment read from the
// filesystem rather than stdin, so a few fixtures need companion files
// seeded into the throwaway HOME.
function seedFilesFor(name, home) {
  if (name === 'separator-injection.json') {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const evilSeparator = esc + ']8;;http://evil.example' + bel + ' x ' + esc + ']8;;' + bel;
    fs.writeFileSync(
      path.join(home, '.amplinerc.json'),
      JSON.stringify({ separator: evilSeparator }) + '\n',
      'utf8'
    );
  }
  if (name === 'emoji-task.json') {
    const todosDir = path.join(home, '.claude', 'todos');
    fs.mkdirSync(todosDir, { recursive: true });
    const rocket = String.fromCodePoint(0x1f680); // outside the BMP -> a UTF-16 surrogate pair
    const content = rocket.repeat(45);
    fs.writeFileSync(
      path.join(todosDir, 'fixture-emoji-task.json'),
      JSON.stringify([{ status: 'in_progress', content }]),
      'utf8'
    );
  }
}

// fixture -> assertions: `expect` substrings must appear in stdout, `refute`
// must not. Omit both to assert only "does not crash".
const EXPECTATIONS = {
  'full.json':                 { expect: ['Opus', '#1234'], refute: ['NaN', 'undefined'], refuteStderr: ['no input received'] },
  'haiku-no-effort.json':      { refute: ['high', 'NaN'] },
  'sonnet-low.json':           { expect: ['low'], refute: ['NaN'] },
  'sonnet-max.json':           { expect: ['max'], refute: ['NaN'] },
  'opus-xhigh.json':           { expect: ['xhigh'], refute: ['NaN'] },
  'fable-max.json':            { expect: ['max'], refute: ['NaN'] },
  'unknown-model.json':        { refute: ['NaN', 'undefined'] },
  'no-rate-limits.json':       { refute: ['↺', 'NaN', 'undefined'] },
  'five-hour-only.json':       { expect: ['H'], refute: ['NaN'] },
  'seven-day-only.json':       { expect: ['W'], refute: ['NaN'] },
  'float-percentages.json':    { refute: ['NaN'] },
  'expired-reset.json':        { refute: ['↺', 'NaN'] },
  'null-context.json':         { refute: ['NaN', 'C0 '] },
  'no-workspace.json':         { refute: ['NaN', 'undefined'] },
  'pr-present.json':           { expect: ['#1'], refute: ['NaN'] },
  'pr-no-review-state.json':   { expect: ['#7'], refute: ['NaN'] },
  'worktree.json':             { refute: ['NaN', 'undefined'] },
  'subagent-tasks.json':       { refute: ['NaN', 'local_agent'] },
  'malformed.txt':             { refute: ['NaN'] },
  'empty.txt':                 { refute: ['NaN'], expectStderr: ['no input received', '--install'] },
  'pr-null-number.json':       { refute: ['#0', 'NaN', 'undefined'] },
  'pr-gitlab-shape.json':      { expect: ['#42'], refute: ['NaN'] },
  'resets-at-ms.json':         { expect: ['H'], refute: ['↺', 'NaN'] },
  'separator-injection.json':  { refute: [String.fromCharCode(27) + ']8;;http://evil.example', 'NaN'] },
  'emoji-task.json':           { refute: [String.fromCodePoint(0xfffd), 'NaN'] },
};

let failures = 0;

function fail(name, message) {
  failures++;
  console.error(`  FAIL  ${name}: ${message}`);
}

function runFixture(name) {
  const file = path.join(FIXTURES, name);
  const input = fs.readFileSync(file, 'utf8');
  const isSubagent = name.startsWith('subagent');
  const args = isSubagent ? [BIN, '--subagent'] : [BIN];

  const home = makeTempHome();
  seedFilesFor(name, home);
  const res = spawnSync(process.execPath, args, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: '120' },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}

  if (res.error) return fail(name, `spawn error: ${res.error.message}`);
  if (res.status !== 0) return fail(name, `exit code ${res.status}`);
  if (typeof res.stdout !== 'string') return fail(name, 'stdout is not a string');
  if (res.stderr && /error/i.test(res.stderr)) {
    return fail(name, `stderr contained an error: ${res.stderr.trim().slice(0, 200)}`);
  }

  const rules = EXPECTATIONS[name] || {};
  for (const needle of rules.expect || []) {
    if (!res.stdout.includes(needle)) return fail(name, `expected stdout to contain ${JSON.stringify(needle)}`);
  }
  for (const needle of rules.refute || []) {
    if (res.stdout.includes(needle)) return fail(name, `stdout must not contain ${JSON.stringify(needle)}`);
  }
  for (const needle of rules.expectStderr || []) {
    if (!res.stderr.includes(needle)) return fail(name, `expected stderr to contain ${JSON.stringify(needle)}`);
  }
  for (const needle of rules.refuteStderr || []) {
    if (res.stderr.includes(needle)) return fail(name, `stderr must not contain ${JSON.stringify(needle)}`);
  }

  console.log(`  ok    ${name}`);
}

function main() {
  const names = fs.readdirSync(FIXTURES).sort();
  if (!names.length) {
    console.error('No fixtures found.');
    process.exit(1);
  }
  console.log(`Running ${names.length} fixtures against ${path.relative(ROOT, BIN)}\n`);
  for (const name of names) runFixture(name);

  // NO_COLOR must strip every escape sequence.
  const home = makeTempHome();
  const res = spawnSync(process.execPath, [BIN], {
    input: fs.readFileSync(path.join(FIXTURES, 'full.json'), 'utf8'),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: '120', NO_COLOR: '1' },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  if (res.status !== 0) fail('NO_COLOR', `exit code ${res.status}`);
  else if (/\x1b\[/.test(res.stdout)) fail('NO_COLOR', 'output still contains ANSI escapes');
  else console.log('  ok    NO_COLOR');

  console.log(failures ? `\n${failures} failure(s)` : '\nAll green.');
  process.exit(failures ? 1 : 0);
}

main();
