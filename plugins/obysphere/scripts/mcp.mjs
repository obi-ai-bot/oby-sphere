#!/usr/bin/env node
// The plugin's MCP server.
//
// It finds the obysphere CLI on this computer and runs `rep.mjs mcp` with stdin,
// stdout and stderr passed straight through, so Claude Code talks to your own
// representative, with its instruments (sphere_agents, sphere_ask, ...) and its
// channel. Its exit code comes back as this one's. Arguments after this script
// go on to `mcp` (for example `--profile work`); so does the environment
// (OBYSPHERE_PROFILE, OBYSPHERE_HOME).
//
// Until the CLI is installed, on Node 22 or newer, and has joined a Sphere, it
// serves one tool instead, obysphere_setup, that says how. It never installs or
// downloads anything itself.
//
// No dependencies.

import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';
import { findCli, hasProfile, profiles, profileUnclear, profileMissing, chosenProfile, nodeMajor, cliCommand, NODE_MIN, INSTALL_DOCS } from './find-cli.mjs';

const VERSION = '0.3.0';
const ARGS = process.argv.slice(2);

// why the CLI can't serve yet: 'install', 'node', 'join', 'several' or 'missing'; null when it can
function blocker(cli) {
  if (!cli) return 'install';
  if (cli.rep && nodeMajor() < NODE_MIN) return 'node';
  if (!hasProfile()) return 'join';
  if (profileUnclear(ARGS)) return 'several';
  if (profileMissing(ARGS)) return 'missing';
  return null;
}

const cli = findCli();
if (blocker(cli)) serveSetup();
else run(cli);

// ================================================================ the CLI's own MCP server

function run(found) {
  const { cmd, args, shell } = cliCommand(found, ['mcp', ...ARGS]);
  let failed = false;
  const child = spawn(cmd, args, { stdio: 'inherit', shell, windowsHide: true });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        // serving obysphere_setup instead (the CLI never started): stop, as a signal would
        if (failed) return process.exit(128 + (os.constants.signals[sig] || 1));
        try {
          child.kill(sig);
        } catch {}
      });
    } catch {}
  }
  // it couldn't start at all: nothing has read stdin yet, so say how to set up instead
  child.on('error', (e) => {
    if (failed) return;
    failed = true;
    serveSetup(`The obysphere CLI was found (${found.rep || found.bin}) but couldn't start: ${e.code || e.message}. Run obysphere doctor in a terminal for what to fix.`);
  });
  child.on('exit', (code, signal) => {
    if (failed) return;
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1));
  });
}

// ================================================================ until it's set up: one tool

function serveSetup(startError = null) {
  const instructions =
    "Obysphere isn't set up on this computer yet, so the Sphere's instruments (sphere_agents, sphere_ask and the rest) aren't here. Call obysphere_setup for how to install the obysphere CLI and join a Sphere; the join-a-sphere skill walks through it.";
  const tool = {
    name: 'obysphere_setup',
    title: 'Set up Obysphere',
    description:
      "How to get the Sphere's instruments working on this computer: install the obysphere CLI and join a Sphere, or choose which of several Spheres Claude Code uses. Use it when the person wants their Oby, their Sphere or a teammate's Oby, and the Sphere's instruments (sphere_agents, sphere_ask) aren't available.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };

  const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (id === undefined || id === null) return; // a notification
    const ok = (result) => write({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'obysphere', version: VERSION },
          instructions,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: [tool] });
      case 'tools/call':
        if (params.name !== tool.name) return fail(-32602, 'unknown tool');
        return ok({ content: [{ type: 'text', text: setupText(startError) }] });
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, 'method not found');
    }
  });
  rl.on('close', () => process.exit(0));
}

// looked at again at every call, so it notices an install made during the session
function setupText(startError) {
  const now = findCli();
  const why = blocker(now);
  const reconnect = "Then reconnect the \"obysphere\" server in /mcp, or restart Claude Code, and the Sphere's instruments (sphere_agents, sphere_ask, ...) replace this tool.";
  if (!why && startError) return startError;
  if (!why) return `Obysphere is installed and this computer has joined a Sphere. Reconnect the "obysphere" server in /mcp, or restart Claude Code, and the Sphere's instruments (sphere_agents, sphere_ask, ...) replace this tool.`;
  if (why === 'several')
    return [
      `This computer has joined more than one Sphere (profiles: ${profiles().join(', ')}), and nothing says which one Claude Code should use.`,
      '',
      'Choose one in a terminal: obysphere profiles use <name>. Every obysphere command uses it too. OBYSPHERE_PROFILE, when it is set (in the shell or under "env" in Claude Code\'s settings, ~/.claude/settings.json), comes first: set it to one of them, or remove it.',
      '',
      reconnect,
    ].join('\n');
  if (why === 'missing')
    return [
      `Claude Code is set to use the profile ${JSON.stringify(String(chosenProfile(ARGS)).slice(0, 40))} (OBYSPHERE_PROFILE or --profile), but this computer has no profile by that name. Its profiles: ${profiles().join(', ')}.`,
      '',
      'Choose one in a terminal: obysphere profiles use <name>. Every obysphere command uses it too. OBYSPHERE_PROFILE, when it is set (in the shell or under "env" in Claude Code\'s settings, ~/.claude/settings.json), comes first: set it to one of them, or remove it.',
      '',
      reconnect,
    ].join('\n');

  const install = [
    `Install the obysphere CLI with the one-line installer in the project's README: ${INSTALL_DOCS}. It downloads a release from GitHub, checks it against the release's SHA256SUMS, installs it under ~/.local/share/obysphere and puts \`obysphere\` in ~/.local/bin. Show the person the command from there and ask before running it.`,
  ];
  const join = [
    "Join with the invite link the Sphere's admin gave the person (https://<sphere>/#key=<join key>). Ask for it, and for the handle, their name, what their Oby knows and the one folder it may read. The link holds the join key: use it only in this command, never in a file, a commit or a message.",
    '   obysphere join "<invite link>" --name <handle> --owner "<Their Name>" --about "<what their Oby knows>" --cwd <the folder it may read>',
    'Go online, so their Oby answers in the background: obysphere start',
    'Open their console: obysphere open',
  ];
  const head = {
    install: "Obysphere isn't installed on this computer yet.",
    node: `Obysphere needs Node ${NODE_MIN} or newer, and this is Node ${process.versions.node}. Install Node ${NODE_MIN} (from nodejs.org, or nvm install ${NODE_MIN}) so Claude Code's \`node\` is 22 or newer.`,
    join: `The obysphere CLI is installed${now?.bin ? ` (${now.bin})` : now?.rep ? ` (${now.rep})` : ''}, but this computer hasn't joined a Sphere yet.`,
  }[why];
  const steps = why === 'install' ? [`Check Node: node --version (${NODE_MIN} or newer).`, ...install, ...join] : why === 'join' || !hasProfile() ? join : [];
  if (!steps.length) return [head, '', reconnect].join('\n');
  let n = 0;
  const numbered = steps.map((s) => (s.startsWith('   ') ? s : `${++n}. ${s}`));
  return [head, '', 'To set it up (the join-a-sphere skill walks through it):', ...numbered, '', reconnect].join('\n');
}
