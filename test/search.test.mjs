// Search (#138). First what a search matches, with the page's own functions picked from
// public/index.html and run in vm, as the console tests do: every word, case and accents ignored,
// "quoted phrases", pieces of words so text without spaces works, the filters (from:, in:, with:,
// has:file), a sealed message that wasn't opened counted and not searched, the conversations an
// admin sees but isn't in left out, and words holding HTML kept as text. rep.mjs has the same
// functions, word for word: a test keeps the two copies the same.
//
// Then your Oby's index, in your console (rep.mjs ui): a sealed Sphere on 127.0.0.1 with alice,
// bob and sam, public and private channels and direct messages, about 2,500 messages, so the
// history is read in pages. Alice's console reaches the relay through a proxy that keeps a log of
// every request (and can alter what the relay says, as a malicious relay would). Alice, an admin,
// finds her direct messages and the public posts, never bob and sam's direct conversation or a
// private channel she isn't in; posts sealed before she joined are counted, not found; a forged
// signature is marked; a deleted message (#139's tombstone, or its live event) leaves at once; a
// search and a click on a result send the relay nothing, and the query is in no URL; /local/search
// refuses a call without the console's header or from another origin. Then `rep.mjs search`, with
// the console running and without it, and sphere_search in your own session (missing from the one
// that answers for others, untagged, so GET /api/stats counts none). Last, a relay that sends an
// endless history is cut off at 20,000 messages. No model and no network. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { World, freePort, sleep, until } from './browser-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
const REP = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
const SHARED = ['searchFold', 'searchParse', 'searchNothing', 'searchScope', 'searchVisible', 'searchKeep', 'searchMarks', 'searchSnippet'];

// a function of the page's script (two spaces in) or of rep.mjs (at the left edge), as its source
const pageFn = (name) => new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SCRIPT)?.[0].slice(1) ?? assert.fail(`the page has no function ${name}`);
const repFn = (name) => new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(REP)?.[0].slice(1) ?? assert.fail(`rep.mjs has no function ${name}`);
const pageConst = (name) => new RegExp(`\\n  const ${name} = [^\\n]*`).exec(SCRIPT)?.[0].slice(1) ?? assert.fail(`the page has no const ${name}`);

// ---------------------------------------------------------------- what a search matches

