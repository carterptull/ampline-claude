#!/usr/bin/env node
'use strict';

const { renderStatusline } = require('../lib/render');
const { renderSubagentLine } = require('../lib/segments/subagents');

// Only guards a stdin stream that never closes; a local pipe delivers in ~1ms.
const STDIN_TIMEOUT_MS = 500;
const EXIT_BACKSTOP_MS = 200;

function parseInput(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// stdout to a pipe is ASYNCHRONOUS on Windows — calling process.exit() right
// after write() truncates or drops the output entirely. Exit from the write
// callback, with an unref'd backstop for a callback that never fires.
function writeAndExit(str) {
  try {
    process.exitCode = 0;
    setTimeout(() => process.exit(0), EXIT_BACKSTOP_MS).unref();
    process.stdout.write(String(str == null ? '' : str), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function printHelp() {
  console.log(`ampline-claude — a zero-dependency statusline for Claude Code

Usage:
  npx ampline-claude              Install into ~/.claude/settings.json
  npx ampline-claude --install    Same, explicitly
  npx ampline-claude uninstall    Remove settings entries, runtime, and cache
  npx ampline-claude --version    Print version
  npx ampline-claude --help       This message

When invoked by Claude Code, reads a JSON payload on stdin and prints a
status line. --subagent renders the subagent panel rows instead.`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) return printHelp();
  if (args.includes('--version') || args.includes('-v')) {
    try { console.log(require('../package.json').version); }
    catch { console.log('unknown'); }
    return;
  }

  const { runInstaller } = require('../lib/install');
  if (args.includes('--install')) return runInstaller();
  if (args.includes('--uninstall') || args.includes('uninstall')) {
    return runInstaller({ uninstall: true });
  }

  const isSubagent = args.includes('--subagent');

  // An interactive terminal means a human ran it directly.
  if (process.stdin.isTTY) return runInstaller();

  let raw = '';
  let done = false;
  let timer = null;

  function finish() {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    try { process.stdin.pause(); } catch {}

    let out = '';
    try {
      const data = parseInput(raw);
      out = isSubagent ? (renderSubagentLine(data) || '') : renderStatusline(data);
    } catch {
      out = '';
    }
    writeAndExit(out);
  }

  timer = setTimeout(finish, STDIN_TIMEOUT_MS);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

main();
