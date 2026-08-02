'use strict';
// Confirms the actual `npm pack` tarball contents match the `files`
// allowlist intent — catches a broken files field or an accidental
// .npmignore before it ships, rather than trusting package.json alone.
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

console.log(failures ? `\n${failures} check(s) failed` : '\nTarball contents look right.');
process.exit(failures ? 1 : 0);
