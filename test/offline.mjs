#!/usr/bin/env node
// test/offline.mjs — proves --fixtures touches no network at all.
//
// The skill's pitfall: "a fixture mode that still calls fetch is not offline."
// So this replaces global fetch with a landmine, then runs the real runner.

import { spawn } from 'node:child_process';

const probe = `
globalThis.fetch = () => {
  console.error('NETWORK-CALLED');
  throw new Error('fetch was called in fixtures mode');
};
process.argv = [process.argv[0], 'run.mjs', '--fixtures', '--json'];
await import('./run.mjs');
`;

const child = spawn('node', ['--input-type=module', '-e', probe], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const code = await new Promise((res) => child.on('exit', res));

const calledNetwork = out.includes('NETWORK-CALLED');
const refusedToRun = /fetch was called/.test(out);
const completed = /REFUSE/.test(out) && !/failures?: [1-9]/.test(out);

console.log(`${code === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} fixtures mode ran to completion (exit ${code})`);
console.log(`${!calledNetwork && !refusedToRun ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} fixtures mode never called fetch`);
console.log(`${completed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} tape reached the refusal beat without a network dependency`);

if (calledNetwork || refusedToRun || code !== 0 || !completed) {
  console.log('\n--- runner output ---\n' + out.slice(-2000));
  process.exitCode = 1;
} else {
  console.log('\n\x1b[32mOFFLINE OK\x1b[0m — this runs on a stage with no Wi-Fi.\n');
}