describe('what a search matches (the page and rep.mjs, the same functions)', () => {
  const ctx = vm.createContext({});
  vm.runInContext([pageConst('esc'), ...SHARED.map(pageFn), pageFn('searchList'), pageFn('searchHighlight'), 'this.f = { searchFold, searchParse, searchNothing, searchMarks, searchSnippet, searchList, searchHighlight };'].join('\n'), ctx);
  const f = ctx.f;
  const AGENTS = [
    { id: 'a_alice', name: 'alice', owner: 'Alice Test' },
    { id: 'a_bob', name: 'bob', owner: 'Bob Müller' },
    { id: 'a_sam', name: 'sam', owner: 'Sam Lee' },
  ];
  const CHANNELS = [
    { name: 'general', kind: 'public', members: [] },
    { name: 'design', kind: 'public', members: ['a_sam'] },
    { name: 'ops', kind: 'private', members: ['a_bob', 'a_sam'] },
    { name: 'dm-ab', kind: 'dm', members: ['a_alice', 'a_bob'] },
    { name: 'dm-bs', kind: 'dm', members: ['a_bob', 'a_sam'] },
  ];
  const view = (me = 'a_alice') => ({ me, agents: new Map(AGENTS.map((a) => [a.id, a])), channels: new Map(CHANNELS.map((c) => [c.name, c])) });
  let n = 0;
  const msg = (o) => ({ id: `m_${++n}`, ts: new Date(Date.UTC(2026, 10, 1) + n * 60e3).toISOString(), channel: 'general', from: 'a_bob', kind: 'post', to: [], text: '', files: [], ...o });
  const M = {
    retries: msg({ text: 'The Payment RETRIES happen three times, then we give up.' }),
    cafe: msg({ text: 'Le café est prêt, and so is the Ünïcödé fix.', channel: 'design', from: 'a_sam' }),
    japanese: msg({ text: '支払いの再試行は三回です', from: 'a_sam' }),
    russian: msg({ text: 'Платёж прошёл вчера' }),
    greek: msg({ text: 'ΟΔΟΣ και φίλοι' }),
    lunch: msg({ text: 'Lunch at noon? flamingo', channel: 'dm-ab' }),
    ops: msg({ text: 'secret flamingo plans', channel: 'ops' }),
    theirs: msg({ text: 'their own flamingo', channel: 'dm-bs', from: 'a_sam' }),
    sealed: msg({ text: '', sealed: { to: { a_bob: {}, a_sam: {} } } }),
    system: msg({ text: '**alice** joined flamingo', from: null, kind: 'system' }),
    html: msg({ text: 'Here is <b>bold</b> & <script>alert(1)</script> flamingo', from: 'a_alice' }),
    file: msg({ text: 'the plan, attached', files: [{ id: 'f_1', name: 'retry-plan.md' }] }),
    forged: msg({ text: 'forged flamingo', sealed: { to: { a_alice: {}, a_bob: {} } }, open: true, verified: false, channel: 'dm-ab' }),
  };
  const LIST = Object.values(M);
  const search = (q, me) => f.searchList(LIST, q, view(me));
  // (Array.from: arrays made in the sandbox have its own Array, which deepEqual tells apart)
  const ids = (q, me) => Array.from(search(q, me).results, (r) => Object.keys(M).find((k) => M[k].id === r.id)).sort();

  test('every word, in any order, case ignored; "a phrase" in its order', () => {
    assert.deepEqual(ids('payment retries'), ['retries']);
    assert.deepEqual(ids('RETRIES payment'), ['retries']);
    assert.deepEqual(ids('payment retries nowhere'), []);
    assert.deepEqual(ids('"payment retries"'), ['retries']);
    assert.deepEqual(ids('"retries payment"'), []);
    assert.deepEqual(ids('"three   times, then"'), ['retries'], 'spaces in a phrase are any spaces');
    assert.deepEqual(ids('pay'), ['retries'], 'a piece of a word');
  });

  test('accents, and letters that fold, ignored both ways; text without spaces, and other alphabets', () => {
    assert.deepEqual(ids('cafe'), ['cafe']);
    assert.deepEqual(ids('CAFÉ unicode'), ['cafe']);
    assert.deepEqual(ids('ÜNÏCÖDÉ'), ['cafe']);
    assert.deepEqual(ids('再試行'), ['japanese'], 'a piece of Japanese, written without spaces');
    assert.deepEqual(ids('платеж'), ['russian'], 'ё is е');
    assert.deepEqual(ids('οδος'), ['greek'], 'a final sigma is a sigma');
    assert.equal(f.searchFold('Straße Øre ÆON'), 'strasse ore aeon');
  });

  test('from:, in:, with: and has:file, alone or with words', () => {
    assert.deepEqual(ids('from:sam'), ['cafe', 'japanese']);
    assert.deepEqual(ids('from:@sam cafe'), ['cafe']);
    assert.deepEqual(ids('from:"Bob Muller" flamingo'), ['forged', 'lunch'], "an owner's name, accents ignored");
    assert.deepEqual(ids('from:me'), ['html']);
    assert.deepEqual(ids('in:#design'), ['cafe']);
    assert.deepEqual(ids('in:design in:general retries'), ['retries']);
    assert.deepEqual(ids('with:bob'), ['forged', 'lunch'], 'your direct conversation with bob');
    assert.deepEqual(ids('with:sam'), [], 'no direct conversation of yours with sam');
    assert.deepEqual(ids('has:file'), ['file']);
    assert.deepEqual(ids('retry-plan'), ['file'], "a file's name is searched too");
    assert.deepEqual(ids('has:nothing'), [], 'has: anything else is a word');
    assert.equal(f.searchNothing(f.searchParse('  "" ')), true);
    assert.equal(f.searchNothing(f.searchParse('has:file')), false);
  });

  test("a sealed message that wasn't opened is counted, not searched; the relay's notes aren't searched", () => {
    const r = search('flamingo');
    assert.equal(r.notOpenable, 1);
    assert.equal(search('zzzz').searched, LIST.length - 4, "all but the sealed one, the system note, and the two in conversations alice isn't in");
    assert.ok(!ids('joined').length);
    assert.equal(r.results.find((x) => x.id === M.forged.id).verified, false, "a signature that doesn't verify is marked");
  });

  test("an admin sees every channel on the relay, but searches as a member; the Sphere's own page, public channels only", () => {
    assert.deepEqual(ids('flamingo'), ['forged', 'html', 'lunch'], 'never ops or dm-bs, though the page may hold them');
    assert.deepEqual(ids('flamingo', 'a_sam'), ['html', 'ops', 'theirs'], 'sam: ops and his direct conversation with bob');
    assert.deepEqual(ids('flamingo', null), ['html'], 'the join key alone: public channels');
    assert.deepEqual(ids('from:me', null), []);
  });

  test('words holding HTML stay text, the matches marked', () => {
    const r = search('flamingo bold').results[0];
    const html = f.searchHighlight(r.snippet, f.searchParse('flamingo bold').terms);
    assert.ok(html.includes('&lt;b&gt;<mark class="cv-mark">bold</mark>&lt;/b&gt;'), html);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html);
    assert.ok(html.includes('<mark class="cv-mark">flamingo</mark>'), html);
    assert.ok(!/<script|<b>/.test(html), html);
    assert.deepEqual(Array.from(f.searchMarks('Le café est prêt', ['cafe'])).map((x) => Array.from(x)), [[3, 7]], 'marked in the words as written');
  });

  test('a long message: the piece around the first match', () => {
    const text = `${'Nothing to see here. '.repeat(100)}The flamingo is pink. ${'More of nothing. '.repeat(50)}`;
    const s = f.searchSnippet(text, ['flamingo']);
    assert.ok(s.startsWith('…') && s.endsWith('…'), s);
    assert.ok(s.includes('The flamingo is pink.'), s);
    assert.ok(s.length <= 224, `${s.length} characters`);
    assert.equal(f.searchSnippet('short words', ['short']), 'short words');
  });

  test("rep.mjs's copy of each function is the page's, word for word", () => {
    for (const name of SHARED) assert.equal(pageFn(name).replace(/^ {2}/gm, ''), repFn(name), `${name} differs between public/index.html and rep.mjs`);
  });
});

// ---------------------------------------------------------------- a sealed envelope, by hand (API.md), signed with the sender's keys.json

