#!/usr/bin/env node

import process from 'node:process';
import { checkApp, convertApp, formatReport } from '../src/archshift.js';

const HELP = `Electron ArcShift — audit and repackage eligible Electron macOS apps for Intel Macs

Usage:
  electron-arcshift check <path-to-app>
  electron-arcshift convert <path-to-app> [options]

Options:
  -o, --out <directory>       Output directory (default: ./electron-arcshift-output)
      --electron <version>    Override the detected Electron version
      --force                 Continue despite native-binary blockers
      --smoke-test            Launch the result briefly after packaging
      --smoke-seconds <n>     Smoke-test duration (default: 8)
      --json                  Print the report as JSON
  -h, --help                  Show this help

Electron ArcShift never modifies the input .app. Conversion preserves its app.asar in
the output job directory, extracts to a separate staging directory, and writes
the Intel package outside that source tree.`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exitCode = code;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { smokeSeconds: 8 };
  let appPath;
  while (args.length) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--smoke-test') options.smokeTest = true;
    else if (arg === '-o' || arg === '--out') options.out = args.shift();
    else if (arg === '--electron') options.electronVersion = args.shift();
    else if (arg === '--smoke-seconds') options.smokeSeconds = Number(args.shift());
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!appPath) appPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (options.out === undefined && argv.some((a) => a === '-o' || a === '--out')) {
    throw new Error('--out requires a directory');
  }
  if (options.electronVersion === undefined && argv.includes('--electron')) {
    throw new Error('--electron requires a version');
  }
  if (!Number.isFinite(options.smokeSeconds) || options.smokeSeconds < 1 || options.smokeSeconds > 120) {
    throw new Error('--smoke-seconds must be between 1 and 120');
  }
  return { command, appPath, options };
}

try {
  const { command, appPath, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === 'help' || command === '--help' || command === '-h' || !command) {
    console.log(HELP);
  } else if (!['check', 'convert'].includes(command)) {
    fail(`Unknown command: ${command}\n\n${HELP}`, 2);
  } else if (!appPath) {
    fail(`Missing path to an .app bundle.\n\n${HELP}`, 2);
  } else if (command === 'check') {
    const report = await checkApp(appPath, options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    if (!report.eligible) process.exitCode = 3;
  } else {
    const result = await convertApp(appPath, options, (message) => console.error(`→ ${message}`));
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReport(result.report));
      console.log(`\nIntel app: ${result.appPath}`);
      console.log(`Job directory: ${result.jobDirectory}`);
      if (result.smokeTest) console.log(`Smoke test: ${result.smokeTest.status}`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
