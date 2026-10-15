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
  // Rows are JSON lines now (see runSubagentContractTests), so the escape bytes live
  // inside the parsed `content` string rather than raw in stdout.
  const subRowCheck = (name, extra, want, refuteSgr) => {
    const { res, rows } = subagentRun(subTask(extra));
    const content = rows[0] && typeof rows[0].content === 'string' ? rows[0].content : '';
    const ok = res.status === 0 && content.includes(want) &&
      !refuteSgr.some((x) => content.includes(x)) && !/NaN|undefined/.test(content);
    if (ok) console.log(`  ok    ${name}`);
    else fail(name, `content=${JSON.stringify(content)} stdout=${JSON.stringify(res.stdout)}`);
  };
  subRowCheck('haiku subagent row with effort follows the ramp', { effort: 'low' }, sgr(HAIKU_RAMP.low), []);
  subRowCheck('haiku subagent row without effort stays flat blue', {}, sgr(HAIKU_FLAT), [sgr(HAIKU_RAMP.low)]);
  subRowCheck('haiku subagent row with numeric budget stays flat blue', { effort: 12000 }, sgr(HAIKU_FLAT), [sgr(HAIKU_RAMP.low)]);

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

// ---- subagentStatusLine output contract ------------------------------------
// Claude Code documents the command's OUTPUT as one JSON line per row,
// {"id": "<task id>", "content": "<row body>"}. A row with no id keeps the default
// rendering, so a bare text line is silently ignored. Earlier versions printed bare
// text rows; nothing checked the output shape (only the input payload was captured).
function subagentRun(payload, { env, raw } = {}) {
  const res = spawnRender(raw !== undefined ? raw : JSON.stringify(payload), { args: [BIN, '--subagent'], env });
  const lines = (res.stdout || '').split('\n').filter((l) => l.length > 0);
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return { __invalid: l }; } });
  return { res, lines, rows, raw: res.stdout || '' };
}