const b64 = (b) => Buffer.from(b).toString('base64url');
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function gcm(key, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function seal({ keys, from, channel, to = [], readers, text }) {
  const cek = crypto.randomBytes(32);
  const body = gcm(cek, Buffer.from(JSON.stringify({ text, files: [] })));
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const wrapped = {};
  for (const r of readers) {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: r.keys.seal }, format: 'jwk' });
    const kek = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), Buffer.concat([epk, Buffer.from(r.keys.seal, 'base64url')]), 'obysphere/seal/v1', 32));
    const w = gcm(kek, cek);
    wrapped[r.id] = { iv: b64(w.iv), ct: b64(w.ct), tag: b64(w.tag) };
  }
  const sealed = { v: 1, epk: b64(epk), iv: b64(body.iv), ct: b64(body.ct), tag: b64(body.tag), to: wrapped, sig: '' };
  const digest = crypto.createHash('sha256').update(canonical({ v: 1, from, channel, to: [...to].sort(), replyTo: null, cause: null, depth: 0, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct, tag: sealed.tag, readers: Object.keys(wrapped).sort() })).digest();
  sealed.sig = b64(crypto.sign(null, digest, crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: keys.sign.d, x: keys.sign.x }, format: 'jwk' })));
  return sealed;
}

// ---------------------------------------------------------------- the proxy: every request kept, and the relay's words altered on demand

// Between alice's Oby and the relay: log keeps { method, url, tool } of each request; rewrite maps a
// message id to what the relay is made to say about it (in GET /api/messages answers); inject()
// adds an event to the live streams going through it.
function startProxy(target) {
  const log = [];
  const streams = new Map(); // a live stream going through it -> its URL
  const rewrite = new Map();
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, tool: req.headers['x-sphere-tool'] || null });
    const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      if (/^text\/event-stream/.test(r.headers['content-type'] || '')) {
        res.writeHead(r.statusCode, r.headers);
        streams.set(res, req.url);
        res.on('close', () => streams.delete(res));
        r.pipe(res);
        return;
      }
      if (req.method !== 'GET' || !req.url.startsWith('/api/messages') || !rewrite.size) {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
        return;
      }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => (body += d));
      r.on('end', () => {
        let out = body;
        try {
          const j = JSON.parse(body);
          const fix = (m) => (m && rewrite.has(m.id) ? rewrite.get(m.id)(m) : m);
          if (Array.isArray(j.messages)) j.messages = j.messages.map(fix);
          if (j.message) j.message = fix(j.message);
          if (Array.isArray(j.replies)) j.replies = j.replies.map(fix);
          out = JSON.stringify(j);
        } catch {}
        const h = { ...r.headers };
        delete h['content-length'];
        delete h['transfer-encoding'];
        res.writeHead(r.statusCode, { ...h, 'content-length': Buffer.byteLength(out) });
        res.end(out);
      });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        log,
        rewrite,
        inject: (ev, data) => streams.forEach((u, s) => s.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)),
        streams: () => [...streams.values()], // the URLs of the live streams open through it
        close: () => {
          for (const s of streams.keys()) s.destroy();
          return new Promise((r) => server.close(r));
        },
      }),
    ),
  );
}

// a request to a member's console, at 127.0.0.1 with its own Host (no lookup of <handle>.localhost)
function toConsole(consoleUrl, { method = 'GET', path: p = '/', body, headers = {} } = {}) {
  const u = new URL(consoleUrl);
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: p, method, headers: { host: u.host, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {}
        resolve({ status: res.statusCode, json, text: out });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const LOCAL = { 'x-obysphere-console': '1' };

// an MCP server (rep.mjs mcp) to talk to: request(method, params) gives the answer
function mcpSession(world, args, env = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', ...args], { env: { ...world.env(), TMPDIR: world.tmp, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  world.keep(`rep.mjs mcp ${args.join(' ')}`, proc);
  const waiting = new Map();
  let buf = '';
  let n = 0;
  proc.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      } catch {}
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 120000);
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { request, close: () => proc.kill() };
}

// ---------------------------------------------------------------- your Oby's index, in your console

