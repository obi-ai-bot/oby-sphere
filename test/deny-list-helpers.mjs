// Helpers for test/deny-list.test.mjs: a glob matcher for the deny rules and the sandbox's
// globs, and a fake `claude` whose answer tries to attach files through the real
// `rep.mjs mcp --as-session` server, as a model told to send them would. No model, no network.
import fs from 'node:fs';
import path from 'node:path';

// A glob of the deny list, as a regular expression over a path with / separators. Only
// the forms rep.mjs writes: `**/` in front (any folder), `//` in front (Claude Code's
// absolute path), `/**` at the end (everything inside), and `*` (any run inside one name).
export function globRegExp(glob, { ignoreCase = true } = {}) {
  let g = glob;
  let src = '^';
  if (g.startsWith('//')) g = g.slice(1);
  else if (g.startsWith('**/')) {
    src += '(?:.*/)?';
    g = g.slice(3);
  } else throw new Error(`a glob rep.mjs doesn't write: ${glob}`);
  let tail = '';
  if (g.endsWith('/**')) {
    g = g.slice(0, -3);
    tail = '(?:/.*)?';
  }
  if (g.includes('**')) throw new Error(`a glob rep.mjs doesn't write: ${glob}`);
  src += g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(src + tail + '$', ignoreCase ? 'i' : '');
}

// Whether a glob matches a path the way gitignore does (Claude Code's Read rules follow it):
// the path itself, or any folder on the way to it, so a matching folder hides what's inside.
// Windows separators become /.
export function globMatches(glob, p, opts) {
  const re = globRegExp(glob, opts);
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (prefix && re.test(prefix)) return true;
  }
  return false;
}

// A Claude Code permission rule `Read(<glob>)` as its glob
export const ruleGlob = (rule) => {
  const m = /^Read\((.+)\)$/.exec(rule);
  if (!m) throw new Error(`not a Read rule: ${rule}`);
  return m[1];
};

// Writes dir/claude: an answer run (it has --mcp-config) records its command line and
// settings file to answers.jsonl, starts the obysphere MCP server named in --mcp-config,
// calls sphere_attach for every line "ATTACH <path>" in the ask, and answers with what
// each call said, one line each. Anything else (--help, --version, auth, the model list)
// runs the shared fake from test/fake-runtimes.mjs at `base`.
export function makeAttachingClaude(dir, base, node = process.execPath) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'claude');
  fs.writeFileSync(
    f,
    `#!${node}
(() => {
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!flag('--mcp-config') || !flag('--append-system-prompt-file')) { require(${JSON.stringify(base)}); return; }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8'));
  fs.appendFileSync(path.join(__dirname, 'answers.jsonl'), JSON.stringify({ argv, settings }) + '\\n');
  const wanted = [...prompt.matchAll(/^ATTACH (\\S+)$/gm)].map((m) => m[1]);
  const s = mcp.mcpServers.obysphere;
  const server = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '', id = 0;
  server.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {}
    }
  });
  const gone = (why) => { for (const r of waiting.values()) r({ error: { message: why } }); waiting.clear(); };
  server.on('error', (e) => gone(e.message));
  server.on('exit', (code) => gone('the server exited with ' + code));
  const call = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\\n'); });
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  const said = [];
  for (const p of wanted) {
    const r = await call('tools/call', { name: 'sphere_attach', arguments: { name: path.basename(p), path: p } });
    said.push(p + ': ' + (r.result ? r.result.content[0].text : 'no such tool: ' + JSON.stringify(r.error)));
  }
  server.stdin.end();
  out({ type: 'system', subtype: 'init', model: 'fake-attacher', tools: ['mcp__obysphere__sphere_attach'], apiKeySource: 'none', session_id: 'fake-init' });
  out({ type: 'result', subtype: 'success', is_error: false, result: said.join('\\n'), session_id: 'deny-list-' + Date.now(), num_turns: 1 });
});
})();
`,
    { mode: 0o755 },
  );
  return {
    claude: f,
    answers: () => {
      const a = path.join(dir, 'answers.jsonl');
      return fs.existsSync(a) ? fs.readFileSync(a, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}
