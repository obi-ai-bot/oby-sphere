// README.md and the docs it leads to (docs/DEPLOY.md, docs/RAILWAY_TEMPLATE.md): every relative
// link and image points to a file in this repository, every #anchor to a heading, every
// `obysphere <command>` they show is one the CLI has (the wave-3 contract, hard-coded below),
// every `node rep.mjs <command>` is one rep.mjs has, and every `join` they show names its folder.
// Then the invite link they describe: a key with a `+` joins, from `join` and in the console.
// `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'docs/DEPLOY.md', 'docs/RAILWAY_TEMPLATE.md'];

// Files that other wave-3 work adds (the instruments guide, the CLI). Until it's merged, a link
// to one of them shows as a TODO instead of failing; once the file exists it's checked like any other.
const LANDING = new Set(['INSTRUMENTS.md', 'obysphere.mjs']);

// The CLI contract (plans/wave3.md, "The CLI contract"). A command with a list takes one of
// those subcommands; `server deploy` takes a target.
const CONTRACT = {
  // rep.mjs, as before
  join: true, ask: true, post: true, read: true, inbox: true, agents: true, whoami: true, settings: true, mcp: true, 'mcp-config': true,
  // rep.mjs, new
  notify: ['test'],
  admin: ['claim', 'status', 'grant', 'revoke', 'policy', 'rotate-key'],
  github: ['status'],
  // obysphere.mjs
  start: true, stop: true, restart: true, status: true, logs: true, open: true, profiles: true, update: true, version: true, doctor: true,
  server: ['start', 'deploy', 'update', 'status'],
  // the instruments stream (plans/wave3.md, "Added during the build")
  instruments: ['new', 'list', 'check', 'remove'],
  // #160: telling askers you're away
  away: true,
  // #163: the menu bar icon
  menubar: ['on', 'off'],
};
const DEPLOY_TARGETS = ['vercel'];

// a fenced block, also one indented inside a list item
const FENCE = /^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const noComments = (md) => md.replace(/<!--[\s\S]*?-->/g, '');

