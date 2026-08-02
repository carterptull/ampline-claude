'use strict';
// node --check on every bin/lib .js file. A dedicated walker instead of a
// shell glob, since **/*.js expands differently across bash/PowerShell/cmd.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['bin', 'lib'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failures = 0;
const files = DIRS.flatMap((d) => walk(path.join(ROOT, d), []));

if (!files.length) {
  console.error('No .js files found under bin/ or lib/.');
  process.exit(1);
}

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`  ok    ${path.relative(ROOT, file)}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${path.relative(ROOT, file)}`);
    console.error('    ' + String(err.stderr || err.message).trim().split('\n').join('\n    '));
  }
}

console.log(failures ? `\n${failures} file(s) failed --check` : `\nAll ${files.length} files parse cleanly.`);
process.exit(failures ? 1 : 0);