describe("your Oby's index, in your console: a sealed Sphere with alice, bob and sam", { timeout: 300000 }, () => {
  let world, proxy, alice, base, stream, plainFile;
  const at = {}; // handle -> { id, token, keys }
  const id = {}; // what was said -> message id
  const KEY = 'join-key-search-tests-0123456789';
  const ADMIN = 'admin-key-search-tests-0123456789';
  const env = () => ({ TMPDIR: world.tmp });
  const relayCall = async (method, url, { tok, key, admin, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (key) h['x-sphere-key'] = key;
    if (admin) h['x-admin-key'] = admin;
    if (body !== undefined && !Buffer.isBuffer(body)) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const post = (who, body) => relayCall('POST', '/api/messages', { tok: at[who].token, body }).then((j) => j.message);
  const sealedPost = (who, { channel, readers, text }) => post(who, { channel, text: '', to: [], sealed: seal({ keys: at[who].keys, from: at[who].id, channel, readers: readers.map((n) => ({ id: at[n].id, keys: { seal: at[n].keys.seal.x } })), text }) });
  const loadAgent = (name) => {
    const prof = JSON.parse(fs.readFileSync(path.join(world.home, name, 'profile.json'), 'utf8'));
    at[name] = { id: prof.agent.id, token: prof.token, keys: JSON.parse(fs.readFileSync(path.join(world.home, name, 'keys.json'), 'utf8')) };
  };
  const find = (q, extra = {}) => toConsole(alice.url, { method: 'POST', path: '/local/search', headers: LOCAL, body: { q, ...extra } });
  const words = (r) => r.json.results.map((x) => Object.keys(id).find((k) => id[k] === x.id) || x.id).sort();
  // many posts at once, a few at a time
  const many = async (n, fn) => {
    for (let i = 0; i < n; i += 25) await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, k) => fn(i + k)));
  };

  before(async () => {
    world = new World();
    // the relay, not sealed yet: what was said before sealing stays plain on it
    const port = await freePort();
    world.sphere = { name: 'Search Sphere', url: `http://127.0.0.1:${port}`, key: KEY, admin: ADMIN };
    base = world.sphere.url;
    world.relay = world.start('relay', 'server.mjs', ['--port', String(port), '--host', '127.0.0.1', '--data', path.join(world.tmp, 'relay'), '--name', 'Search Sphere'], {
      ...process.env,
      HOME: world.userHome,
      TMPDIR: world.tmp,
      SPHERE_KEY: KEY,
      SPHERE_ADMIN_KEY: ADMIN,
      SPHERE_SEALED: '0',
      SPHERE_STORE: 'fs',
      SPHERE_WRITES_PER_MIN: '1000000',
      SPHERE_ASKS_PER_MIN: '1000000',
    });
    await until(async () => (await fetch(base + '/healthz')).ok, 'the relay to start');
    proxy = await startProxy(base);

    await world.join('bob', 'Bob Test', 'Knows the payments service');
    await world.join('sam', 'Sam Test', 'Knows the design system');
    loadAgent('bob');
    loadAgent('sam');
    // a private channel and a direct conversation, both bob's and sam's: alice is in neither
    await relayCall('POST', '/api/channels', { tok: at.bob.token, body: { name: 'ops', private: true, members: [at.sam.id] } });
    const dmBs = (await relayCall('POST', '/api/dm', { tok: at.bob.token, body: { with: 'sam' } })).channel.name;

    // plain, before sealing: an admin's relay would hand alice all of these
    id.generalPlain = (await post('bob', { channel: 'general', text: 'A general flamingo, plain, from before sealing.' })).id;
    id.opsPlain = (await post('bob', { channel: 'ops', text: 'An ops flamingo, plain.' })).id;
    id.theirsPlain = (await post('sam', { channel: dmBs, text: 'Their own flamingo, plain.' })).id;
    id.tombstone = (await post('bob', { channel: 'general', text: 'A tombstone flamingo, deleted later.' })).id;
    id.retries = (await post('bob', { channel: 'general', text: 'The payment RETRIES happen three times, then we give up.' })).id;
    id.cafe = (await post('sam', { channel: 'design', text: 'Le café est prêt.' })).id;
    id.japanese = (await post('sam', { channel: 'general', text: '支払いの再試行は三回です' })).id;
    const file = await relayCall('POST', '/api/files', { tok: at.bob.token, body: Buffer.from('Retry three times.\n'), headers: { 'content-type': 'text/plain', 'x-file-name': 'retry-plan.md' } });
    plainFile = file.file.id;
    id.file = (await post('bob', { channel: 'general', text: 'The plan, attached.', files: [{ id: plainFile }] })).id;
    await many(2250, (i) => post(i % 2 ? 'sam' : 'bob', { channel: 'general', text: `Filler note ${i}, about nothing much.` }));

    // sealed from here on; bob's posts before alice joins aren't sealed for her
    await relayCall('POST', '/api/admin/policy', { admin: ADMIN, body: { sealed: true } });
    await many(30, (i) => sealedPost('bob', { channel: 'general', readers: ['bob', 'sam'], text: `A sealed flamingo from before alice joined (${i}).` }));

    // alice joins through the proxy, and is an admin: the relay lets her read every channel
    world.sphere = { ...world.sphere, url: proxy.url };
    await world.join('alice', 'Alice Test', 'Knows the release notes');
    world.sphere = { ...world.sphere, url: base };
    await world.claimAdmin('alice');
    loadAgent('alice');
    const dmAb = (await relayCall('POST', '/api/dm', { tok: at.bob.token, body: { with: 'alice' } })).channel.name;
    id.generalSealed = (await sealedPost('bob', { channel: 'general', readers: ['bob', 'sam', 'alice'], text: 'A general flamingo, sealed for all three.' })).id;
    id.lunch = (await sealedPost('bob', { channel: dmAb, readers: ['bob', 'alice'], text: 'Lunch at noon? A flamingo, just between us.' })).id;
    id.forged = (await sealedPost('bob', { channel: dmAb, readers: ['bob', 'alice'], text: 'A forged flamingo.' })).id;
    id.opsSealed = (await sealedPost('bob', { channel: 'ops', readers: ['bob', 'sam'], text: 'An ops flamingo, sealed.' })).id;
    await many(150, (i) => sealedPost(i % 2 ? 'sam' : 'bob', { channel: 'general', readers: ['bob', 'sam', 'alice'], text: `Sealed filler ${i}.` }));

    // what a malicious relay says: one of bob's messages with a field its signature covers changed;
    // and #139's tombstone of a message (no words, no files, `deleted`)
    proxy.rewrite.set(id.forged, (m) => ({ ...m, depth: 1 }));
    proxy.rewrite.set(id.tombstone, (m) => ({ id: m.id, ts: m.ts, channel: m.channel, from: m.from, kind: m.kind, to: m.to, replyTo: m.replyTo, cause: m.cause, depth: m.depth, deleted: { at: new Date().toISOString(), by: m.from } }));

    // alice's console; a page loads (the history is read now), and its live stream stays open
    const cport = await freePort();
    const proc = world.start('alice: rep.mjs ui', 'rep.mjs', ['ui', '--profile', 'alice', '--port', String(cport)], { ...world.env(), ...env() });
    await world.waitFor(proc, /your console for/);
    alice = { url: `http://alice.localhost:${cport}/`, proc };
    const page = await toConsole(alice.url);
    assert.equal(page.status, 200);
    const u = new URL(alice.url);
    stream = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: '/api/stream', headers: { host: u.host, accept: 'text/event-stream' } }, (res) => {
        res.on('data', () => {});
        resolve(req);
      });
      req.on('error', reject);
      req.end();
    });
  });

  after(async () => {
    stream?.destroy();
    await proxy?.close();
    await world?.stop();
  });

  test('the history is read in pages, and searching it waits for nothing more', async () => {
    const r = await find('flamingo', { wait: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.building, false);
    const pages = proxy.log.filter((x) => x.method === 'GET' && /^\/api\/messages\?limit=\d+&before=m_/.test(x.url));
    assert.ok(pages.length >= 11, `read back in ${pages.length + 1} pages`);
    const all = (await find('nothing-matches-this-zzz')).json;
    assert.ok(all.searched + all.notOpenable >= 2400, `${all.searched} searched, ${all.notOpenable} not openable`);
    assert.equal(all.total, 0);
    assert.ok(all.oldest && Date.parse(all.oldest) <= Date.now());
  });

  test('a file sent in the open still comes through the console, the index built: it keeps only the keys of sealed files', async () => {
    const r = await toConsole(alice.url, { path: `/api/files/${plainFile}`, headers: LOCAL });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, 'Retry three times.\n');
  });

  test('alice finds her direct messages and public posts, never a conversation she is not in, though she is an admin', async () => {
    const r = await find('flamingo');
    assert.deepEqual(words(r), ['forged', 'generalPlain', 'generalSealed', 'lunch']);
    assert.equal(r.json.total, 4);
    assert.equal(r.json.notOpenable, 30, 'the posts sealed before she joined: counted, not found');
    for (const x of r.json.results) assert.ok(x.channel === 'general' || x.with === at.bob.id, JSON.stringify(x));
    const lunch = r.json.results.find((x) => x.id === id.lunch);
    assert.equal(lunch.snippet, 'Lunch at noon? A flamingo, just between us.');
    assert.equal(lunch.with, at.bob.id);
    assert.equal(lunch.verified, true);
    assert.deepEqual(r.json.agents.map((a) => a.name).sort(), ['bob']);
    // in a channel she isn't in, nothing, not even a count
    for (const q of ['in:#ops flamingo', 'in:ops', 'with:sam']) {
      const x = (await find(q)).json;
      assert.deepEqual([x.total, x.searched, x.notOpenable], [0, 0, 0], q);
    }
  });

  test('words, phrases, accents, other alphabets and the filters, over what the relay keeps', async () => {
    assert.deepEqual(words(await find('"payment retries"')), ['retries']);
    assert.deepEqual(words(await find('retries PAYMENT')), ['retries']);
    assert.deepEqual(words(await find('cafe')), ['cafe']);
    assert.deepEqual(words(await find('再試行')), ['japanese']);
    assert.deepEqual(words(await find('with:bob')), ['forged', 'lunch']);
    assert.deepEqual(words(await find('from:sam cafe')), ['cafe']);
    assert.deepEqual(words(await find('in:#general flamingo')), ['generalPlain', 'generalSealed']);
    const files = await find('has:file');
    assert.deepEqual(words(files), ['file']);
    assert.deepEqual(files.json.results[0].files, ['retry-plan.md']);
    // results a page at a time, the newest first
    const first = (await find('filler', { limit: 50 })).json;
    assert.equal(first.results.length, 50);
    assert.equal(first.more, true);
    assert.ok(first.total >= 2400);
    const second = (await find('filler', { limit: 50, before: first.results[49].id })).json;
    assert.equal(second.results.length, 50);
    assert.ok(second.results[0].ts <= first.results[49].ts);
    assert.ok(!second.results.some((x) => first.results.some((y) => y.id === x.id)));
  });

  test('a forged signature is found, and marked', async () => {
    const r = (await find('forged')).json;
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].id, id.forged);
    assert.equal(r.results[0].verified, false);
  });

  test("a deleted message (#139) isn't found: its tombstone, or a message-delete event, takes it out at once", async () => {
    assert.equal((await find('tombstone')).json.total, 0, 'a message carrying `deleted` is never indexed');
    // a new message, live, through the page's stream
    const live = await sealedPost('bob', { channel: (await relayCall('POST', '/api/dm', { tok: at.bob.token, body: { with: 'alice' } })).channel.name, readers: ['bob', 'alice'], text: 'A pelican, just now.' });
    await until(async () => (await find('pelican')).json.total === 1, 'the live message in the index');
    proxy.inject('message-delete', { id: live.id, channel: live.channel, deleted: { at: new Date().toISOString(), by: at.bob.id } });
    await until(async () => (await find('pelican')).json.total === 0, 'the deleted message out of the index');
  });

  test('a search, and a click on a result, send the relay nothing, and the words are in no URL', async () => {
    await sleep(1000); // what the last live message set off (its notification) is done
    const mark = proxy.log.length;
    for (const q of ['flamingo', '"payment retries"', 'from:bob has:file']) assert.equal((await find(q)).status, 200);
    const around = await toConsole(alice.url, { method: 'POST', path: '/local/search/around', headers: LOCAL, body: { id: id.lunch } });
    assert.equal(around.status, 200, around.text);
    await sleep(500);
    assert.deepEqual(proxy.log.slice(mark), [], 'no request reached the relay');
    for (const w of ['flamingo', 'payment', 'retries', 'pelican']) assert.ok(!proxy.log.some((x) => decodeURIComponent(x.url).toLowerCase().includes(w)), `"${w}" in no URL`);
    // the conversation around a result, from the index, as the page shows messages
    const a = around.json;
    assert.equal(a.id, id.lunch);
    assert.ok(a.messages.every((m) => m.channel === a.channel));
    const lunch = a.messages.find((m) => m.id === id.lunch);
    assert.equal(lunch.text, 'Lunch at noon? A flamingo, just between us.');
    assert.deepEqual([lunch.open, lunch.verified], [true, true]);
    assert.ok(lunch.sealed.to[at.alice.id] && lunch.sealed.bytes > 0, 'sealed, for whom, and how big');
    assert.equal(a.messages.find((m) => m.id === id.forged).verified, false);
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search/around', headers: LOCAL, body: { id: id.opsPlain } })).status, 404, "a private channel she isn't in");
  });

  test('/local/search takes POST only, with the console header, from its own origin', async () => {
    const body = { q: 'flamingo' };
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body })).status, 403, 'no header');
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body, headers: { ...LOCAL, origin: 'http://evil.example' } })).status, 403, 'another origin');
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body, headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' } })).status, 403, 'another site');
    assert.equal((await toConsole(alice.url, { method: 'GET', path: '/local/search?q=flamingo', headers: LOCAL })).status, 405, 'GET, which would put the words in a URL');
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body, headers: { ...LOCAL, host: 'evil.example' } })).status, 421, 'another Host');
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body: { q: '' }, headers: LOCAL })).status, 400);
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body: { q: 'x'.repeat(501) }, headers: LOCAL })).status, 400);
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body: { q: 'x', limit: 500 }, headers: LOCAL })).status, 400);
    assert.equal((await toConsole(alice.url, { method: 'POST', path: '/local/search', body: '[1]', headers: LOCAL })).status, 400);
  });

  test('obysphere search asks the running console: the relay sees nothing', async () => {
    const mark = proxy.log.length;
    const r = await world.rep(['search', 'flamingo', '--profile', 'alice'], { env: env() });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^4 messages match:/m);
    assert.match(r.out, /@bob · with @bob, directly/);
    assert.match(r.out, /Lunch at noon\? A flamingo, just between us\./);
    assert.match(r.out, /its signature doesn't verify/);
    assert.match(r.out, /30 more messages were sealed for others, or before you joined: your Oby can't open them\./);
    assert.ok(!/console isn't running/.test(r.out), r.out);
    const j = await world.rep(['search', 'payment', '--from', 'bob', '--in', '#general', '--json', '--profile', 'alice'], { env: env() });
    const out = JSON.parse(j.out.slice(j.out.indexOf('{')));
    assert.equal(out.via, 'console');
    assert.deepEqual(out.results.map((x) => x.id), [id.retries]);
    assert.deepEqual(proxy.log.slice(mark), [], 'no request reached the relay');
  });

  test("sphere_search: in your own session, untagged and fenced; never in the session that answers for others", async () => {
    const mine = mcpSession(world, ['--profile', 'alice'], env());
    await mine.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const { result } = await mine.request('tools/list');
    const tool = result.tools.find((t) => t.name === 'sphere_search');
    assert.ok(tool, 'sphere_search in your own session');
    assert.deepEqual(tool.inputSchema.required, ['query']);
    const call = await mine.request('tools/call', { name: 'sphere_search', arguments: { query: 'flamingo with:bob' } });
    const text = call.result.content[0].text;
    assert.ok(!call.result.isError, text);
    assert.match(text, /^2 messages match\./);
    const fence = /\n(QUOTED-[0-9A-F]{12})\n([\s\S]*)\n\1$/.exec(text);
    assert.ok(fence, `the results are fenced: ${text}`);
    assert.match(fence[2], /Lunch at noon\? A flamingo, just between us\./);
    assert.match(fence[2], /signature doesn't verify/);
    mine.close();
    // instruments tag their requests, and anyone with the join key sees the counts: this one never
    assert.ok(!proxy.log.some((x) => x.tool === 'sphere_search'), 'no request tagged sphere_search');
    const stats = await relayCall('GET', '/api/stats', { key: KEY });
    assert.equal(stats.tools?.sphere_search, undefined, JSON.stringify(stats.tools));

    const outbox = fs.mkdtempSync(path.join(world.tmp, 'outbox-'));
    const answering = mcpSession(world, ['--profile', 'alice', '--as-session'], { ...env(), SPHERE_OUTBOX: outbox, SPHERE_DEPTH: '1', SPHERE_ASKER: at.bob.id, SPHERE_CHANNEL: 'general' });
    await answering.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const names = (await answering.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('sphere_read') && !names.includes('sphere_search'), names.join(', '));
    const refused = await answering.request('tools/call', { name: 'sphere_search', arguments: { query: 'flamingo' } });
    assert.match(refused.error?.message || '', /unknown tool sphere_search/);
    answering.close();
  });

  test('a private channel she is added to is read at once, and what she can open in it is found', async () => {
    assert.equal((await find('"ops flamingo"')).json.total, 0);
    await relayCall('POST', '/api/channels/ops/members', { tok: at.bob.token, body: { add: [at.alice.id] } });
    await until(async () => (await find('"ops flamingo"')).json.total === 1, 'the channel read');
    const r = (await find('in:#ops')).json;
    assert.deepEqual(words({ json: r }), ['opsPlain']);
    assert.equal(r.notOpenable, 1, 'what was sealed in it for bob and sam: counted');
  });

  test('a catch-up reads back to where the last read stopped, though the page read the newest messages first', async () => {
    // no page has its stream open now: what's said reaches the index by what the page reads, and the catch-ups
    // and the console's stream to the relay ends with it, by the next thing the relay sends (its
    // ping, every 20 seconds; here an event), though a garbage collection made Node's fetch miss the abort
    stream.destroy();
    await until(() => {
      proxy.inject('nothing', {});
      return !proxy.streams().some((u) => /role=console/.test(u));
    }, "the console's live stream to the relay to end");
    const dm = (await relayCall('POST', '/api/dm', { tok: at.bob.token, body: { with: 'alice' } })).channel.name;
    id.gannet = (await sealedPost('bob', { channel: dm, readers: ['bob', 'alice'], text: 'A gannet, the first of many.' })).id;
    await many(259, (i) => sealedPost(i % 2 ? 'sam' : 'bob', { channel: 'general', readers: ['bob', 'sam', 'alice'], text: `Gap filler ${i}.` }));
    // more than a page of history (200) since the last read; a page opens and reads the newest few first
    const newest = await toConsole(alice.url, { path: '/api/messages?limit=10', headers: LOCAL });
    assert.equal(newest.status, 200, newest.text);
    const last = newest.json.messages.at(-1);
    await until(async () => (await find(last.text)).json.results.some((x) => x.id === last.id), 'what the page read, in the index');
    assert.equal((await find('gannet')).json.total, 0, 'not read yet');
    // the page loads: a catch-up, back to the last message an earlier read reached
    assert.equal((await toConsole(alice.url)).status, 200);
    const r = (await find('gannet', { wait: true })).json;
    assert.deepEqual(words({ json: r }), ['gannet'], 'the oldest of what was said since the last read');
    assert.equal((await find('"gap filler"', { limit: 1 })).json.total, 259);
  });

  test('with no console running, obysphere search reads the history itself, and says so', async () => {
    alice.proc.proc.kill('SIGTERM');
    await alice.proc.exited;
    const mark = proxy.log.length;
    const r = await world.rep(['search', 'flamingo', '--profile', 'alice'], { env: env() });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Your console isn't running, so your Oby reads the Sphere's history now to search it/);
    assert.match(r.out, /^5 messages match:/m, 'with the one in #ops, which she is in now');
    const reads = proxy.log.slice(mark);
    assert.ok(reads.some((x) => /^\/api\/messages\?limit=/.test(x.url)), 'it read the history');
    assert.ok(reads.every((x) => !x.tool), 'untagged');
    assert.ok(reads.every((x) => !decodeURIComponent(x.url).includes('flamingo')), 'the words in no URL');

    // sphere_search too: its own read, untagged, so the Sphere counts no sphere_search
    const again = proxy.log.length;
    const mine = mcpSession(world, ['--profile', 'alice'], env());
    await mine.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const call = await mine.request('tools/call', { name: 'sphere_search', arguments: { query: 'gannet' } });
    mine.close();
    const text = call.result.content[0].text;
    assert.match(text, /^1 message matches\..*Your console isn't running, so your Oby read the Sphere's history just now to search it\./s);
    const its = proxy.log.slice(again).filter((x) => x.url.startsWith('/api/messages'));
    assert.ok(its.length >= 2, `it read the history (${its.length} pages)`);
    assert.deepEqual(its.filter((x) => x.tool), [], 'untagged');
    const stats = await relayCall('GET', '/api/stats', { key: KEY });
    assert.equal(stats.tools?.sphere_search, undefined, JSON.stringify(stats.tools));
  });
});

