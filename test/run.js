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
  'haiku-5-5-medium.json':     { expect: ['Haiku 5.5', 'medium', '\x1b[38;2;77;121;232m'], refute: ['NaN'] },
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
  'pr-gitlab-shape.json':      { expect: ['!42'], refute: ['#42', 'NaN'] },
  'resets-at-ms.json':         { expect: ['H'], refute: ['↺', 'NaN'] },
  'separator-injection.json':  { refute: [String.fromCharCode(27) + ']8;;http://evil.example', 'NaN'] },
  'emoji-task.json':           { refute: [String.fromCodePoint(0xfffd), 'NaN'] },
};

let failures = 0;

function fail(name, message) {
  failures++;
  console.error(`  FAIL  ${name}: ${message}`);
}

// Spawns the real binary against `input` in a throwaway HOME. `seed(home)` can
// drop companion files in first; `env` overlays the child's environment.
function spawnRender(input, { args = [BIN], seed, env = {} } = {}) {
  const home = makeTempHome();
  if (seed) seed(home);
  // A developer's exported NO_COLOR / FORCE_COLOR must not leak into the child:
  // with color off, no escape is ever emitted, so every "no link" and "no stray
  // escape" assertion would pass vacuously. Tests that want it pass it via `env`.
  const base = { ...process.env };
  delete base.NO_COLOR;
  delete base.FORCE_COLOR;
  const res = spawnSync(process.execPath, args, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...base, HOME: home, USERPROFILE: home, COLUMNS: '120', ...env },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  return res;
}

function runFixture(name) {
  const input = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const isSubagent = name.startsWith('subagent');
  const res = spawnRender(input, {
    args: isSubagent ? [BIN, '--subagent'] : [BIN],
    seed: (home) => seedFilesFor(name, home),
  });
  assertResult(name, res, EXPECTATIONS[name] || {});
}

// For scenarios that are a payload plus exact-bytes assertions (color escapes,
// OSC 8 links) rather than a standing fixture file.
function runInline(name, payload, rules, env, seed, args) {
  const res = spawnRender(typeof payload === 'string' ? payload : JSON.stringify(payload), { env, seed, args });
  assertResult(name, res, rules);
}