function runSubagentContractTests() {
  const { renderSubagentLine, renderTaskRow } = require('../lib/segments/subagents');
  const check = (name, ok, detail) => {
    if (ok) console.log('  ok    subagent contract: ' + name);
    else fail('subagent contract: ' + name, detail);
  };
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'subagent-tasks.json'), 'utf8'));
  const ids = fixture.tasks.map((t) => t.id);
  const stripSgr = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

  // The real captured payload, through the real binary.
  const { res, lines, rows, raw } = subagentRun(fixture);
  check('exits 0', res.status === 0, String(res.status));
  check('every output line is valid JSON', rows.length > 0 && rows.every((r) => !r.__invalid), JSON.stringify(lines));
  check('each row has exactly the keys id and content, both strings',
    rows.every((r) => Object.keys(r).sort().join() === 'content,id' && typeof r.id === 'string' && typeof r.content === 'string'),
    JSON.stringify(rows));
  check('one row per task, ids echoed in order', JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(ids),
    JSON.stringify(rows.map((r) => r.id)));
  check('no raw escape byte reaches stdout (it is JSON-escaped)', !(res.stdout || '').includes(ESC), JSON.stringify(res.stdout));
  check('output is newline-terminated', (res.stdout || '').endsWith('\n'), JSON.stringify((res.stdout || '').slice(-12)));
  // Expected rows come from a child with colors on, so a developer's exported NO_COLOR
  // cannot make an in-process module disagree with the (NO_COLOR-scrubbed) child output.
  const expectedRows = (() => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    const r = spawnSync(process.execPath, ['-e',
      "const {renderTaskRow}=require(process.argv[1]+'/lib/segments/subagents.js');" +
      "const f=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));" +
      'process.stdout.write(JSON.stringify(f.tasks.map((t)=>renderTaskRow(t,f.columns))))',
      ROOT, path.join(FIXTURES, 'subagent-tasks.json')], { encoding: 'utf8', env, timeout: 10000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  })();
  check('each content is the row text renderTaskRow produces',
    Array.isArray(expectedRows) && rows.length === expectedRows.length && rows.every((r, i) => r.content === expectedRows[i]),
    JSON.stringify({ got: rows.map((r) => r.content), want: expectedRows }));

  // A blank line between rows, a CR, or a pretty-printed object would all still "parse" after
  // filtering, so pin the raw bytes: each row is exactly one line, and the id comes first.
  const rawLines = raw.split('\n');
  check('no blank line between or after rows', raw.length > 0 && rawLines.pop() === '' && rawLines.every((l) => l.length > 0),
    JSON.stringify(raw.slice(0, 200)));
  check('no carriage return anywhere', !raw.includes('\r'), JSON.stringify(raw.slice(0, 120)));
  check('each line is a compact object that starts with the id', rawLines.every((l) => l.startsWith('{"id":"') && l.endsWith('}')),
    JSON.stringify(rawLines));
  const contents = rows.map((r) => (typeof r.content === 'string' ? r.content : ''));
  check('content carries the label and no payload noise',
    contents.length > 0 && contents.every((c) => c.includes('Payload capture') || c.includes('Numeric effort')) &&
    contents.every((c) => !/local_agent|NaN|undefined/.test(c)), JSON.stringify(contents));

  // Rows that cannot be matched back to a task keep Claude Code's default rendering.
  const t = (extra) => ({ id: 'x', status: 'running', label: 'w', model: 'claude-sonnet-5-5', tokenCount: 10, ...extra });
  const mixed = subagentRun({ columns: 120, tasks: [t({ id: 'keep-1' }), t({ id: undefined }), t({ id: '' }),
    t({ id: 42 }), t({ id: null }), null, 'junk', 7, t({ id: 'keep-2' })] });
  check('tasks without a usable id are omitted, the rest kept in order',
    JSON.stringify(mixed.rows.map((r) => r.id)) === JSON.stringify(['keep-1', 'keep-2']), JSON.stringify(mixed.lines));

  // Display name: label, then description, then name, then agentType, then a constant.
  const nameOf = (extra) => {
    const r = subagentRun({ columns: 120, tasks: [{ id: 'n', status: 'running', ...extra }] }).rows[0];
    return r && typeof r.content === 'string' ? stripSgr(r.content) : '';
  };
  check('label wins', nameOf({ label: 'LBL', description: 'DSC', name: 'NM', agentType: 'AT' }).includes('LBL'), nameOf({ label: 'LBL' }));
  check('description is next', nameOf({ description: 'DSC', name: 'NM', agentType: 'AT' }).includes('DSC'), nameOf({ description: 'DSC' }));
  check('then name', nameOf({ name: 'NM', agentType: 'AT' }).includes('NM'), nameOf({ name: 'NM' }));
  check('then agentType', nameOf({ agentType: 'code-reviewer' }).includes('code-reviewer'), nameOf({ agentType: 'code-reviewer' }));
  check('then the constant', nameOf({}).includes('agent'), nameOf({}));

  // Nothing to say means saying nothing: no blank line for the parser to trip on.
  for (const [label, payload] of [['empty tasks', { columns: 120, tasks: [] }], ['no tasks key', { columns: 120 }],
    ['tasks not an array', { columns: 120, tasks: 'x' }], ['all rows unusable', { columns: 120, tasks: [null, { label: 'no id' }] }]]) {
    const r = subagentRun(payload);
    check(label + ': writes nothing, exits 0', r.res.status === 0 && r.res.stdout === '', JSON.stringify(r.res.stdout));
  }
  for (const [label, raw] of [['malformed stdin', '{not json'], ['empty stdin', ''], ['JSON null', 'null'], ['JSON array', '[1,2]']]) {
    const r = subagentRun(null, { raw });
    check(label + ': writes nothing, exits 0', r.res.status === 0 && r.res.stdout === '', JSON.stringify(r.res.stdout));
  }

  // Foreign strings: the contract is line based, so a newline in a label must not split a row,
  // and escape sequences must not survive.
  const evil = 'ok' + ESC + ']0;pwned' + BEL + ESC + '[2J\nINJECTED\u2028LINE' + String.fromCharCode(0x9b) + '31m';
  const hostile = subagentRun({ columns: 120, tasks: [t({ id: 'h1', label: evil, description: evil }), t({ id: 'h2', label: 'after' })] });
  check('a hostile label yields exactly one line per task', hostile.lines.length === 2, JSON.stringify(hostile.lines));
  check('hostile label rows are still valid JSON with the right ids',
    hostile.rows.length === 2 && hostile.rows[0].id === 'h1' && hostile.rows[1].id === 'h2', JSON.stringify(hostile.rows));
  const c0 = (hostile.rows[0] && hostile.rows[0].content) || '';
  check('no OSC title or clear-screen sequence survives in content',
    !c0.includes(ESC + ']0;') && !c0.includes(ESC + '[2J') && !c0.includes(BEL), JSON.stringify(c0));
  check('no C1 control or line separator survives in content',
    !/[\u0080-\u009f\u2028\u2029]/.test(c0), JSON.stringify(c0));

  // Colors off: still JSON, and content has no escapes at all.
  const plain = subagentRun(fixture, { env: { NO_COLOR: '1' } });
  check('NO_COLOR rows are valid JSON with escape-free content',
    plain.rows.length === ids.length && plain.rows.every((r) => !r.__invalid && !r.content.includes(ESC)), JSON.stringify(plain.lines));

  // Many rows stay one line each.
  const many = subagentRun({ columns: 100, tasks: Array.from({ length: 200 }, (_, i) => t({ id: 'id-' + i, label: 'task ' + i })) });
  check('200 tasks give 200 lines in order',
    many.rows.length === 200 && many.rows.every((r, i) => r.id === 'id-' + i), String(many.rows.length));

  // Every field that reaches the row is foreign. `model` is rendered as text, and Claude Code
  // renders content as-is (OSC 8 links included), so an escape in it must not survive.
  const mod = (model) => {
    const r = subagentRun({ columns: 120, tasks: [t({ id: 'm1', model })] });
    return { r, c: (r.rows[0] && typeof r.rows[0].content === 'string') ? r.rows[0].content : '' };
  };
  const hostileModels = {
    'OSC 8 link opener': ESC + ']8;;http://evil.example' + BEL + 'x',
    'clear screen and home': ESC + '[2J' + ESC + '[H',
    'C1 CSI': String.fromCharCode(0x9b) + '31m',
    'object form with id': { id: ESC + ']8;;http://evil.example' + BEL + 'x' },
    'object form with display_name': { display_name: ESC + '[2J' },
    'NUL and BEL': 'a' + String.fromCharCode(0) + BEL + 'b',
  };
  for (const [label, model] of Object.entries(hostileModels)) {
    const { r, c } = mod(model);
    check('hostile model (' + label + ') leaves no escape beyond our own colors',
      r.rows.length === 1 && c.length > 0 && !c.includes(ESC + ']') && !c.includes(ESC + '[2J') && !c.includes(BEL) &&
      !/[\u0080-\u009f]/.test(c) && !/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/.test(stripSgr(c)),
      JSON.stringify(c));
  }

  // status is a lookup key: names that exist on Object.prototype must not resolve to a color.
  for (const status of ['constructor', 'CONSTRUCTOR', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const c = (subagentRun({ columns: 120, tasks: [t({ id: 's1', status })] }).rows[0] || {}).content || '';
    check('status "' + status + '" is not a color', c.includes('↳') && !/function|\[object|native code|undefined/.test(c),
      JSON.stringify(c));
  }

  // The name is cut to a budget (32 cells at 120 columns), ending in an ellipsis.
  const longName = (subagentRun({ columns: 120, tasks: [t({ id: 'l1', label: 'x'.repeat(100) })] }).rows[0] || {}).content || '';
  const shown = stripSgr(longName);
  check('a long label is truncated to the budget with an ellipsis',
    shown.includes('x'.repeat(31) + '…') && !shown.includes('x'.repeat(33)), JSON.stringify(shown));

  // The id is echoed from the payload and never rendered, but a line-based reader may split on
  // the Unicode line separators, so they are escaped in the JSON text rather than left raw.
  const sepId = 'a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x2029) + 'c';
  const sep = subagentRun({ columns: 120, tasks: [t({ id: sepId })] });
  check('line separators in an id are escaped, and the id round-trips',
    sep.raw.length > 0 && !sep.raw.includes(String.fromCharCode(0x2028)) && !sep.raw.includes(String.fromCharCode(0x2029)) &&
    sep.rows.length === 1 && sep.rows[0].id === sepId, JSON.stringify(sep.raw));

  // The function itself, in process.
  const direct = renderSubagentLine({ columns: 120, tasks: [t({ id: 'd1' })] });
  check('renderSubagentLine returns newline-terminated JSON', typeof direct === 'string' && direct.endsWith('\n') &&
    JSON.parse(direct.trim()).id === 'd1', JSON.stringify(direct));
  check('renderSubagentLine returns an empty string for nothing',
    renderSubagentLine(null) === '' && renderSubagentLine({}) === '', 'expected empty');
}

// ---- Foreign strings must never reach stdout as control sequences ------------
// Every value below arrives from outside: the model (display names, todo text), the repo
// (branch names in .git/HEAD, directory names) or Claude Code itself. Terminal escape
// sequences are a live injection vector (CLAUDE.md), so the invariant is checked on the whole
// line: once our own SGR color codes are removed, no control sequence may remain.
function runInjectionTests() {
  const SGR = /\x1b\[[0-9;]*m/g;
  const C1 = new RegExp('[' + String.fromCharCode(0x80) + '-' + String.fromCharCode(0x9f) + ']');
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NUL = String.fromCharCode(0);
  const leaks = (out) => {
    const rest = String(out).replace(SGR, '');
    const found = [];
    if (rest.includes(ESC)) found.push('ESC');
    if (rest.includes(BEL)) found.push('BEL');
    if (C1.test(rest)) found.push('C1');
    if (rest.includes(LS) || rest.includes(PS)) found.push('line-separator');
    if (rest.includes(NUL)) found.push('NUL');
    return found;
  };
  const HOSTILE = 'x' + ESC + ']0;pwned' + BEL + ESC + '[2J' + ESC + ']8;;http://evil.example' + BEL + 'y' +
    String.fromCharCode(0x9b) + '31m' + LS + 'z' + PS + NUL + 'end';
  const check = (name, ok, detail) => {
    if (ok) console.log('  ok    injection: ' + name);
    else fail('injection: ' + name, detail);
  };
  const render = (payload, extra) => {
    const r = spawnRender(JSON.stringify(payload), extra || {});
    return { r, out: r.stdout || '' };
  };
  // A hostile value must leave nothing behind, and the run must still be clean.
  const noLeak = (name, payload, extra) => {
    const { r, out } = render(payload, extra);
    const found = leaks(out);
    check(name + ': exits 0 with no control sequence in stdout', r.status === 0 && found.length === 0,
      JSON.stringify({ status: r.status, found, out: out.slice(0, 240) }));
    return out;
  };
  const plain = (out) => String(out).replace(SGR, '');

  // ---- dir ----
  noLeak('dir from workspace.repo.name', inlinePayload({ workspace: { repo: { name: HOSTILE }, current_dir: '/tmp/p' } }));
  noLeak('dir from the basename of current_dir', inlinePayload({ workspace: { current_dir: '/tmp/' + HOSTILE } }));
  noLeak('dir from cwd', inlinePayload({ cwd: '/tmp/' + HOSTILE }));
  for (const [label, name] of [['an object', { a: 1 }], ['an array', ['x']], ['a number', 5], ['a boolean', true]]) {
    const out = plain(noLeak('repo.name as ' + label, inlinePayload({ workspace: { repo: { name }, current_dir: '/tmp/realdir' } })));
    check('repo.name as ' + label + ' falls back to the directory name',
      out.includes('realdir') && !/\[object|\btrue\b/.test(out), JSON.stringify(out.slice(0, 160)));
  }
  for (const [label, current_dir] of [['a number', 5], ['an object', { a: 1 }], ['an array', ['/tmp/x']]]) {
    const out = plain(noLeak('current_dir as ' + label, inlinePayload({ workspace: { current_dir }, cwd: undefined })));
    check('current_dir as ' + label + ' does not print object text', !/\[object/.test(out), JSON.stringify(out.slice(0, 160)));
  }

  // ---- model ----
  noLeak('model.display_name', inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: HOSTILE } }));
  noLeak('model.id with no display_name', inlinePayload({ model: { id: HOSTILE } }));
  noLeak('effort.level', inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, effort: { level: HOSTILE } }));
  for (const [label, display_name] of [['an object', { a: 1 }], ['an array', ['x']], ['a number', 5], ['a boolean', true]]) {
    const out = plain(noLeak('display_name as ' + label, inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name } })));
    check('display_name as ' + label + ' falls back to the model id',
      /sonnet/i.test(out) && !/\[object|\btrue\b/.test(out), JSON.stringify(out.slice(0, 160)));
  }
  const noName = plain(noLeak('display_name object and no id', inlinePayload({ model: { display_name: { a: 1 } } })));
  check('an unusable model prints nothing for the model segment', !/\[object/.test(noName), JSON.stringify(noName.slice(0, 160)));

  // ---- cost: numbers from outside are digits, never e-notation or a stray sign ----
  const costOut = (cost) => plain(noLeak('cost ' + JSON.stringify(cost), inlinePayload({ cost })));
  const good = costOut({ total_cost_usd: 1.5, total_lines_added: 10, total_lines_removed: 2 });
  check('a normal cost still renders', good.includes('$1.50') && good.includes('+10') && good.includes('-2'), JSON.stringify(good));
  const badCosts = [
    ['a string', { total_cost_usd: '12.5' }, /12\.5/],
    ['e-notation', { total_cost_usd: 1e21 }, /e\+/],
    ['negative', { total_cost_usd: -5 }, /\$-/],
    ['absurdly large', { total_cost_usd: 1e15 }, /\$1000000000000000/],
  ];
  for (const [label, cost, bad] of badCosts) {
    const out = costOut(cost);
    check('cost as ' + label + ' is not printed', !bad.test(out), JSON.stringify(out.slice(0, 160)));
  }
  const badLines = [
    ['e-notation', { total_lines_added: 1e21, total_lines_removed: 0 }, /e\+/],
    ['negative', { total_lines_added: -3, total_lines_removed: -4 }, /\+-|--/],
    ['fractional', { total_lines_added: 1.5, total_lines_removed: 2.25 }, /1\.5|2\.25/],
    ['strings', { total_lines_added: '7', total_lines_removed: '9' }, /\+7|-9/],
  ];
  for (const [label, cost, bad] of badLines) {
    const out = costOut(cost);
    check('lines changed as ' + label + ' is not printed', !bad.test(out), JSON.stringify(out.slice(0, 160)));
  }

  // ---- context and rate limits ----
  const ctxStr = plain(noLeak('context used_percentage as a string', inlinePayload({ context_window: { used_percentage: '50' } })));
  check('a string percentage draws no context bar', !/C\d/.test(ctxStr), JSON.stringify(ctxStr.slice(0, 160)));
  noLeak('context used_percentage hostile', inlinePayload({ context_window: { used_percentage: HOSTILE } }));
  noLeak('rate limit fields hostile', inlinePayload({
    rate_limits: { five_hour: { used_percentage: HOSTILE, resets_at: HOSTILE }, seven_day: { used_percentage: HOSTILE, resets_at: HOSTILE } },
  }));

  // ---- git: a repository you did not write controls .git/HEAD ----
  const makeRepo = (headText) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-evil-repo-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), headText, 'utf8');
    return dir;
  };
  const evilRepos = [];
  try {
    // The branch is read with /^ref:\s*refs\/heads\/(.+)$/ and "." does not match U+2028 or
    // U+2029, so a name containing them is never read at all. A real attacker leaves those out,
    // and so must this test, or sanitize() is never reached and the test passes vacuously.
    const branchHostile = HOSTILE.split(LS).join('').split(PS).join('');
    const headRef = makeRepo('ref: refs/heads/' + branchHostile + '\n');
    evilRepos.push(headRef);
    const hostileOut = noLeak('branch name from a hostile .git/HEAD', inlinePayload({ workspace: { current_dir: headRef } }));
    const out = plain(hostileOut);
    check('the hostile branch name is actually rendered, as inert text',
      out.includes('⎇') && out.includes('pwned'), JSON.stringify(out.slice(0, 200)));
    check('the rendered branch carries no escape byte', !hostileOut.replace(SGR, '').includes(ESC), JSON.stringify(hostileOut.slice(0, 200)));

    const gitFile = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-evil-gitfile-'));
    evilRepos.push(gitFile);
    fs.writeFileSync(path.join(gitFile, '.git'), 'gitdir: ' + HOSTILE + '\n', 'utf8');
    noLeak('a .git file whose gitdir is hostile', inlinePayload({ workspace: { current_dir: gitFile } }));

    const detached = makeRepo(HOSTILE + '\n');
    evilRepos.push(detached);
    noLeak('a detached HEAD that is not a hash', inlinePayload({ workspace: { current_dir: detached } }));

    // The git segment picks its directory the same way the dir segment does: an unusable
    // current_dir must fall back to cwd rather than dropping the segment.
    const real = makeRepo('ref: refs/heads/feature-x\n');
    evilRepos.push(real);
    for (const [label, current_dir] of [['a number', 5], ['an object', { a: 1 }], ['an empty string', '']]) {
      const out = plain(noLeak('git with current_dir as ' + label, inlinePayload({ workspace: { current_dir }, cwd: real })));
      check('git falls back to cwd when current_dir is ' + label, out.includes('feature-x'), JSON.stringify(out.slice(0, 200)));
    }
  } finally {
    for (const d of evilRepos) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  // ---- task: todo text comes from model output ----
  const seedTodos = (home) => {
    const dir = path.join(home, '.claude', 'todos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'inj-session-agent-1.json'),
      JSON.stringify([{ status: 'in_progress', activeForm: HOSTILE, content: HOSTILE }]), 'utf8');
  };
  const todoOut = noLeak('todo text', inlinePayload({ session_id: 'inj-session' }), { seed: seedTodos });
  // The text is cut to 40 characters, so the tail ("end") is gone; what remains is inert text.
  check('the todo text segment still renders its visible part, inert', plain(todoOut).includes('pwned'),
    JSON.stringify(plain(todoOut).slice(0, 200)));

  // ---- session_id is a lookup key into ~/.claude/todos and into the cache ----
  const sessionIds = {
    'a parent-directory path': '../../etc/passwd',
    'a glob': 'a*?[]',
    'a path separator': 'x/y\\z',
    'hostile control bytes': HOSTILE,
    'an empty string': '',
    'a number': 12345,
    'an object': { a: 1 },
    'an array': ['a', 'b'],
    'a 5000 character string': 'a'.repeat(5000),
  };
  for (const [label, sid] of Object.entries(sessionIds)) {
    noLeak('session_id as ' + label, inlinePayload({ session_id: sid }), { seed: seedTodos });
  }

  // ---- everything at once, colors on and off ----
  const sink = inlinePayload({
    session_id: 'inj-session',
    cwd: '/tmp/' + HOSTILE,
    model: { id: HOSTILE, display_name: HOSTILE },
    effort: { level: HOSTILE },
    workspace: { current_dir: '/tmp/' + HOSTILE, repo: { name: HOSTILE } },
    context_window: { used_percentage: 55 },
    rate_limits: { five_hour: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 } },
    cost: { total_cost_usd: 2.5, total_lines_added: 3, total_lines_removed: 1 },
    pr: { number: 7, url: 'https://evil.example/' + HOSTILE, review_state: HOSTILE, kind: HOSTILE },
  });
  const loud = noLeak('kitchen sink, colors on', sink, { seed: seedTodos });
  check('kitchen sink still renders a line', plain(loud).length > 0, JSON.stringify(plain(loud)));
  const quiet = noLeak('kitchen sink, NO_COLOR', sink, { seed: seedTodos, env: { NO_COLOR: '1' } });
  check('kitchen sink under NO_COLOR has no escape byte at all', !quiet.includes(ESC), JSON.stringify(quiet.slice(0, 200)));
}