// ---------------------------------------------------------------- a relay that never ends its history

describe('a relay that sends an endless history', { timeout: 180000 }, () => {
  let world, server, url;
  let messageReads = 0;
  let made = 0;
  before(async () => {
    world = new World();
    // every page full, every message new and older than the last: there's no start to reach
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === '/api/info') return send({ sphere: { name: 'Endless', policy: { sealed: false } }, me: { id: 'a_endless', name: 'endless', owner: 'Endless Test' } });
      if (u.pathname === '/api/agents') return send({ agents: [{ id: 'a_endless', name: 'endless', owner: 'Endless Test' }, { id: 'a_talker', name: 'talker', owner: 'Talker Test' }] });
      if (u.pathname === '/api/channels') return send({ channels: [{ name: 'general', kind: 'public', members: [] }] });
      if (u.pathname === '/api/messages') {
        messageReads++;
        const limit = Math.min(1000, Number(u.searchParams.get('limit')) || 100);
        const page = [];
        for (let i = 0; i < limit; i++) {
          made++;
          page.unshift({ id: `m_e${made}`, ts: new Date(Date.UTC(2026, 10, 25) - made * 1000).toISOString(), channel: 'general', from: 'a_talker', kind: 'post', to: [], text: `hello number ${made}`, files: [], depth: 0, replyTo: null, cause: null, meta: {} });
        }
        return send({ messages: page });
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not here"}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
    // a profile joined to it, written as join writes one (its keys are made on first use)
    const dir = path.join(world.home, 'endless');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: 'endless', sphere: url, sphereName: 'Endless', token: 'endless-token-0123456789', agent: { id: 'a_endless', name: 'endless', owner: 'Endless Test' }, cwd: world.tmp, runtime: 'claude', joinedAt: new Date().toISOString() }), { mode: 0o600 });
  });
  after(async () => {
    await new Promise((r) => server?.close(r));
    await world?.stop();
  });

  test('it is cut off at the newest 20,000 messages', async () => {
    const r = await world.rep(['search', 'hello', '--profile', 'endless', '--json'], { env: { TMPDIR: world.tmp }, timeoutMs: 150000 });
    assert.equal(r.code, 0, r.out.slice(-2000));
    const out = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.equal(out.via, 'oby');
    assert.equal(out.total, 20000);
    assert.equal(out.searched, 20000);
    assert.equal(out.results.length, 20);
    assert.equal(out.results[0].snippet, 'hello number 1', 'the newest first');
    assert.ok(messageReads <= 101, `${messageReads} pages read`);
  });
});

