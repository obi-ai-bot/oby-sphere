// What an answer may see of its channel: this Oby can open more than the asker may read. With a
// real relay and fake runtimes first on PATH (no model, no network): carol's sealed ask to bob,
// bob's sealed reply to her, and dave's plain ask that waits for bob's OK are in #general when
// alice asks bob. The prompt of bob's answer to alice shows those as markers, without their words
// or who else reads them, while carol's post sealed for everyone (alice too) is there in full;
// carol, asking next, sees her own. sphere_read in the answering session shows the same, and
// with no asker named it shows no sealed words at all; bob's own session still opens everything.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-sealed-context-0123456789';
const ADMIN = 'admin-key-sealed-context-012345678';
// the words that must not reach alice, and the ones that must
const CAROL_ASK = 'CAROL-SEALED-ZQ7 the merger closes on Friday';
const BOB_TO_CAROL = 'BOB-PRIVATE-REPLY-ZQ7 noted, I will keep it quiet';
const DAVE_ASK = 'DAVE-WAITING-ZQ7 what does Bob earn?';
const CAROL_POST = 'CAROL-SHARED-ZQ7 lunch is at noon for everyone';
const ALICE_ASK = 'ALICE-ASKS-ZQ7 what is new in here?';
const BOB_TO_ALICE = 'BOB-TO-ALICE-ZQ7 nothing much';
const CAROL_AGAIN = 'CAROL-AGAIN-ZQ7 anything for me?';
const RESERVED = new Set([4848, 4849, 4850]); // the demo's ports
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  }).then((p) => (RESERVED.has(p) ? freePort() : p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const stop = (p) =>
  new Promise((resolve) => {
    if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
    const t = setTimeout(resolve, 3000);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.kill('SIGTERM');
  });

describe("an answer's context: what the asker may see, not all its Oby can open", () => {
  let relay, base, tmp, home, homeDir, work, cfg, fake, ids, bob;
  let bobOut = '';
  const procs = [];
  // fakes first on PATH; HOME, the profiles and the app folder are this test's own; notifications only to a log
  const env = (extra = {}) => ({
    ...process.env,
    HOME: homeDir,
    OBYSPHERE_HOME: home,
    OBYSPHERE_APP_HOME: path.join(tmp, 'app-home'),
    OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.jsonl'),
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_APPROVE_WAIT_SEC: '600',
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_CHROME: '0',
    CLAUDE_CONFIG_DIR: cfg,
    PATH: `${path.dirname(fake.claude)}${path.delimiter}${process.env.PATH}`,
    ...extra,
  });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 60000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out, code });
      });
    });
  const profile = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const call = async (method, url, { tok, admin, body } = {}) => {
    const h = {};
    if (tok) h.authorization = `Bearer ${tok}`;
    if (admin) h['x-admin-key'] = admin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  // the prompt of bob's answer to the ask with these words
  const promptFor = (words) => {
    const c = fake.calls().filter((x) => x.bin === 'claude' && x.prompt.includes(words));
    assert.equal(c.length, 1, `one answer run for "${words}"\n${bobOut.slice(-3000)}`);
    return c[0];
  };
  // an MCP client over stdio: rep.mjs mcp, as a runtime runs it
  const mcp = (args, extra = {}) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', 'bob', ...args], { env: env(extra) });
    procs.push(p);
    let buf = '';
    let n = 0;
    const waiting = new Map();
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined && waiting.has(m.id)) {
          waiting.get(m.id)(m);
          waiting.delete(m.id);
        }
      }
    });
    const req = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++n;
        waiting.set(id, resolve);
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    return {
      read: async () => {
        await req('initialize', { protocolVersion: '2025-06-18' });
        const r = await req('tools/call', { name: 'sphere_read', arguments: { channel: 'general', limit: 50 } });
        await stop(p);
        assert.ok(!r.result.isError, r.result.content[0].text);
        return r.result.content[0].text;
      },
    };
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-sealed-context-')));
    home = path.join(tmp, 'reps');
    homeDir = path.join(tmp, 'home');
    work = path.join(tmp, 'work');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [home, homeDir, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({});
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // unsealed to start with, so dave's ask can be plain; sealing goes on below
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, HOME: homeDir, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    await waitFor(async () => {
      try {
        return (await fetch(base + '/healthz')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the relay');
    for (const n of ['alice', 'bob', 'carol', 'dave']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    ids = Object.fromEntries(['alice', 'bob', 'carol', 'dave'].map((n) => [n, profile(n).agent.id]));
    fs.writeFileSync(path.join(home, 'bob', 'profile.json'), JSON.stringify({ ...profile('bob'), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    // bob answers alice and carol; dave's asks wait for him
    fs.writeFileSync(
      path.join(home, 'bob', 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
        access: { default: 'answer', agents: { dave: 'approve' } },
        machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
      }),
      { mode: 0o600 },
    );
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online/.test(bobOut), 15000, `bob online\n${bobOut}`);
    await sleep(300); // its catch-up
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("#general fills up: dave's plain ask waits for bob, carol's ask and bob's reply are sealed, carol's post is for everyone", async () => {
    const asked = await call('POST', '/api/messages', { tok: profile('dave').token, body: { channel: 'general', text: DAVE_ASK, to: [ids.bob] } });
    assert.ok(asked.message, JSON.stringify(asked));
    await waitFor(async () => (await call('GET', `/api/messages/${asked.message.id}`, { tok: profile('alice').token })).message?.waiting?.by === ids.bob, 15000, `dave's ask to wait for bob\n${bobOut.slice(-2000)}`);
    assert.equal((await call('POST', '/api/admin/policy', { admin: ADMIN, body: { sealed: true } })).status, 200);

    fake.control({ text: BOB_TO_CAROL });
    const c = await rep(['ask', 'bob', CAROL_ASK, '--profile', 'carol', '--wait', '45']);
    assert.match(c.out, /"sealed": true/, c.out);
    assert.ok(c.out.includes(BOB_TO_CAROL), `carol got bob's reply\n${c.out}\n${bobOut.slice(-2000)}`);
    const posted = await rep(['post', CAROL_POST, '--profile', 'carol']);
    assert.equal(posted.code, 0, posted.out);

    // what the relay holds: the sealed ones only as envelopes, dave's ask in plain words
    const { messages } = await call('GET', '/api/messages?channel=general', { tok: profile('alice').token });
    const all = JSON.stringify(messages);
    for (const w of [CAROL_ASK, BOB_TO_CAROL, CAROL_POST]) assert.ok(!all.includes(w), `the relay can't read "${w}"`);
    assert.ok(all.includes(DAVE_ASK));
    const post = messages.find((m) => m.from === ids.carol && !m.to.length);
    assert.ok(Object.hasOwn(post.sealed.to, ids.alice), "carol's post is sealed for alice too");
  });

  test("bob's answer to alice: carol's sealed exchange and dave's waiting ask are markers; carol's post is in full", async () => {
    fake.control({ text: BOB_TO_ALICE });
    const a = await rep(['ask', 'bob', ALICE_ASK, '--profile', 'alice', '--wait', '45']);
    assert.ok(a.out.includes(BOB_TO_ALICE), `alice got bob's reply\n${a.out}\n${bobOut.slice(-2000)}`);
    const run = promptFor(ALICE_ASK);
    const context = run.prompt.slice(run.prompt.indexOf('Earlier in the channel'));
    assert.ok(context.startsWith('Earlier in the channel'), run.prompt);
    for (const w of [CAROL_ASK, BOB_TO_CAROL, DAVE_ASK]) assert.ok(!run.prompt.includes(w), `"${w}" is kept from alice's answer\n${run.prompt}`);
    assert.ok(context.includes(CAROL_POST), `a sealed message alice can read is there\n${context}`);
    // what alice could see anyway stays: who wrote to whom
    assert.match(context, /carol \(for Carol Test\) → bob \(for Bob Test\): \[sealed\]/);
    assert.match(context, /bob \(for Bob Test\)( → carol \(for Carol Test\))?: \[sealed\]/);
    assert.match(context, /dave \(for Dave Test\) → bob \(for Bob Test\): \[an ask to you that waits for your owner's OK: not shown\]/);
    assert.ok(!/sealed for/.test(context), 'no reader list beyond the addressees');
    // the answering session's tools know whose answer it is
    assert.equal(run.mcp.mcpServers.obysphere.env.SPHERE_ASKER, ids.alice);
  });

  test("carol's next answer: her own sealed ask and bob's reply to her are there; alice's exchange and dave's ask aren't", async () => {
    fake.control({ text: 'for carol' });
    const c = await rep(['ask', 'bob', CAROL_AGAIN, '--profile', 'carol', '--wait', '45']);
    assert.ok(c.out.includes('for carol'), `${c.out}\n${bobOut.slice(-2000)}`);
    const { prompt } = promptFor(CAROL_AGAIN);
    for (const w of [CAROL_ASK, BOB_TO_CAROL, CAROL_POST]) assert.ok(prompt.includes(w), `"${w}" is carol's to see\n${prompt}`);
    for (const w of [ALICE_ASK, BOB_TO_ALICE, DAVE_ASK]) assert.ok(!prompt.includes(w), `"${w}" is kept from carol's answer\n${prompt}`);
  });

  test('sphere_read while answering shows what the asker may see; with no asker, no sealed words; your own session sees all', async () => {
    const session = { SPHERE_DEPTH: '1', SPHERE_CHANNEL: 'general', SPHERE_ATTACH: '0', SPHERE_CONSULT: '0' };
    const forAlice = await mcp(['--as-session'], { ...session, SPHERE_ASKER: ids.alice }).read();
    for (const w of [CAROL_POST, ALICE_ASK, BOB_TO_ALICE]) assert.ok(forAlice.includes(w), `"${w}" is alice's to see\n${forAlice}`);
    for (const w of [CAROL_ASK, BOB_TO_CAROL, CAROL_AGAIN, DAVE_ASK]) assert.ok(!forAlice.includes(w), `"${w}" is kept from alice\n${forAlice}`);
    assert.match(forAlice, /\[an ask to you that waits for your owner's OK: not shown\]/);
    assert.ok(!/sealed for/.test(forAlice), forAlice);

    const noAsker = await mcp(['--as-session'], session).read();
    for (const w of [CAROL_POST, CAROL_ASK, BOB_TO_CAROL, ALICE_ASK, BOB_TO_ALICE, DAVE_ASK]) assert.ok(!noAsker.includes(w), `"${w}" is kept when no asker is named\n${noAsker}`);

    const own = await mcp([]).read();
    for (const w of [CAROL_ASK, BOB_TO_CAROL, CAROL_POST, ALICE_ASK, BOB_TO_ALICE, CAROL_AGAIN, DAVE_ASK]) assert.ok(own.includes(w), `bob's own session opens "${w}"\n${own}`);
  });
});