// prose without code (code blocks and inline code), so a link inside code isn't taken for one
function prose(md) {
  return noComments(md).replace(FENCE, '').replace(/`[^`\n]+`/g, '');
}

// what code shows: fenced blocks and inline code
function code(md) {
  const md2 = noComments(md);
  const out = [...md2.matchAll(FENCE)].map((m) => m[2]);
  for (const m of md2.replace(FENCE, '').matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

function links(md) {
  const text = prose(md);
  const out = [];
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/<(?:img|a|source)\b[^>]*?\s(?:src|href|srcset)="([^"]+)"/gi)) out.push(m[1]);
  return out;
}

const isRelative = (t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('//');

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered
function anchors(md) {
  const out = new Set();
  const seen = new Map();
  for (const m of md.replace(FENCE, '').matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const text = m[1].replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

// every relative target in the docs: [doc, target, resolved file (from the repo root), anchor]
function targets() {
  const out = [];
  for (const doc of DOCS) {
    for (const t of links(read(doc))) {
      if (!isRelative(t)) continue;
      const [file, anchor] = t.split('#');
      const rel = file ? path.relative(ROOT, path.resolve(ROOT, path.dirname(doc), decodeURIComponent(file))) : doc;
      out.push([doc, t, rel, anchor ? decodeURIComponent(anchor) : '']);
    }
  }
  return out;
}

test('every relative link and image in README.md and its docs points to a file here', () => {
  const all = targets();
  assert.ok(all.some(([doc, , rel]) => doc === 'README.md' && rel === 'docs/images/oby-logo.png'), 'README shows the logo');
  assert.ok(all.length > 20, `found only ${all.length} relative links: the parser lost them`);
  const missing = all.filter(([, , rel]) => !LANDING.has(rel) && !fs.existsSync(path.join(ROOT, rel)));
  assert.deepEqual(missing.map(([doc, t]) => `${doc}: ${t}`), []);
  for (const [doc, , rel] of all) assert.ok(!rel.startsWith('..'), `${doc} links outside the repository: ${rel}`);
});

test('every #anchor in README.md and its docs is a heading', () => {
  const missing = [];
  for (const [doc, t, rel, anchor] of targets()) {
    if (!anchor || !rel.endsWith('.md') || !fs.existsSync(path.join(ROOT, rel))) continue;
    if (!anchors(read(rel)).has(anchor)) missing.push(`${doc}: ${t}`);
  }
  assert.deepEqual(missing, []);
});

const landingMissing = [...LANDING].filter((f) => !fs.existsSync(path.join(ROOT, f)));
test('files other wave-3 work adds are there', { todo: landingMissing.length ? `not merged yet: ${landingMissing.join(', ')}` : false }, () => {
  assert.deepEqual(landingMissing, []);
});

test('the logo is a small PNG', () => {
  const png = fs.readFileSync(path.join(ROOT, 'docs/images/oby-logo.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(png.length < 150 * 1024, `${png.length} bytes`);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.ok(w <= 512 && h <= 512, `${w}x${h}`);
});

test('every `obysphere <command>` in README.md and its docs is in the CLI contract', () => {
  const shown = new Set();
  const wrong = [];
  for (const doc of DOCS) {
    for (const c of code(read(doc))) {
      for (const m of c.matchAll(/(?:^|[\s;&|($])obysphere[ \t]+([a-z][\w-]*)(?:[ \t]+([a-z][\w-]*))?(?:[ \t]+([a-z][\w-]*))?/gm)) {
        const [, cmd, sub, target] = m;
        const spec = CONTRACT[cmd];
        const said = `${doc}: obysphere ${[cmd, sub, target].filter(Boolean).join(' ')}`;
        if (!spec) wrong.push(said);
        else if (Array.isArray(spec) && !spec.includes(sub)) wrong.push(said);
        else if (cmd === 'server' && sub === 'deploy' && !DEPLOY_TARGETS.includes(target)) wrong.push(said);
        if (doc === 'README.md') shown.add([cmd, Array.isArray(spec) ? sub : ''].filter(Boolean).join(' '));
      }
    }
  }
  assert.deepEqual(wrong, []);
  // the parser found what the README is about, so the check above isn't empty
  for (const c of ['join', 'start', 'open', 'update', 'mcp-config', 'server start', 'server deploy', 'admin claim', 'notify test', 'github status', 'instruments new'])
    assert.ok(shown.has(c), `README shows obysphere ${c}`);
});

test('every `node rep.mjs <command>` in the docs is one rep.mjs has', () => {
  const src = read('rep.mjs');
  const table = /const commands = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
  assert.ok(table, "rep.mjs's command table");
  const wrong = [];
  let seen = 0;
  for (const doc of DOCS) {
    for (const c of code(read(doc))) {
      for (const m of c.matchAll(/node[ \t]+(?:"[^"\n]*)?rep\.mjs"?[ \t]+([a-z][\w-]*)/g)) {
        seen++;
        if (!new RegExp(`(^|[{,\\s])'?${m[1]}'?\\s*[:,]|(^|[{,\\s])${m[1]}\\s*$`).test(table)) wrong.push(`${doc}: node rep.mjs ${m[1]}`);
      }
    }
  }
  assert.ok(seen > 5, `found only ${seen}`);
  assert.deepEqual(wrong, []);
});

// ===== review fixes (wave3/readme-r)

// `join` without --cwd uses the folder you're in and refuses your home folder, where a new
// terminal opens: so every join the docs give to copy (fenced blocks) names its folder
test('every `join` the docs give to copy names --cwd', () => {
  const missing = [];
  let seen = 0;
  for (const doc of DOCS) {
    for (const m of noComments(read(doc)).matchAll(FENCE)) {
      // a command goes on over a trailing \ and over option lines that start with [
      const lines = m[2].replace(/\\\n/g, ' ').replace(/\n[ \t]+(?=\[)/g, ' ').split('\n');
      for (const line of lines) {
        if (!/(?:^|[\s;&|])(?:obysphere|node[ \t]+(?:"[^"\n]*)?rep\.mjs"?)[ \t]+join\b/.test(line)) continue;
        seen++;
        if (!/--cwd\b/.test(line)) missing.push(`${doc}: ${line.trim()}`);
      }
    }
  }
  assert.ok(seen >= 4, `found only ${seen}`);
  assert.deepEqual(missing, []);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a key made with `openssl rand -base64 …` often holds a '+'; read as form data it became a space
test('an invite link whose key holds a + joins', async () => {
  const KEY = 'join+key/with+plus=0123456789abc';
  const ADMIN = 'admin-key-readme-0123456789ab';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-readme-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-readme-reps-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-readme-cwd-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', OBYSPHERE_HOME: home };
  const relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], { env, stdio: 'ignore' });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', () => { clearTimeout(t); resolve(out); });
    });
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
    for (const [name, link] of [['inhash', `${base}/#key=${KEY}`], ['inquery', `${base}/?key=${KEY}`]]) {
      const out = await rep(['join', link, '--name', name, '--owner', 'Readme Test', '--cwd', cwd]);
      assert.match(out, /joined/, `${name}: ${out}`);
      assert.ok(fs.existsSync(path.join(home, name, 'profile.json')), `${name} has a profile`);
    }
  } finally {
    // let the relay stop before its folder goes, or a last write races the removal (ENOTEMPTY)
    if (relay.exitCode === null && relay.signalCode === null) await new Promise((r) => { relay.once('exit', r); relay.kill(); });
    for (const d of [dir, home, cwd]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the console keeps a + in the link's key", () => {
  const m = /const hp = (new URLSearchParams\(location\.hash[^;]*\));/.exec(read('public/index.html'));
  assert.ok(m, "the console's reading of the link");
  const hp = new Function('location', `return ${m[1]}`)({ hash: '#key=ab+cd/ef==&admin=x+y&mode=chat' });
  assert.equal(hp.get('key'), 'ab+cd/ef==');
  assert.equal(hp.get('admin'), 'x+y');
  assert.equal(hp.get('mode'), 'chat');
});
