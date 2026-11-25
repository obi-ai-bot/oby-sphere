#!/usr/bin/env node
// The plugin's SessionStart hook: what waits for you in your Sphere.
//
// It runs `obysphere inbox --hook`, which prints one JSON object
// (hookSpecificOutput.additionalContext for Claude, systemMessage for you, such as
// "2 asks wait for you"), and passes it on as it is. When the CLI or a profile is
// missing (or there are several and OBYSPHERE_PROFILE doesn't pick one), the
// command fails, prints anything but one JSON object, or hasn't
// finished within 5 seconds, it prints nothing and exits 0: a session never waits
// on the Sphere, and an error never lands in Claude's context.
//
// No dependencies.

import { spawn } from 'node:child_process';
import { findCli, hasProfile, profileUnclear, nodeMajor, cliCommand, NODE_MIN } from './find-cli.mjs';

// 5 seconds at most (tests may make it shorter, never longer)
const LIMIT_MS = Math.min(5000, Math.max(50, Number(process.env.OBYSPHERE_HOOK_TIMEOUT_MS) || 5000));
const MAX_OUT = 256 * 1024;

const quiet = () => process.exit(0);

try {
  const cli = findCli();
  if (!cli || (cli.rep && nodeMajor() < NODE_MIN) || !hasProfile() || profileUnclear()) quiet();
  const { cmd, args, shell } = cliCommand(cli, ['inbox', '--hook']);
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell, windowsHide: true });
  const stop = () => {
    try {
      child.kill('SIGKILL');
    } catch {}
    quiet();
  };
  const timer = setTimeout(stop, LIMIT_MS);
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d;
    if (out.length > MAX_OUT) stop();
  });
  child.on('error', quiet);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) quiet();
    const text = out.trim();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      quiet();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) quiet();
    process.stdout.write(text + '\n', quiet);
  });
} catch {
  quiet();
}