function assertResult(name, res, rules) {
  if (res.error) return fail(name, `spawn error: ${res.error.message}`);
  if (res.status !== 0) return fail(name, `exit code ${res.status}`);
  if (typeof res.stdout !== 'string') return fail(name, 'stdout is not a string');
  if (res.stderr && /error/i.test(res.stderr)) {
    return fail(name, `stderr contained an error: ${res.stderr.trim().slice(0, 200)}`);
  }

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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const sgr = ([r, g, b]) => `${ESC}[38;2;${r};${g};${b}m`;

// A minimal valid statusline payload; `extra` overlays top-level keys.
function inlinePayload(extra) {
  return {
    session_id: 'inline',
    cwd: '/tmp/project',
    model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
    context_window: { used_percentage: 12, remaining_percentage: 88 },
    ...extra,
  };
}

// Haiku 5.5 has real effort levels: a dark-to-light blue ramp that ends at the
// flat Haiku blue used before 5.5. No effort data at all (Haiku 4.5, a numeric
// budget, an unknown string) keeps that blue exactly.
const HAIKU_RAMP = {
  low:    [61, 100, 232],
  medium: [77, 121, 232],
  high:   [93, 142, 232],
  xhigh:  [109, 163, 232],
  max:    [125, 184, 232],
};
const HAIKU_FLAT = [125, 184, 232];

function runHaikuTests() {
  for (const [level, rgb] of Object.entries(HAIKU_RAMP)) {
    const rules = { expect: [sgr(rgb), level], refute: ['NaN', 'undefined'] };
    if (level === 'max') {
      rules.expect.push(ESC + '[1m' + sgr(rgb)); // only max is bold
    } else {
      rules.refute.push(ESC + '[1m', sgr(HAIKU_FLAT)); // others: quiet, and not the old flat blue
    }
    runInline(`haiku-5-5 effort=${level}`, inlinePayload({ effort: { level } }), rules);
  }

  const stops = Object.values(HAIKU_RAMP).slice(0, 4).map(sgr);
  const noEffort = { expect: [sgr(HAIKU_FLAT)], refute: [...stops, 'NaN', 'undefined', ESC + '[1m'] };
  runInline('haiku no effort field',      inlinePayload({}), noEffort);
  runInline('haiku effort=null',          inlinePayload({ effort: null }), noEffort);
  runInline('haiku effort unknown level', inlinePayload({ effort: { level: 'ultra' } }), noEffort);
  runInline('haiku effort numeric budget', inlinePayload({ effort: { level: 12000 } }), noEffort);

  // Subagent rows color by family. They rarely carry effort, but when a Haiku
  // task does send a level string it follows the same ramp as the main line.
  const subTask = (extra) => ({
    columns: 120,
    tasks: [{ id: 't1', type: 'local_agent', status: 'running', label: 'worker',
              model: 'claude-haiku-5-5', tokenCount: 1000, contextWindowSize: 200000, cwd: '/tmp/project', ...extra }],
  });
  runInline('haiku subagent row with effort follows the ramp', subTask({ effort: 'low' }),
    { expect: [sgr(HAIKU_RAMP.low)], refute: ['NaN', 'undefined'] }, {}, undefined, [BIN, '--subagent']);
  runInline('haiku subagent row without effort stays flat blue', subTask({}),
    { expect: [sgr(HAIKU_FLAT)], refute: [sgr(HAIKU_RAMP.low), 'NaN', 'undefined'] }, {}, undefined, [BIN, '--subagent']);
  runInline('haiku subagent row with numeric budget stays flat blue', subTask({ effort: 12000 }),
    { expect: [sgr(HAIKU_FLAT)], refute: [sgr(HAIKU_RAMP.low), 'NaN', 'undefined'] }, {}, undefined, [BIN, '--subagent']);

  const { WHEEL } = require('../lib/colors');
  if (WHEEL.length !== 20) fail('WHEEL', `expected 20 steps, got ${WHEEL.length}`);
  else if (new Set(WHEEL.map((c) => c.join(','))).size !== 20) fail('WHEEL', 'steps are not all distinct');
  else console.log('  ok    WHEEL has 20 distinct steps');
}

// ---- PR / MR segment -------------------------------------------------------
// Claude Code fills `pr` from `gh` (GitHub) or `glab` (GitLab, `kind: "mr"`).
// pr.url is a foreign string: the number must always render, but the label only
// becomes a clickable OSC 8 link when the URL passes a strict https allowlist.
const OSC8 = ESC + ']8;';
const linkOpen = (url) => `${OSC8};${url}${BEL}`;
const linkClose = `${OSC8};${BEL}`;

function prPayload(pr) {
  return inlinePayload({
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
    effort: { level: 'high' },
    pr,
  });
}

function runPrTests() {
  const ghUrl = 'https://github.com/carterptull/ampline-claude/pull/12';
  const glUrl = 'https://gitlab.com/group/project/-/merge_requests/42';
  const nestedUrl = 'https://git.example.com/a/b/c/project/-/merge_requests/7';

  runInline('pr github: #N, linked', prPayload({ number: 12, url: ghUrl, review_state: 'pending' }),
    { expect: ['#12', linkOpen(ghUrl), linkClose], refute: ['!12', 'NaN'] });
  runInline('pr gitlab mr: !N, linked', prPayload({ number: 42, url: glUrl, review_state: 'approved', kind: 'mr' }),
    { expect: ['!42', linkOpen(glUrl), linkClose], refute: ['#42', 'NaN'] });
  runInline('pr gitlab mr: self-managed nested subgroup', prPayload({ number: 7, url: nestedUrl, kind: 'mr' }),
    { expect: ['!7', linkOpen(nestedUrl)], refute: ['#7'] });
  runInline('pr mr without url: label only', prPayload({ number: 9, review_state: 'pending', kind: 'mr' }),
    { expect: ['!9'], refute: [OSC8, '#9'] });
  runInline('pr kind other than "mr" falls back to #N', prPayload({ number: 9, url: glUrl, kind: 'weird' }),
    { expect: ['#9'], refute: ['!9', 'weird'] });
  runInline('pr kind with escape bytes is never interpolated',
    prPayload({ number: 9, url: glUrl, kind: ESC + '[31mmr' }),
    { expect: ['#9'], refute: [ESC + '[31mmr', '!9'] });

  // review_state is a foreign string used as a lookup key: names that exist on
  // Object.prototype must not resolve to a "color" and print function source.
  for (const state of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    runInline(`pr review_state=${state} is not a color`, prPayload({ number: 5, url: ghUrl, review_state: state }),
      { expect: ['#5'], refute: ['function', 'native code', '[object', 'undefined'] });
  }

  // Hostile or unusable URLs: the number still renders, no link is emitted, and
  // none of the attacker's bytes reach stdout.
  const hostile = {
    'javascript: scheme':        { url: 'javascript:alert(1)' },
    'file: scheme':              { url: 'file:///c:/windows/system32' },
    'plain http':                { url: 'http://gitlab.com/x' },
    'embedded credentials':      { url: 'https://user:pw@gitlab.com/x' },
    'BEL + OSC title breakout':  { url: 'https://gitlab.com/x' + BEL + ESC + ']0;pwned' + BEL, bad: ESC + ']0;pwned' },
    'ESC CSI clear-screen':      { url: 'https://gitlab.com/x' + ESC + '[2J', bad: ESC + '[2J' },
    'space in URL':              { url: 'https://gitlab.com/x y' },
    'newline in URL':            { url: 'https://gitlab.com/x\ny' },
    'non-ASCII character':       { url: 'https://gitlab.com/\u00e9' },
    'unicode line separator':    { url: 'https://gitlab.com/x\u2028y' },
    'over 2048 characters':      { url: 'https://gitlab.com/' + 'a'.repeat(5000) },
    'empty string':              { url: '' },
    'not a string':              { url: { href: 'https://gitlab.com/x' } },
    'not a URL at all':          { url: 'not a url' },
  };
  for (const [label, { url, bad }] of Object.entries(hostile)) {
    runInline(`pr hostile url: ${label}`, prPayload({ number: 3, url, review_state: 'pending' }),
      { expect: ['#3'], refute: [OSC8, ...(bad ? [bad] : []), 'NaN', 'undefined'] });
  }

  // pr.number must be a real positive safe integer (or a plain digit string).
  // Number() coercion used to accept 1e21, "0x10", " 5 ", [5] and true.
  const malformedNumbers = {
    'exponent 1e21':         1e21,
    'hex string':            '0x10',
    'padded string':         ' 5 ',
    'exponent string':       '1e3',
    'decimal string':        '5.5',
    'negative string':       '-3',
    'array':                 [5],
    'boolean true':          true,
    'beyond safe integer':   9007199254740993,
  };
  for (const [label, number] of Object.entries(malformedNumbers)) {
    runInline(`pr number rejected: ${label}`, prPayload({ number, url: ghUrl }),
      { refute: ['#', '!', 'e+', 'NaN', 'undefined'] });
  }
  runInline('pr number accepted: plain integer', prPayload({ number: 7, url: ghUrl }), { expect: ['#7'] });
  runInline('pr number accepted: digit string', prPayload({ number: '15', url: ghUrl }), { expect: ['#15'] });
  runInline('pr number accepted: largest safe integer', prPayload({ number: 9007199254740991, url: ghUrl }),
    { expect: ['#9007199254740991'] });

  // No escape sequences of any kind when the user opted out of color.
  runInline('pr link omitted under NO_COLOR', prPayload({ number: 12, url: ghUrl }),
    { expect: ['#12'], refute: [OSC8, ESC + '['] }, { NO_COLOR: '1' });
  runInline('pr link omitted when config color is false', prPayload({ number: 12, url: ghUrl }),
    { expect: ['#12'], refute: [OSC8, ESC + '['] }, {},
    (home) => fs.writeFileSync(path.join(home, '.amplinerc.json'), JSON.stringify({ color: false }) + '\n', 'utf8'));
}

function main() {
  const names = fs.readdirSync(FIXTURES).sort();
  if (!names.length) {
    console.error('No fixtures found.');
    process.exit(1);
  }
  console.log(`Running ${names.length} fixtures against ${path.relative(ROOT, BIN)}\n`);
  for (const name of names) runFixture(name);

  runHaikuTests();
  runPrTests();

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
