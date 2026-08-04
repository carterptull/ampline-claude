'use strict';
// Confirms the actual `npm pack` tarball contents match the `files`
// allowlist intent — catches a broken files field or an accidental
// .npmignore before it ships, rather than trusting package.json alone.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run() {
  // shell: true, since `npm` on Windows is npm.cmd — execFileSync won't
  // resolve it via PATHEXT without routing through the OS shell.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error('unexpected `npm pack --dry-run --json` shape');
  }
  return entry.files.map((f) => f.path.replace(/\\/g, '/'));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const files = run();
console.log(`Tarball would contain ${files.length} file(s):\n  ${files.join('\n  ')}\n`);

check('bin/ present', files.some((f) => f.startsWith('bin/')));
check('lib/ present', files.some((f) => f.startsWith('lib/')));
check('test/ absent', !files.some((f) => f.startsWith('test/')), files.filter((f) => f.startsWith('test/')).join(','));
check('scripts/ absent', !files.some((f) => f.startsWith('scripts/')), files.filter((f) => f.startsWith('scripts/')).join(','));
check('.github/ absent', !files.some((f) => f.startsWith('.github/')));
check(
  'no docs other than README.md',
  !files.some((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'readme.md'),
  files.filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'readme.md').join(',')
);
check(
  'no implementation-plan file of any kind',
  !files.some((f) => /implementation[-_]?plan/i.test(f)),
  files.filter((f) => /implementation[-_]?plan/i.test(f)).join(',')
);
check('README.md present', files.some((f) => f.toLowerCase() === 'readme.md'));
check('LICENSE present', files.some((f) => f.toLowerCase() === 'license'));
check('.amplinerc.json.example present', files.some((f) => f.toLowerCase() === '.amplinerc.json.example'));
check('package.json present', files.some((f) => f.toLowerCase() === 'package.json'));

// Regression guard: a Windows checkout once published a tarball whose bin/
// shebang carried a stray \r, invisible to a file-list-only check like this
// one used to be. What's on disk here is exactly what ships.
const entryPath = path.join(ROOT, 'bin', 'ampline-claude.js');
const entryRaw = fs.readFileSync(entryPath, 'utf8');
check('bin/ampline-claude.js has no CR byte', !entryRaw.includes('\r'));
check(
  'bin/ampline-claude.js starts with the exact shebang line',
  entryRaw.startsWith('#!/usr/bin/env node\n'),
  JSON.stringify(entryRaw.slice(0, 22))
);

console.log(failures ? `\n${failures} check(s) failed` : '\nTarball contents look right.');
process.exit(failures ? 1 : 0);