// ---------------------------------------------------------------- a relay that says odd things (#139's tombstones, a channel it listed late)

// Its history, oldest first: 50 notes and one in a direct conversation with the reader, then 250
// messages deleted on the Sphere (#139's tombstones, more than a page of them), 10 newer notes, and
// one in a private channel the reader isn't in. /api/channels lists the private channel only from
// its second answer on, and the direct conversation from its third (as if each was made a moment
// before the read reached it), so each is heard of first in a page of its own.
describe('a relay that sends a page of deleted messages, and channels it listed late', { timeout: 180000 }, () => {
  let world, server, url;
  let channelReads = 0;
  const reader = { id: 'a_reader', name: 'reader', owner: 'Reader Test' };
  const writer = { id: 'a_writer', name: 'writer', owner: 'Writer Test' };
  const history = [];
  const t0 = Date.UTC(2026, 10, 20);
  const note = (id, channel, text) => ({ id, ts: new Date(t0 + history.length * 1000).toISOString(), channel, from: writer.id, kind: 'post', to: [], text, files: [], depth: 0, replyTo: null, cause: null, meta: {} });
  for (let i = 0; i < 50; i++) history.push(note(`m_old${i}`, 'general', `An osprey, old note ${i}.`));
  history.push(note('m_direct', 'dm-reader-writer', 'A direct osprey, for the reader.'));
  for (let i = 0; i < 250; i++) {
    const at = new Date(t0 + history.length * 1000).toISOString();
    history.push({ id: `m_gone${i}`, ts: at, channel: 'general', from: writer.id, kind: 'post', to: [], replyTo: null, cause: null, depth: 0, claimedAt: null, startedAt: null, deleted: { at, by: writer.id } });
  }
  for (let i = 0; i < 10; i++) history.push(note(`m_new${i}`, 'general', `A newer note ${i}.`));
  history.push(note('m_secret', 'secret', 'A secret osprey, for the writer only.'));

  before(async () => {
    world = new World();
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (o, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === '/api/info') return send({ sphere: { name: 'Odd', policy: { sealed: false } }, me: reader });
      if (u.pathname === '/api/agents') return send({ agents: [reader, writer] });
      if (u.pathname === '/api/channels') {
        channelReads++;
        const secret = { name: 'secret', kind: 'private', members: [writer.id] };
        const direct = { name: 'dm-reader-writer', kind: 'dm', members: [reader.id, writer.id] };
        return send({ channels: [{ name: 'general', kind: 'public', members: [] }, ...(channelReads > 1 ? [secret] : []), ...(channelReads > 2 ? [direct] : [])] });
      }
      if (u.pathname === '/api/messages') {
        const ch = u.searchParams.get('channel');
        const list = ch ? history.filter((m) => m.channel === ch) : history;
        const b = u.searchParams.get('before');
        const hi = b ? list.findIndex((m) => m.id === b) : list.length;
        const limit = Math.min(1000, Number(u.searchParams.get('limit')) || 100);
        return send({ messages: hi < 0 ? [] : list.slice(Math.max(0, hi - limit), hi) });
      }
      send({ error: 'not here' }, 404);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
    const dir = path.join(world.home, 'reader');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: 'reader', sphere: url, sphereName: 'Odd', token: 'reader-token-0123456789', agent: reader, cwd: world.tmp, runtime: 'claude', joinedAt: new Date().toISOString() }), { mode: 0o600 });
  });
  after(async () => {
    await new Promise((r) => server?.close(r));
    await world?.stop();
  });

  test('a page of deleted messages is read past, and a channel listed late is asked about before anything in it is kept', async () => {
    const r = await world.rep(['search', 'osprey', '--profile', 'reader', '--json', '--limit', '100'], { env: { TMPDIR: world.tmp } });
    assert.equal(r.code, 0, r.out.slice(-2000));
    const out = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.equal(out.via, 'oby');
    assert.equal(out.total, 51, 'the notes from before the deleted ones, and the direct one');
    assert.equal(out.results[0].id, 'm_direct', 'the direct conversation, the reader is in it');
    assert.ok(out.results.slice(1).every((x) => /^m_old\d+$/.test(x.id)), JSON.stringify(out.results.map((x) => x.id)));
    assert.equal(out.searched, 61, "every note it could open: none deleted, none in the private channel it isn't in");
    assert.ok(channelReads >= 2, 'it asked the relay again about the channels it had not heard of');
  });

  test("a console that hasn't read the history yet reads it for the first search from a terminal, and says so", async () => {
    const port = await freePort();
    const proc = world.start('reader: rep.mjs ui', 'rep.mjs', ['ui', '--profile', 'reader', '--port', String(port)], { ...world.env(), TMPDIR: world.tmp });
    await world.waitFor(proc, /your console for/);
    const first = await world.rep(['search', 'osprey', '--profile', 'reader'], { env: { TMPDIR: world.tmp } });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /^51 messages match/m);
    assert.match(first.out, /Your console hadn't read the Sphere's history yet, so your Oby read it just now to search it\. The Sphere saw that read, never your words\./);
    assert.ok(!/console isn't running/.test(first.out), first.out);
    const second = await world.rep(['search', 'osprey', '--profile', 'reader', '--json'], { env: { TMPDIR: world.tmp } });
    const out = JSON.parse(second.out.slice(second.out.indexOf('{')));
    assert.equal(out.via, 'console');
    assert.equal(out.total, 51);
    assert.equal(out.readNow, undefined, 'read once: the next search says nothing of it');
    assert.ok(!/hadn't read/.test(second.out), second.out);
  });
});