// ---- Follow-ups from the independent review of the injection suite --------------
// Several of these pin behavior that was correct but untested (the review's surviving
// mutants), and several are real defects it found: Number() coercion of rate limits, a cached
// non-string todo, session id prefix matching, an unbounded regex, and subagent type checks.
// Renders in sequence against ONE home, because the cache is exactly what several of them are about.
function renderSequence(payloads, { seed, env, cwd } = {}) {
  const home = makeTempHome();
  if (seed) seed(home);
  const base = { ...process.env };
  delete base.NO_COLOR;
  delete base.FORCE_COLOR;
  const results = [];
  try {
    for (const p of payloads) {
      const r = spawnSync(process.execPath, [BIN], {
        input: JSON.stringify(p), encoding: 'utf8', timeout: 20000, cwd,
        env: { ...base, HOME: home, USERPROFILE: home, COLUMNS: '200', ...(env || {}) },
      });
      results.push({ status: r.status, out: r.stdout || '' });
    }
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  return results;
}

function runInjectionFollowupTests() {
  const { visibleWidth } = require('../lib/layout');
  const SGR = /\x1b\[[0-9;]*m/g;
  const plain = (o) => String(o).replace(SGR, '');
  const check = (name, ok, detail) => {
    if (ok) console.log('  ok    review follow-up: ' + name);
    else fail('review follow-up: ' + name, detail);
  };
  const nowS = Math.floor(Date.now() / 1000);
  const DEL = String.fromCharCode(0x7f);
  const BELC = String.fromCharCode(7);
  const model = { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' };

  // F1: rate limits were coerced with Number(), so null, "", false and [] became a fabricated 0%.
  const rl = (used) => inlinePayload({ model, rate_limits: { five_hour: { used_percentage: used, resets_at: nowS + 3 * 3600 } } });
  for (const [label, used] of [['null', null], ['an empty string', ''], ['false', false], ['an empty array', []],
    ['true', true], ['a one-element array', [5]], ['a numeric string', '50'], ['a hex string', '0x1F'],
    ['an exponent string', '1e1'], ['a padded string', ' 7 '], ['an object', {}]]) {
    const [first, second] = renderSequence([rl(used), inlinePayload({ model })]);
    check('used_percentage as ' + label + ' draws no bar and leaves no cache behind',
      first.status === 0 && !/H\d/.test(plain(first.out)) && !/H\d/.test(plain(second.out)),
      JSON.stringify({ first: plain(first.out), second: plain(second.out) }));
  }
  const real = renderSequence([rl(42)])[0];
  check('a real number still draws the bar', /H42 /.test(plain(real.out)), JSON.stringify(plain(real.out)));
  const far = renderSequence([inlinePayload({ model, rate_limits: { five_hour: { used_percentage: 40, resets_at: nowS + 90 * 86400 } } })])[0];
  check('a reset more than 60 days out is not trusted: no countdown or marker, bar kept',
    /H40 /.test(plain(far.out)) && !/↺|┃/.test(plain(far.out)), JSON.stringify(plain(far.out)));

  // F2: a non-string todo was cached by the first render and printed by the second.
  const todoSeed = (value) => (home) => {
    const dir = path.join(home, '.claude', 'todos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fu-session-agent-1.json'), JSON.stringify([{ status: 'in_progress', activeForm: value }]), 'utf8');
  };
  const sidPayload = (sid) => inlinePayload({ session_id: sid, model });
  for (const [label, value] of [['an object', { a: 1 }], ['a number', 12345], ['a boolean', true], ['an array', ['x']]]) {
    const outs = renderSequence([sidPayload('fu-session'), sidPayload('fu-session'), sidPayload('fu-session')], { seed: todoSeed(value) });
    const joined = outs.map((o) => plain(o.out)).join(' || ');
    check('todo text as ' + label + ' never prints, on any render',
      outs.every((o) => o.status === 0) && !/\[object|12345|\btrue\b|\bx\b/.test(joined.replace(/Sonnet 5\.5/g, '')), JSON.stringify(joined));
  }
  const goodTodo = renderSequence([sidPayload('fu-session'), sidPayload('fu-session')], { seed: todoSeed('Run the tests') });
  check('a real todo still renders, fresh and from cache', goodTodo.every((o) => plain(o.out).includes('Run the tests')),
    JSON.stringify(goodTodo.map((o) => plain(o.out))));

  // F3: session ids select todo files by prefix and double as cache keys.
  const twoSessions = (home) => {
    const dir = path.join(home, '.claude', 'todos');
    fs.mkdirSync(dir, { recursive: true });
    const put = (name, text) => fs.writeFileSync(path.join(dir, name), JSON.stringify([{ status: 'in_progress', activeForm: text }]), 'utf8');
    put('aaaa1111-0000-4000-8000-000000000001-agent-aaaa1111-0000-4000-8000-000000000001.json', 'SECRET of session A');
    put('bbbb2222-0000-4000-8000-000000000002-agent-bbbb2222-0000-4000-8000-000000000002.json', 'SECRET of session B');
    put('x_1-agent-1.json', 'task of x_1');
    put('x:1-agent-1.json', 'task of x colon 1');
  };
  for (const sid of ['a', 'aaaa', 'b', 'aaaa1111', '']) {
    const o = renderSequence([sidPayload(sid)], { seed: twoSessions })[0];
    check('session_id ' + JSON.stringify(sid) + ' does not surface another session\'s task',
      o.status === 0 && !/SECRET/.test(plain(o.out)), JSON.stringify(plain(o.out)));
  }
  for (const [label, sid] of [['an array', ['a']], ['a number', 12345], ['an object', { a: 1 }]]) {
    const o = renderSequence([sidPayload(sid)], { seed: twoSessions })[0];
    check('session_id as ' + label + ' surfaces nothing', o.status === 0 && !/SECRET/.test(plain(o.out)), JSON.stringify(plain(o.out)));
  }
  const keyed = renderSequence([sidPayload('x_1'), sidPayload('x:1'), sidPayload('x/1')], { seed: twoSessions });
  check('ids that slug to the same cache key do not share a task',
    plain(keyed[0].out).includes('task of x_1') && !/task of x/.test(plain(keyed[1].out)) && !/task of x/.test(plain(keyed[2].out)),
    JSON.stringify(keyed.map((k) => plain(k.out))));
  const own = renderSequence([sidPayload('aaaa1111-0000-4000-8000-000000000001')], { seed: twoSessions })[0];
  check('the exact session id still finds its own task', plain(own.out).includes('SECRET of session A'), JSON.stringify(plain(own.out)));

  // F4: a name that is empty after cleaning must fall back, not print an empty colored segment.
  const emptyNames = [
    ['a BEL display_name', { id: 'claude-sonnet-5-5', display_name: BELC }],
    ['a lone "Claude " display_name', { id: 'claude-sonnet-5-5', display_name: 'Claude ' }],
    ['a whitespace display_name', { id: 'claude-sonnet-5-5', display_name: '    ' }],
  ];
  for (const [label, m] of emptyNames) {
    const o = renderSequence([inlinePayload({ model: m, workspace: { current_dir: '/tmp/realdir' } })])[0];
    const p = plain(o.out);
    check(label + ' falls back to the id and leaves no empty segment', /sonnet/i.test(p) && !/│\s*│/.test(p) && !/│\s*$/.test(p),
      JSON.stringify(p));
  }
  const blankRepo = renderSequence([inlinePayload({ model, workspace: { repo: { name: '   ' }, current_dir: '/tmp/realdir' } })])[0];
  check('a blank repo name falls back to the directory name', plain(blankRepo.out).startsWith('realdir'), JSON.stringify(plain(blankRepo.out)));
  for (const [label, text] of [['a control-only todo', BELC], ['a whitespace todo', '    ']]) {
    const o = renderSequence([sidPayload('fu-session')], { seed: todoSeed(text) })[0];
    const p = plain(o.out);
    check(label + ' is omitted, with no doubled or trailing separator', !/│\s*│/.test(p) && !/│\s*$/.test(p), JSON.stringify(p));
  }

  // F5: the subagent path took any type.
  const subPayload = (task) => ({ columns: 120, tasks: [{ id: 'a', status: 'running', ...task }] });
  const subContent = (task) => {
    const r = subagentRun(subPayload(task)).rows[0];
    return r && typeof r.content === 'string' ? plain(r.content) : '';
  };
  for (const [label, task] of [
    ['an object label', { label: { x: 1 } }], ['an array label', { label: ['hello'] }], ['a numeric description', { description: 12345 }],
    ['an object model id', { label: 'ok', model: { id: { y: 2 } } }], ['an object status', { label: 'ok', status: { z: 1 } }],
  ]) {
    const c = subContent(task);
    check('subagent ' + label + ' prints no object text, digits or booleans',
      c.length > 0 && !/\[object|hello|12345/.test(c), JSON.stringify(c));
  }
  for (const [label, tokenCount] of [['true', true], ['a numeric string', '5000'], ['an object', { n: 1 }], ['negative', -5]]) {
    const c = subContent({ label: 'ok', tokenCount });
    check('subagent tokenCount as ' + label + ' is not shown', !/\b1\b|5k|5000|-5/.test(c.replace('ok', '')), JSON.stringify(c));
  }
  check('a real token count still shows', /14k/.test(subContent({ label: 'ok', tokenCount: 14046 })), JSON.stringify(subContent({ label: 'ok', tokenCount: 14046 })));

  // F6: shortenModel used an unanchored regex that starts with \s*, quadratic on whitespace runs.
  for (const n of [100000, 400000]) {
    const t0 = Date.now();
    const o = renderSequence([inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: 'a' + ' '.repeat(n) } })])[0];
    const ms = Date.now() - t0;
    check('a ' + n + ' space display_name renders promptly', o.status === 0 && ms < 4000, 'status=' + o.status + ' ms=' + ms);
  }
  const ctxName = (dn) => plain(renderSequence([inlinePayload({ model: { id: 'claude-opus-5-5', display_name: dn } })])[0].out);
  check('a trailing context note is still removed', ctxName('Opus 4.5 (1M context)').includes('Opus 4.5 │') && !/context/.test(ctxName('Opus 4.5 (1M context)')),
    JSON.stringify(ctxName('Opus 4.5 (1M context)')));
  check('a context note mid-name is removed without leaving a double space', !/context|\s{2}/.test(ctxName('Claude Opus (200k context) 4.5').split('│')[1] || ''),
    JSON.stringify(ctxName('Claude Opus (200k context) 4.5')));

  // F9 and the length caps nothing pinned: dir, model, task and branch are all bounded.
  const longRepo = plain(renderSequence([inlinePayload({ model, workspace: { repo: { name: 'r'.repeat(500) }, current_dir: '/tmp/p' } })])[0].out);
  check('a very long repo name is capped with an ellipsis', longRepo.includes('r'.repeat(39) + '…') && !longRepo.includes('r'.repeat(41)),
    JSON.stringify(longRepo.slice(0, 120)));
  const longModel = plain(renderSequence([inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: 'm'.repeat(100) } })])[0].out);
  check('a very long model name is capped at 32', longModel.includes('m'.repeat(31) + '…') && !longModel.includes('m'.repeat(33)), JSON.stringify(longModel.slice(0, 120)));
  const longTask = plain(renderSequence([sidPayload('fu-session')], { seed: todoSeed('t'.repeat(200)) })[0].out);
  check('a very long todo is capped at 40', longTask.includes('t'.repeat(39) + '…') && !longTask.includes('t'.repeat(41)), JSON.stringify(longTask.slice(0, 160)));

  // DEL is a control character like the rest.
  const delName = plain(renderSequence([inlinePayload({ model, workspace: { repo: { name: 'ab' + DEL + 'cd' }, current_dir: '/tmp/p' } })])[0].out);
  check('DEL is stripped from a name', delName.includes('abcd') && !delName.includes(DEL), JSON.stringify(delName.slice(0, 80)));

  // Directory fallbacks must be provable, not just "no [object" (the review's M1, M2, M8).
  const viaCwd = plain(renderSequence([inlinePayload({ model, workspace: { current_dir: 5 }, cwd: '/tmp/fallbackdir' })])[0].out);
  check('an unusable current_dir uses cwd for the directory name', viaCwd.startsWith('fallbackdir'), JSON.stringify(viaCwd.slice(0, 80)));
  // With no directory fields at all, both the dir and git segments use the PROCESS directory.
  // The child gets its own throwaway repo as its working directory, so this holds whether or not
  // the checkout running the tests is itself a git repository (a copied tree has no .git).
  const procRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-procdir-'));
  try {
    fs.mkdirSync(path.join(procRepo, '.git'));
    fs.writeFileSync(path.join(procRepo, '.git', 'HEAD'), 'ref: refs/heads/process-dir-branch\n', 'utf8');
    const neither = plain(renderSequence([{ model, session_id: 'inline' }], { cwd: procRepo })[0].out);
    check('with no directory fields the dir segment falls back to the process directory',
      neither.startsWith(path.basename(procRepo)), JSON.stringify({ got: neither.slice(0, 80), want: path.basename(procRepo) }));
    check('and the git segment falls back to it as well', neither.includes('process-dir-branch'), JSON.stringify(neither.slice(0, 160)));
  } finally {
    try { fs.rmSync(procRepo, { recursive: true, force: true }); } catch {}
  }

  // Cost counts: 1e20 is a finite integer that is not a safe one and would print as 21 digits.
  const big = plain(renderSequence([inlinePayload({ model, cost: { total_lines_added: 1e20, total_lines_removed: 1e20 } })])[0].out);
  check('a line count past the safe integers is not printed', !/1000000|e\+/.test(big), JSON.stringify(big.slice(0, 120)));

  // Wrapping was never exercised: with M29 (visibleWidth always 0) nothing failed.
  const fullFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'full.json'), 'utf8'));
  const withFuture = { ...fullFixture, rate_limits: { five_hour: { used_percentage: 61, resets_at: nowS + 3 * 3600 },
    seven_day: { used_percentage: 22, resets_at: nowS + 3 * 86400 } } };
  const lineCount = (cols) => {
    const o = renderSequence([withFuture], { env: { COLUMNS: String(cols) } })[0];
    return { lines: plain(o.out).replace(/\n$/, '').split('\n').length, widths: plain(o.out).replace(/\n$/, '').split('\n').map((l) => visibleWidth(l)) };
  };
  const wide = lineCount(300);
  const narrow = lineCount(60);
  check('a wide terminal keeps one line', wide.lines === 1, JSON.stringify(wide));
  check('a narrow terminal wraps to two lines', narrow.lines === 2, JSON.stringify(narrow));
}

