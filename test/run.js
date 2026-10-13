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

// ---- Pace: how much of a rate-limit window has elapsed ---------------------
// Every fixture's resets_at is already in the past, so none of them can exercise
// this. The helper takes an injectable `now`, which makes the math exact here
// instead of "roughly mid-window" through a spawned binary.
function runPaceTests() {
  const { elapsedFraction } = require('../lib/usage');
  if (typeof elapsedFraction !== 'function') {
    return fail('elapsedFraction', 'lib/usage.js does not export elapsedFraction');
  }

  const HOUR = 60 * 60 * 1000;
  const FIVE_H = 5 * HOUR;
  const SEVEN_D = 7 * 24 * HOUR;
  const NOW = 1_800_000_000_000; // fixed instant; the helper never reads the clock when given one

  const cases = [
    ['window just started',            NOW + FIVE_H,         FIVE_H, 0],
    ['halfway through the 5h window',  NOW + FIVE_H / 2,     FIVE_H, 0.5],
    ['one fifth through',              NOW + FIVE_H * 0.8,   FIVE_H, 0.2],
    ['one minute before reset',        NOW + 60000,          FIVE_H, 1 - 60000 / FIVE_H],
    ['halfway through the weekly',     NOW + SEVEN_D / 2,    SEVEN_D, 0.5],
    ['5h remaining is early in weekly', NOW + FIVE_H,        SEVEN_D, 1 - FIVE_H / SEVEN_D],
    // The helper has no way to know which window a value belongs to, so it only
    // checks the value against the window it was given.
    ['reset exactly now',              NOW,                  FIVE_H, null],
    ['reset already past',             NOW - 1000,           FIVE_H, null],
    ['reset farther out than window',  NOW + FIVE_H + 1000,  FIVE_H, null],
    ['resetsAtMs null',                null,                 FIVE_H, null],
    ['resetsAtMs undefined',           undefined,            FIVE_H, null],
    ['resetsAtMs NaN',                 NaN,                  FIVE_H, null],
    ['resetsAtMs Infinity',            Infinity,             FIVE_H, null],
    ['resetsAtMs is a string',         String(NOW + HOUR),   FIVE_H, null],
    ['windowMs zero',                  NOW + HOUR,           0, null],
    ['windowMs negative',              NOW + HOUR,           -FIVE_H, null],
    ['windowMs NaN',                   NOW + HOUR,           NaN, null],
    ['windowMs Infinity',              NOW + HOUR,           Infinity, null],
    ['windowMs undefined',             NOW + HOUR,           undefined, null],
  ];

  for (const [name, resetsAtMs, windowMs, want] of cases) {
    const got = elapsedFraction(resetsAtMs, windowMs, NOW);
    const ok = want === null ? got === null : (typeof got === 'number' && Math.abs(got - want) < 1e-9);
    if (ok) console.log(`  ok    elapsedFraction: ${name}`);
    else fail(`elapsedFraction: ${name}`, `expected ${want}, got ${got}`);
  }

  // Without an injected `now` it reads the real clock.
  const live = elapsedFraction(Date.now() + FIVE_H / 2, FIVE_H);
  if (typeof live === 'number' && Math.abs(live - 0.5) < 0.01) console.log('  ok    elapsedFraction: defaults to the real clock');
  else fail('elapsedFraction: defaults to the real clock', `expected ~0.5, got ${live}`);

  // A bad clock value must degrade to "unknown", never to NaN in the bar.
  for (const badNow of [NaN, Infinity, 'soon']) {
    const v = elapsedFraction(NOW + HOUR, FIVE_H, badNow);
    if (v === null) console.log(`  ok    elapsedFraction: unusable now (${String(badNow)}) gives null`);
    else fail(`elapsedFraction: unusable now (${String(badNow)})`, `expected null, got ${v}`);
  }

}

