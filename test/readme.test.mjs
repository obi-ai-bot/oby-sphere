// README.md and the docs it leads to (docs/DEPLOY.md, docs/RAILWAY_TEMPLATE.md): every relative
// link and image points to a file in this repository, every #anchor to a heading, every
// `obysphere <command>` they show is one the CLI has (the wave-3 contract, hard-coded below),
// and every `node rep.mjs <command>` is one rep.mjs has. Reads files only. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
};
const DEPLOY_TARGETS = ['vercel'];

const FENCE = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
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
  for (const c of ['join', 'start', 'open', 'update', 'mcp-config', 'server start', 'server deploy', 'admin claim', 'notify test', 'github status'])
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