// ---- Bidirectional and invisible characters, and terminal cell width -----------------
// sanitize() strips terminal control sequences, but a bidirectional override (U+202E) is not a
// control sequence: it reorders the text AFTER it on bidi-capable terminals, which here is the
// model name, usage bars and countdown. Zero-width and tag characters are invisible, so a name
// can be blank on screen or carry hidden text. ZWJ and ZWNJ are legitimate (emoji sequences,
// Persian) and must survive. Every character below is built from a code point on purpose.
function runInvisibleCharacterTests() {
  const { sanitize } = require('../lib/colors');
  const { visibleWidth } = require('../lib/layout');
  const cp = (...n) => String.fromCodePoint(...n);
  const check = (name, ok, detail) => {
    if (ok) console.log('  ok    invisible characters: ' + name);
    else fail('invisible characters: ' + name, detail);
  };
  const show = (str) => Array.from(str).map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

  const mustStrip = {
    'right-to-left override': 0x202e, 'left-to-right override': 0x202d, 'left-to-right embedding': 0x202a,
    'right-to-left embedding': 0x202b, 'pop directional formatting': 0x202c, 'left-to-right isolate': 0x2066,
    'right-to-left isolate': 0x2067, 'first strong isolate': 0x2068, 'pop directional isolate': 0x2069,
    'left-to-right mark': 0x200e, 'right-to-left mark': 0x200f, 'arabic letter mark': 0x061c,
    'zero-width space': 0x200b, 'word joiner': 0x2060, 'invisible times': 0x2062, 'invisible separator': 0x2063,
    'deprecated format character': 0x206a, 'byte order mark': 0xfeff, 'mongolian vowel separator': 0x180e,
    'tag latin capital A': 0xe0041, 'tag cancel': 0xe007f,
  };
  for (const [label, code] of Object.entries(mustStrip)) {
    const got = sanitize('a' + cp(code) + 'b');
    check('sanitize strips the ' + label + ' (U+' + code.toString(16).toUpperCase() + ')', got === 'ab', show(got));
  }

  const mustKeep = {
    'zero-width joiner in an emoji sequence': cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    'emoji variation selector': cp(0x2764, 0xfe0f),
    'zero-width non-joiner (Persian)': cp(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645),
    'a combining accent': 'e' + cp(0x0301),
    'CJK text': cp(0x65e5, 0x672c, 0x8a9e),
    'a regional-indicator flag': cp(0x1f1fa, 0x1f1f8),
    'a rocket': cp(0x1f680),
    'plain ASCII': 'ampline-claude 0.7',
  };
  for (const [label, text] of Object.entries(mustKeep)) {
    const got = sanitize(text);
    check('sanitize keeps ' + label, got === text, show(got));
  }

  // The stripped characters must not come back through any rendered field.
  const BIDI = cp(0x202e, 0x2066, 0x200b, 0xfeff, 0xe0041, 0x200f);
  const reachesStdout = (out) => Array.from(String(out)).some((c) => {
    const n = c.codePointAt(0);
    return n === 0x202e || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || n === 0x200b ||
      n === 0x200e || n === 0x200f || n === 0xfeff || n === 0x2060 || (n >= 0xe0000 && n <= 0xe007f);
  });
  const SGR = /\x1b\[[0-9;]*m/g;
  const model = { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' };
  const out = (payload, extra) => {
    const r = spawnRender(JSON.stringify(payload), extra || {});
    return { status: r.status, text: r.stdout || '' };
  };
  const cases = {
    'repo name': inlinePayload({ model, workspace: { repo: { name: 'proj' + BIDI + 'evil' }, current_dir: '/tmp/p' } }),
    'directory basename': inlinePayload({ model, workspace: { current_dir: '/tmp/proj' + BIDI + 'evil' } }),
    'model display name': inlinePayload({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet' + BIDI + ' 5.5' } }),
    'model id fallback': inlinePayload({ model: { id: 'claude-sonnet' + BIDI + '-5-5' } }),
    'subagent-independent separator': inlinePayload({ model }),
  };
  for (const [label, payload] of Object.entries(cases)) {
    const r = out(payload);
    check(label + ' carries no bidirectional or invisible character to stdout',
      r.status === 0 && !reachesStdout(r.text), show(r.text.replace(SGR, '')).slice(0, 200));
  }
  const evilRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ampline-bidi-repo-'));
  try {
    fs.mkdirSync(path.join(evilRepo, '.git'));
    fs.writeFileSync(path.join(evilRepo, '.git', 'HEAD'), 'ref: refs/heads/main' + BIDI + 'evil\n', 'utf8');
    const r = out(inlinePayload({ model, workspace: { current_dir: evilRepo } }));
    check('a branch name with a bidirectional override is neutralized, and still shown',
      r.status === 0 && !reachesStdout(r.text) && r.text.replace(SGR, '').includes('mainevil'), r.text.replace(SGR, '').slice(0, 160));
  } finally {
    try { fs.rmSync(evilRepo, { recursive: true, force: true }); } catch {}
  }
  const todoSeed = (home) => {
    const dir = path.join(home, '.claude', 'todos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bidi-session.json'), JSON.stringify([{ status: 'in_progress', activeForm: 'Run' + BIDI + 'tests' }]), 'utf8');
  };
  const t = out(inlinePayload({ model, session_id: 'bidi-session' }), { seed: todoSeed });
  check('todo text with a bidirectional override is neutralized, and still shown',
    t.status === 0 && !reachesStdout(t.text) && t.text.replace(SGR, '').includes('Runtests'), t.text.replace(SGR, '').slice(0, 160));

  // A name that is only invisible characters is blank on screen and must fall back, not print.
  const blank = out(inlinePayload({ model, workspace: { repo: { name: cp(0x200b, 0x202e, 0xfeff) }, current_dir: '/tmp/realdir' } }));
  check('a repo name made only of invisible characters falls back to the directory name',
    blank.status === 0 && blank.text.replace(SGR, '').startsWith('realdir'), show(blank.text.replace(SGR, '')).slice(0, 120));

  // ---- cell width: the wrap decision must match what the terminal actually draws ----
  const w = (str) => visibleWidth(str);
  check('a rocket is two cells', w(cp(0x1f680)) === 2, String(w(cp(0x1f680))));
  check('fifteen rockets are thirty cells', w(cp(0x1f680).repeat(15)) === 30, String(w(cp(0x1f680).repeat(15))));
  check('a symbols-and-pictographs extended-A emoji is two cells', w(cp(0x1fa80)) === 2, String(w(cp(0x1fa80))));
  check('a transport emoji at the end of its block is two cells', w(cp(0x1f6fc)) === 2, String(w(cp(0x1f6fc))));
  check('a CJK ideograph is two cells', w(cp(0x65e5)) === 2, String(w(cp(0x65e5))));
  check('plain ASCII is one cell each', w('abc') === 3, String(w('abc')));
  check('a combining accent adds no cell', w('e' + cp(0x0301)) === 1, String(w('e' + cp(0x0301))));
  check('a zero-width space adds no cell', w('a' + cp(0x200b).repeat(30)) === 1, String(w('a' + cp(0x200b).repeat(30))));
  check('a tag character adds no cell', w('a' + cp(0xe0041, 0xe007f)) === 1, String(w('a' + cp(0xe0041, 0xe007f))));
  check('a ZWJ emoji sequence is not wider than its parts', w(cp(0x1f468, 0x200d, 0x1f469)) === 4, String(w(cp(0x1f468, 0x200d, 0x1f469))));
  check('a variation selector adds no cell', w(cp(0x2764, 0xfe0f)) === 1, String(w(cp(0x2764, 0xfe0f))));
}

// ---- Source files must not hide text from a reader ("Trojan Source") -----------------
// A bidirectional override or a zero-width character inside a source file or document makes
// the code a reviewer sees differ from the code that runs. None belong in this repository.
function runSourceHygieneTests() {
  const roots = ['bin', 'lib', 'test', 'scripts', '.github', 'diagrams'];
  const rootFiles = ['README.md', 'CHANGELOG.md', 'CLAUDE.md', 'DECISIONS.md', 'SECURITY.md', 'package.json', 'LICENSE'];
  const exts = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.example']);
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
      else if (exts.has(path.extname(e.name)) || e.name === 'LICENSE') files.push(p);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  for (const f of rootFiles) { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p); }

  const bad = (n) => (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || n === 0x200b ||
    n === 0x200e || n === 0x200f || n === 0x061c || n === 0xfeff || n === 0x2060 || n === 0x2028 || n === 0x2029 ||
    (n >= 0xe0000 && n <= 0xe007f);
  const hits = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let line = 1;
    for (const ch of text) {
      const n = ch.codePointAt(0);
      if (ch === '\n') line++;
      if (bad(n)) hits.push(path.relative(ROOT, f) + ':' + line + ' U+' + n.toString(16).toUpperCase());
    }
  }
  if (hits.length === 0) console.log('  ok    source hygiene: no bidirectional or invisible characters in ' + files.length + ' tracked source and doc files');
  else fail('source hygiene: invisible or bidirectional characters found', hits.slice(0, 12).join(', '));
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
  runSubagentContractTests();
  runInjectionTests();
  runInjectionFollowupTests();
  runInvisibleCharacterTests();
  runSourceHygieneTests();

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