// ---- Pace marker on the usage bar ------------------------------------------
// A single `┃` replaces one of the 8 bar cells to show how much of the window
// has elapsed. It is a glyph substitution on purpose: it is the only technique
// that still reads when NO_COLOR removes every attribute (D32).
function runBarMarkerTests() {
  const { renderBar, BAR_WIDTH } = require('../lib/bar');
  const { stripAnsi } = require('../lib/colors');
  const MARK = '┃';
  const cellsOf = (s) => {
    const m = /([█░┃]+)$/.exec(stripAnsi(String(s)));
    return m ? m[1] : '';
  };
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok    bar marker: ${name}`);
    else fail(`bar marker: ${name}`, detail);
  };
  const cells = (pct, opts) => cellsOf(renderBar('H', pct, opts));

  check('no marker option leaves the bar unchanged', cells(80) === '██████░░', cells(80));
  check('marker 0 lands in the first cell', cells(80, { marker: 0 }) === '┃█████░░', cells(80, { marker: 0 }));
  check('marker 0.5 lands on a filled cell', cells(80, { marker: 0.5 }) === '████┃█░░', cells(80, { marker: 0.5 }));
  check('marker on an empty cell', cells(20, { marker: 0.75 }) === '██░░░░┃░', cells(20, { marker: 0.75 }));
  check('marker 0.999 lands in the last cell', cells(80, { marker: 0.999 }) === '██████░┃', cells(80, { marker: 0.999 }));
  check('marker 1 is clamped into the last cell', cells(80, { marker: 1 }) === '██████░┃', cells(80, { marker: 1 }));

  // Non-integer products pin floor() against round()/ceil(): 0.3*8 = 2.4 and 0.7*8 = 5.6.
  check('marker 0.3 floors into cell 2', cells(0, { marker: 0.3 }) === '░░┃░░░░░', cells(0, { marker: 0.3 }));
  check('marker 0.7 floors into cell 5', cells(0, { marker: 0.7 }) === '░░░░░┃░░', cells(0, { marker: 0.7 }));
  check('marker 0.124 stays in cell 0 (just under 1/8)', cells(0, { marker: 0.124 }) === '┃░░░░░░░', cells(0, { marker: 0.124 }));
  check('marker 0.125 steps into cell 1', cells(0, { marker: 0.125 }) === '░┃░░░░░░', cells(0, { marker: 0.125 }));

  // The marker must carry no styling of its own ("color = identity, bold = urgency"): with
  // colors on, the 8 cells are one contiguous run ending in the single closing reset.
  const colorChild = spawnSync(process.execPath, ['-e',
    "const {renderBar}=require(process.argv[1]);process.stdout.write(JSON.stringify([renderBar('H',60,{marker:0.5}),renderBar('H',97,{marker:0.5})]))",
    path.join(ROOT, 'lib', 'bar.js')], {
    encoding: 'utf8', timeout: 10000,
    env: (() => { const e = { ...process.env }; delete e.NO_COLOR; return e; })(),
  });
  let colored = [];
  try { colored = JSON.parse(colorChild.stdout || '[]'); } catch {}
  check('colors-on output has escapes (the styling test is not vacuous)',
    colored.length === 2 && colored.every((s) => /\x1b\[/.test(s)), JSON.stringify(colored));
  check('marker adds no escape inside the bar run',
    colored.length === 2 && colored.every((s) => /[█░┃]{8}\x1b\[0m$/.test(s) && s.includes(MARK)), JSON.stringify(colored));

  // Width must never change, wherever the marker lands.
  let widthOk = true;
  let widthDetail = '';
  for (let m = 0; m <= 1.0001; m += 0.05) {
    const c = cells(55, { marker: Math.min(1, m) });
    const marks = c.split(MARK).length - 1;
    if (c.length !== BAR_WIDTH || marks !== 1) { widthOk = false; widthDetail = `marker=${m} -> "${c}"`; break; }
  }
  check('width stays 8 with exactly one marker across the range', widthOk, widthDetail);

  check('the label and rounded number are untouched',
    stripAnsi(renderBar('H', 80, { marker: 0.5 })).startsWith('H80 '), stripAnsi(renderBar('H', 80, { marker: 0.5 })));
  check('an out-of-range fill still clamps with a marker', cells(250, { marker: 0.5 }) === '████┃███', cells(250, { marker: 0.5 }));

  // Unknown or unusable values draw no marker rather than a wrong one.
  for (const [label, marker] of [['NaN', NaN], ['negative', -0.1], ['above 1', 1.0001], ['Infinity', Infinity],
    ['numeric string', '0.5'], ['null', null], ['undefined', undefined], ['object', {}], ['boolean', true]]) {
    const c = cells(80, { marker });
    check(`invalid marker (${label}) draws none`, c === '██████░░', c);
  }

  // The stale path drops urgency signals (D11); the marker compares quota to a live clock,
  // so with a possibly-outdated quota it would mislead.
  const stale = renderBar('H', 80, { stale: true, marker: 0.5 });
  check('stale bar draws no marker', cellsOf(stale) === '██████░░', cellsOf(stale));

  // Danger styling (bold, warn glyph) is unaffected and the marker still shows.
  const hot = stripAnsi(renderBar('W', 97, { marker: 0.5 }));
  check('marker coexists with the 95%+ warn styling', hot.includes('⚠') && hot.includes('W97 ') && hot.includes(MARK), hot);

  check('a non-finite fill still yields null', renderBar('H', NaN, { marker: 0.5 }) === null, 'expected null');

  // NO_COLOR proof: a real child process with colors off must still show the marker, with no escapes.
  const child = spawnSync(process.execPath, ['-e',
    "const {renderBar}=require(process.argv[1]);process.stdout.write(renderBar('H',97,{marker:0.5}))",
    path.join(ROOT, 'lib', 'bar.js')], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 10000,
  });
  const out = child.stdout || '';
  check('marker still shows with NO_COLOR and emits no escapes', out.includes(MARK) && !/\x1b/.test(out), JSON.stringify(out));
}

// ---- Pace marker wired into the 5-hour and weekly segments -----------------
// resets_at in every fixture is in the past, so these build reset times from the
// real clock. Offsets sit mid-cell so the few milliseconds a run takes can never
// push a marker across a boundary.
function runPaceMarkerWiringTests() {
  const { renderFiveHourSegment, renderWeeklySegment } = require('../lib/segments/rateLimits');
  const { stripAnsi } = require('../lib/colors');
  const HOUR = 60 * 60 * 1000;
  const MARK = '┃';
  const barOf = (s) => { const m = /([█░┃]{8})/.exec(stripAnsi(String(s))); return m ? m[1] : ''; };
  const markAt = (s) => barOf(s).indexOf(MARK);
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok    pace marker wiring: ${name}`);
    else fail(`pace marker wiring: ${name}`, detail);
  };
  const ctx = (entry, extra) => ({ usage: { fiveHour: entry, weekly: entry, stale: false, ...extra } });
  const entry = (percentage, remainingMs) => ({ percentage, resetsAtMs: remainingMs == null ? null : Date.now() + remainingMs });

  // 5h window, 2.1875h left => 0.5625 elapsed => 4.5 cells => cell 4.
  const mid = renderFiveHourSegment(ctx(entry(40, 2.1875 * HOUR)));
  check('5h bar shows the marker at the elapsed position', markAt(mid) === 4, JSON.stringify(stripAnsi(mid)));
  check('5h bar keeps width 8 and exactly one marker', barOf(mid).length === 8 && barOf(mid).split(MARK).length === 2, barOf(mid));
  check('countdown text is still shown', /↺ 2h/.test(stripAnsi(mid)), stripAnsi(mid));
  check('the rounded percentage is unchanged', stripAnsi(mid).startsWith('H40 '), stripAnsi(mid));

  // The same reset time means different things for different windows. 4.5h left is
  // early in a 5h window (0.1 elapsed => cell 0) and nearly at the end of a 7d one
  // (0.973 elapsed => cell 7).
  const shared = entry(40, 4.5 * HOUR);
  const h = renderFiveHourSegment({ usage: { fiveHour: shared, weekly: null, stale: false } });
  const w = renderWeeklySegment({ usage: { fiveHour: null, weekly: shared, stale: false } });
  check('5h window: 4.5h left is early (cell 0)', markAt(h) === 0, JSON.stringify(stripAnsi(h)));
  check('weekly window: the same 4.5h left is late (cell 7)', markAt(w) === 7, JSON.stringify(stripAnsi(w)));
  check('weekly label is W', stripAnsi(w).startsWith('W40 '), stripAnsi(w));

  // No marker when the position cannot be known.
  const none = (label, seg, e) => check(label, !seg.includes(MARK) && barOf(seg).length === 8, JSON.stringify(stripAnsi(seg)));
  none('no marker without a reset time', renderFiveHourSegment(ctx(entry(40, null))));
  none('no marker when the reset is already past', renderFiveHourSegment(ctx(entry(40, -HOUR))));
  none('no marker when the reset is farther out than the window', renderFiveHourSegment(ctx(entry(40, 6 * HOUR))));
  none('no marker on the stale (cached) path', renderFiveHourSegment(ctx(entry(40, 2.1875 * HOUR), { stale: true })));

  // Degradation contract: a segment returns null instead of throwing.
  check('a missing entry still renders nothing', renderFiveHourSegment({ usage: { fiveHour: null, weekly: null } }) === null, 'expected null');
  check('a missing usage still renders nothing', renderFiveHourSegment({}) === null, 'expected null');

  // Through the real binary, with colors on and off.
  const nowS = Math.floor(Date.now() / 1000);
  const payload = (extra) => inlinePayload({
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
    effort: { level: 'high' },
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: nowS + Math.round(2.1875 * 3600) },
      seven_day: { used_percentage: 20, resets_at: nowS + Math.round(3.5 * 24 * 3600) },
    },
    ...extra,
  });
  runInline('binary: both bars carry a marker', payload(), { expect: [MARK], refute: ['NaN', 'undefined'] });
  const res = spawnRender(JSON.stringify(payload()));
  const markers = (res.stdout.match(/┃/g) || []).length;
  check('binary: exactly two markers (5h and weekly)', markers === 2, `found ${markers} in ${JSON.stringify(stripAnsi(res.stdout))}`);
  runInline('binary: marker survives NO_COLOR with no escapes', payload(), { expect: [MARK], refute: [ESC + '['] }, { NO_COLOR: '1' });
}

// ---- Pace-aware coloring (opt-in `paceColors`) ------------------------------
// Pace is never calmer than the plain ramp at the same moment: the elapsed fraction is
// at most 1, so used/elapsed is never below used. It is capped below the bold/warn
// thresholds so only real consumption shouts.
function runPaceColorTests() {
  const { paceRampPct, PACE_DEADBAND, PACE_CAP } = require('../lib/usage');
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok    pace colors: ${name}`);
    else fail(`pace colors: ${name}`, detail);
  };
  if (typeof paceRampPct !== 'function') return fail('pace colors', 'lib/usage.js does not export paceRampPct');

  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
  check('exposes the deadband and cap', PACE_DEADBAND === 0.1 && PACE_CAP === 84, `${PACE_DEADBAND} / ${PACE_CAP}`);
  check('burning fast raises a calm bar to the cap (40% used, 20% elapsed)', paceRampPct(40, 0.2) === 84, String(paceRampPct(40, 0.2)));
  check('moderate pace projects honestly (10% used, 50% elapsed -> 20)', near(paceRampPct(10, 0.5), 20), String(paceRampPct(10, 0.5)));
  check('near the end it matches absolute (80% used, 97% elapsed)', near(paceRampPct(80, 0.97), 80 / 0.97), String(paceRampPct(80, 0.97)));
  check('never lowers real consumption (90% used stays 90)', paceRampPct(90, 0.5) === 90, String(paceRampPct(90, 0.5)));
  check('the deadband boundary itself applies', paceRampPct(40, 0.1) === 84, String(paceRampPct(40, 0.1)));
  check('below the deadband falls back to absolute (null)', paceRampPct(40, 0.09) === null, String(paceRampPct(40, 0.09)));
  check('zero used stays zero', paceRampPct(0, 0.5) === 0, String(paceRampPct(0, 0.5)));
  for (const [label, p, f] of [['NaN percent', NaN, 0.5], ['null fraction', 40, null], ['NaN fraction', 40, NaN],
    ['fraction above 1', 40, 1.2], ['string fraction', 40, '0.5'], ['zero fraction', 40, 0], ['negative fraction', 40, -0.2]]) {
    check(`unusable input (${label}) gives null`, paceRampPct(p, f) === null, String(paceRampPct(p, f)));
  }

  // Property: never below the real percentage, never above max(real, cap).
  let prop = true;
  let propDetail = '';
  for (let p = 0; p <= 100 && prop; p += 2.5) {
    for (let f = 0.1; f <= 1.0001 && prop; f += 0.05) {
      const v = paceRampPct(p, Math.min(1, f));
      if (!(v >= p && v <= Math.max(p, PACE_CAP))) { prop = false; propDetail = `pct=${p} f=${f} -> ${v}`; }
    }
  }
  check('result is always within [pct, max(pct, cap)]', prop, propDetail);

  // renderBar: rampPct changes only the color the ramp is read at.
  const child = (expr) => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    const r = spawnSync(process.execPath, ['-e',
      `const B=require(process.argv[1]+'/lib/bar.js');process.stdout.write(JSON.stringify(${expr}))`, ROOT],
    { encoding: 'utf8', env, timeout: 10000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  const GREEN = sgr([96, 200, 120]);
  const ORANGE = sgr([239, 159, 39]);
  const RED = sgr([232, 67, 61]);
  const BOLDSEQ = ESC + '[1m';
  const out = child(`[B.renderBar('H',40,{}), B.renderBar('H',40,{rampPct:84}), B.renderBar('H',40,{rampPct:30}),
    B.renderBar('H',90,{rampPct:84}), B.renderBar('H',40,{rampPct:NaN}), B.renderBar('H',40,{rampPct:'84'}),
    B.renderBar('H',40,{rampPct:null}), B.renderBar('H',40,{stale:true,rampPct:84}), B.renderBar('H',40,{rampPct:1000})]`);
  if (!out || out.length !== 9) return fail('pace colors: renderBar child', JSON.stringify(out));
  const [plain, raised, lower, absolute, nan, str, nul, stale, huge] = out;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  check('baseline 40% is green', plain.startsWith(GREEN), JSON.stringify(plain));
  check('rampPct 84 reads orange', raised.startsWith(ORANGE + 'H40 '), JSON.stringify(raised));
  check('raised bar is not bold and has no warn glyph', !raised.includes(BOLDSEQ) && !raised.includes('⚠'), JSON.stringify(raised));
  check('rampPct below the real value never lowers it', lower.startsWith(GREEN), JSON.stringify(lower));
  check('real 90% stays bold red despite a lower rampPct', absolute.startsWith(BOLDSEQ + RED), JSON.stringify(absolute));
  check('NaN, string and null rampPct are ignored', [nan, str, nul].every((s) => s.startsWith(GREEN)), JSON.stringify([nan, str, nul]));
  check('stale bars ignore rampPct', !stale.includes(ORANGE) && stale.startsWith(ESC + '[2m'), JSON.stringify(stale));
  check('an oversized rampPct simply reads as the top step', huge.includes('⚠'), JSON.stringify(huge));
  check('the number and fill are unchanged by rampPct', strip(raised) === strip(plain), `${strip(raised)} vs ${strip(plain)}`);

  // Config: a plain boolean, default off, bad values corrected silently.
  const { validateAndMerge, DEFAULT_CONFIG } = require('../lib/config');
  check('paceColors defaults to false', DEFAULT_CONFIG.paceColors === false, String(DEFAULT_CONFIG.paceColors));
  check('paceColors true is kept', validateAndMerge({ paceColors: true }).paceColors === true, 'expected true');
  for (const bad of ['yes', 1, null, {}, []]) {
    check(`paceColors ${JSON.stringify(bad)} falls back to false`, validateAndMerge({ paceColors: bad }).paceColors === false, 'expected false');
  }

  // Through the real binary, 50% used with 20% of the 5h window elapsed.
  const nowS = Math.floor(Date.now() / 1000);
  const paced = (usedPct, remainingH) => inlinePayload({
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
    effort: { level: 'high' },
    rate_limits: { five_hour: { used_percentage: usedPct, resets_at: nowS + Math.round(remainingH * 3600) } },
  });
  const withPace = (home) => fs.writeFileSync(path.join(home, '.amplinerc.json'), JSON.stringify({ paceColors: true }) + '\n', 'utf8');
  runInline('binary: paceColors on raises a fast-burning 40% bar to orange', paced(40, 4),
    { expect: [ORANGE + 'H40 '], refute: ['NaN', 'undefined', BOLDSEQ + ORANGE] }, {}, withPace);
  runInline('binary: paceColors off leaves the same 40% bar green', paced(40, 4),
    { expect: [GREEN + 'H40 '], refute: [ORANGE + 'H40 '] });
  runInline('binary: inside the deadband it stays on the absolute ramp', paced(40, 4.75),
    { expect: [GREEN + 'H40 '], refute: [ORANGE + 'H40 '] }, {}, withPace);
  runInline('binary: pace never lowers a real 90%', paced(90, 2.5),
    { expect: [BOLDSEQ + RED], refute: ['NaN'] }, {}, withPace);
  runInline('binary: paceColors keeps the marker and width', paced(40, 4),
    { expect: ['┃', ORANGE + 'H40 '] }, {}, withPace);

  // The weekly bar is wired separately from the 5-hour one (it has its own window).
  // 40% used with 20% of the 7-day window gone is the same fast-burn shape.
  const weeklyOnly = (usedPct, remainingDays) => inlinePayload({
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
    effort: { level: 'high' },
    rate_limits: { seven_day: { used_percentage: usedPct, resets_at: nowS + Math.round(remainingDays * 86400) } },
  });
  runInline('binary: paceColors raises a fast-burning weekly bar to orange', weeklyOnly(40, 5.6),
    { expect: [ORANGE + 'W40 '], refute: [BOLDSEQ + ORANGE, 'NaN'] }, {}, withPace);
  runInline('binary: weekly stays on the absolute ramp with paceColors off', weeklyOnly(40, 5.6),
    { expect: [GREEN + 'W40 '], refute: [ORANGE + 'W40 '] });

  // Pins the real-percentage boundary: color must follow the UNROUNDED value, so a real
  // 84.6 with a pace value of 84 stays orange rather than rounding to 85 and turning bold red.
  const edge = child(`[B.renderBar('H',84.6,{rampPct:84}), B.renderBar('H',84.6,{})]`);
  check('real 84.6 with pace stays orange, not bold', Array.isArray(edge) && edge.every((s) => s.startsWith(ORANGE) && !s.includes(BOLDSEQ)), JSON.stringify(edge));

  // A segment handed config that never went through validateAndMerge must still
  // only act on a literal `true`.
  const segChild = (config) => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    const reset = Date.now() + 4 * 60 * 60 * 1000;
    const r = spawnSync(process.execPath, ['-e',
      `const S=require(process.argv[1]+'/lib/segments/rateLimits.js');
       process.stdout.write(JSON.stringify(S.renderFiveHourSegment({usage:{fiveHour:{percentage:40,resetsAtMs:${reset}},weekly:null,stale:false},config:${JSON.stringify(config)}})))`, ROOT],
    { encoding: 'utf8', env, timeout: 10000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  check('segment given paceColors: true uses pace', String(segChild({ paceColors: true })).startsWith(ORANGE), JSON.stringify(segChild({ paceColors: true })));
  for (const loose of ['yes', 1, 'true', {}]) {
    const seg = segChild({ paceColors: loose });
    check(`segment given non-boolean paceColors ${JSON.stringify(loose)} ignores pace`, String(seg).startsWith(GREEN), JSON.stringify(seg));
  }
  check('segment with no config ignores pace', String(segChild(undefined)).startsWith(GREEN), JSON.stringify(segChild(undefined)));

  // End to end: usage that came from the cache is stale, so neither pace color nor
  // the marker may appear even with paceColors on.
  const seedCache = (home) => {
    withPace(home);
    const dir = path.join(home, '.claude', 'cache', 'ampline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'usage.json'),
      JSON.stringify({ fiveHour: { percentage: 40, resetsAtMs: Date.now() + 4 * 3600 * 1000 }, weekly: null }), 'utf8');
  };
  runInline('binary: cached (stale) usage ignores pace color and marker even with paceColors on',
    inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, effort: { level: 'high' } }),
    { expect: [ESC + '[2mH40 '], refute: [ORANGE, '┃', 'NaN', 'undefined'] }, {}, seedCache);
}

// ---- Pace hardening: integration seams and hostile input ---------------------
// The unit and wiring tests pin the math. These pin the seams around it: the other
// ways Claude Code can spell a reset time, the config path that strips ANSI after
// the fact, layout, and a seeded fuzz of the segment's own inputs.
function runPaceHardeningTests() {
  const { visibleWidth } = require('../lib/layout');
  const { stripAnsi } = require('../lib/colors');
  const { renderFiveHourSegment, renderWeeklySegment } = require('../lib/segments/rateLimits');
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok    pace hardening: ${name}`);
    else fail(`pace hardening: ${name}`, detail);
  };
  const MARK = '┃';
  const H = 60 * 60 * 1000;
  const mk = (resetsAt, used = 40) => inlinePayload({
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
    effort: { level: 'high' },
    rate_limits: { five_hour: { used_percentage: used, resets_at: resetsAt } },
  });

  // `"color": false` strips ANSI after rendering, so a glyph marker must survive it
  // while every escape goes.
  const colorOff = (home) => fs.writeFileSync(path.join(home, '.amplinerc.json'),
    JSON.stringify({ color: false, paceColors: true }) + '\n', 'utf8');
  runInline('binary: marker survives "color": false with no escapes',
    mk(Math.floor((Date.now() + 2.1875 * H) / 1000)),
    { expect: [MARK], refute: [ESC + '[', 'NaN', 'undefined'] }, {}, colorOff);

  // Claude Code documents epoch seconds; the repo also accepts milliseconds and ISO text
  // (toMs). The marker must work for every spelling that gets a countdown.
  const target = Date.now() + 2.1875 * H;
  runInline('binary: resets_at as epoch milliseconds still draws the marker',
    mk(Math.round(target)), { expect: [MARK, '↺'], refute: ['NaN'] });
  runInline('binary: resets_at as an ISO string still draws the marker',
    mk(new Date(target).toISOString()), { expect: [MARK, '↺'], refute: ['NaN'] });
  runInline('binary: resets_at as a numeric string still draws the marker',
    mk(String(Math.floor(target / 1000))), { expect: [MARK, '↺'], refute: ['NaN'] });
  runInline('binary: unparseable resets_at draws no marker and does not crash',
    mk('next tuesday'), { refute: [MARK, 'NaN', 'undefined'] });

  // The marker replaces a cell, so it must not change line width or the wrap decision.
  // Same payload shape, one reset inside the 5h window (marker) and one beyond it (none).
  const widthOf = (resetsAt, columns) => {
    const r = spawnRender(JSON.stringify(mk(resetsAt)), { env: { NO_COLOR: '1', COLUMNS: String(columns) } });
    const lines = (r.stdout || '').replace(/\n$/, '').split('\n');
    return { lines: lines.length, widths: lines.map((l) => visibleWidth(l)), hasMark: (r.stdout || '').includes(MARK) };
  };
  const nowS = Math.floor(Date.now() / 1000);
  for (const columns of [200, 120, 80]) {
    const withMark = widthOf(nowS + Math.round(2.1875 * 3600), columns);
    const without = widthOf(nowS + 6 * 3600, columns);
    check(`marker present only inside the window (COLUMNS=${columns})`, withMark.hasMark && !without.hasMark,
      JSON.stringify({ withMark, without }));
    check(`marker changes neither width nor line count (COLUMNS=${columns})`,
      withMark.lines === without.lines && JSON.stringify(withMark.widths) === JSON.stringify(without.widths),
      JSON.stringify({ withMark, without }));
  }

  // Seeded fuzz of everything the segment is handed. Output must be null or a clean
  // string with exactly one 8-cell bar and at most one marker.
  let seed = 0x9e3779b9;
  const rand = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const now = Date.now();
  const pcts = [0, 0.4, 7.5, 50, 84.6, 99.5, 100, 150, -5, -0, NaN, Infinity, '40', null, undefined, {}, [], true, 1e308];
  const resets = [null, undefined, NaN, Infinity, -Infinity, 0, -1, now - H, now + 1000, now + H, now + 2.1875 * H,
    now + 2.5 * H, now + 3 * H, now + 4 * H, now + 5 * H, now + 6 * H, now + 7 * 24 * H, now + 3.5 * 24 * H,
    now + 100 * 24 * H, 1e308, '123', {}, [], true];
  // Weighted toward well-formed entries and live (non-stale) usage, so the interesting
  // marker paths are reached often; the hostile shapes still appear in every run.
  const entries = (p, r) => (rand() < 0.6
    ? { percentage: p, resetsAtMs: r }
    : pick([null, undefined, 5, 'x', {}, [], { percentage: p }, { resetsAtMs: r }]));
  const stales = [false, false, false, false, undefined, true, 'yes', 0, 1, null];
  const configs = [undefined, null, {}, { paceColors: true }, { paceColors: false }, { paceColors: 'yes' }, 'x', 5, []];
  let bad = '';
  let produced = 0;
  let marked = 0;
  for (let i = 0; i < 4000 && !bad; i++) {
    const p = pick(pcts), r = pick(resets);
    const ctx = { usage: { fiveHour: entries(p, r), weekly: entries(p, r), stale: pick(stales) }, config: pick(configs) };
    for (const fn of [renderFiveHourSegment, renderWeeklySegment]) {
      let out;
      try { out = fn(ctx); } catch (e) { bad = `threw: ${e.message} for ${JSON.stringify(ctx)}`; break; }
      if (out === null) continue;
      if (typeof out !== 'string') { bad = `non-string ${typeof out}`; break; }
      const plain = stripAnsi(out);
      produced++;
      if (/NaN|undefined|Infinity|\[object/.test(plain)) { bad = `junk in ${JSON.stringify(plain)} for ${JSON.stringify(ctx)}`; break; }
      const bars = plain.match(/[█░┃]{8}/g) || [];
      if (bars.length !== 1 || !/[█░┃]/.test(bars[0]) || (bars[0].split(MARK).length - 1) > 1) {
        bad = `bad bar in ${JSON.stringify(plain)} for ${JSON.stringify(ctx)}`; break;
      }
      if (plain.includes(MARK)) marked++;
    }
  }
  check('fuzz: 4000 hostile inputs never produce junk, a wrong width, or two markers', !bad, bad);
  check('fuzz: it actually exercised rendered bars and markers (not vacuous)', produced > 1000 && marked >= produced * 0.05,
    `produced=${produced} marked=${marked}`);
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
  runPaceTests();
  runBarMarkerTests();
  runPaceMarkerWiringTests();
  runPaceColorTests();
  runPaceHardeningTests();

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
