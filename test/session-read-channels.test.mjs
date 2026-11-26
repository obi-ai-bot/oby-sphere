// Which channels an answer may read: this Oby is in more channels than its asker. With a real
// relay (unsealed, so a direct conversation's words are plain text to its two Obys) and fake
// runtimes first on PATH (no model, no network): bob and carol talk in their direct conversation
// and in #board, a private channel of theirs, and bob posts in #lounge, a public one. When alice
// asks bob, the answering session's sphere_read, started as bob's Oby starts it, refuses the
// direct conversation and #board in plain words and reads #general and #lounge; when carol asks,
// it reads both of hers. With no asker named it reads only the ask's own channel. Bob's own
// session and `rep.mjs read` still read everything bob is in. `npm test`.
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
const KEY = 'join-key-session-read-0123456789ab';
const ADMIN = 'admin-key-session-read-0123456789a';
// the words that must not reach alice's answer, and the ones that may
const BOB_DM = 'BOB-DM-RC4 the offer for the house is in';
const CAROL_DM = 'CAROL-DM-RC4 good luck, tell no one yet';
const BOARD = 'BOARD-RC4 the budget is cut by a third';
const LOUNGE = 'LOUNGE-RC4 coffee machine is fixed';
const ALICE_ASK = 'ALICE-ASKS-RC4 what is going on?';
const CAROL_ASK = 'CAROL-ASKS-RC4 anything for me?';
const SHUT = /You can't read #\S+ while answering/;
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

describe('sphere_read while answering: only the channels the asker may read', () => {
  let relay, base, tmp, home, homeDir, work, cfg, fake, ids, bob, dm;
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
  const call = async (method, url, { tok, body } = {}) => {
    const h = {};
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const say = async (who, channel, text) => {
    const r = await call('POST', '/api/messages', { tok: profile(who).token, body: { channel, text } });
    assert.ok(r.message, JSON.stringify(r));
  };
  // the answering session bob's Oby gave the runtime for the ask with these words: its MCP server, as configured
  const sessionFor = (words) => {
    const c = fake.calls().filter((x) => x.bin === 'claude' && x.prompt.includes(words));
    assert.equal(c.length, 1, `one answer run for "${words}"\n${bobOut.slice(-3000)}`);
    for (const w of [BOB_DM, CAROL_DM, BOARD]) assert.ok(!c[0].prompt.includes(w), `"${w}" isn't in the prompt\n${c[0].prompt}`);
    return c[0].mcp.mcpServers.obysphere;
  };
  // an MCP client over stdio: `{ command, args, env }` as a runtime runs it; reads each channel
  // named (null: no channel argument) and returns what sphere_read said for each, with isError
  const reads = async (server, channels) => {
    const p = spawn(server.command, server.args, { env: env(server.env) });
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
    await req('initialize', { protocolVersion: '2025-06-18' });
    const got = {};
    for (const ch of channels) {
      const r = await req('tools/call', { name: 'sphere_read', arguments: ch ? { channel: ch, limit: 50 } : { limit: 50 } });
      got[ch ?? '(none)'] = { text: r.result.content[0].text, isError: !!r.result.isError };
    }
    await stop(p);
    return got;
  };
  const bobMcp = (args, extra = {}) => ({ command: process.execPath, args: [path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', 'bob', ...args], env: extra });
  const opened = (r, words, what) => {
    assert.ok(!r.isError, `${what}: ${r.text}`);
    for (const w of words) assert.ok(r.text.includes(w), `${what} shows "${w}"\n${r.text}`);
  };
  const refused = (r, what) => {
    assert.ok(r.isError, `${what} is refused\n${r.text}`);
    assert.match(r.text, SHUT, what);
    for (const w of [BOB_DM, CAROL_DM, BOARD, LOUNGE]) assert.ok(!r.text.includes(w), `${what} keeps "${w}"\n${r.text}`);
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-session-read-')));
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
    for (const n of ['alice', 'bob', 'carol']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    ids = Object.fromEntries(['alice', 'bob', 'carol'].map((n) => [n, profile(n).agent.id]));
    fs.writeFileSync(path.join(home, 'bob', 'profile.json'), JSON.stringify({ ...profile('bob'), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    fs.writeFileSync(
      path.join(home, 'bob', 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
        access: { default: 'answer', agents: {} },
        machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
      }),
      { mode: 0o600 },
    );
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("bob and carol talk in their direct conversation and in #board; the relay keeps both from alice; bob posts in #lounge", async () => {
    const made = await call('POST', '/api/dm', { tok: profile('bob').token, body: { with: 'carol' } });
    dm = made.channel?.name;
    assert.match(String(dm), /^dm-/, JSON.stringify(made));
    await say('bob', dm, BOB_DM);
    await say('carol', dm, CAROL_DM);
    const board = await call('POST', '/api/channels', { tok: profile('bob').token, body: { name: 'board', private: true, members: ['carol'] } });
    assert.equal(board.channel?.kind, 'private', JSON.stringify(board));
    await say('bob', 'board', BOARD);
    assert.equal((await call('POST', '/api/channels', { tok: profile('bob').token, body: { name: 'lounge' } })).channel?.kind, 'public');
    await say('bob', 'lounge', LOUNGE);
    // alice can't read them at the relay: what her answer reads must not either
    for (const ch of [dm, 'board']) {
      const r = await call('GET', `/api/messages?channel=${ch}`, { tok: profile('alice').token });
      assert.ok(!JSON.stringify(r).includes('RC4'), `the relay keeps #${ch} from alice\n${JSON.stringify(r)}`);
    }
    // and they are plain text to bob's Oby
    const own = await rep(['read', dm, '--profile', 'bob']);
    for (const w of [BOB_DM, CAROL_DM]) assert.ok(own.out.includes(w), `rep.mjs read shows bob "${w}"\n${own.out}`);
    assert.ok((await rep(['read', 'board', '--profile', 'bob'])).out.includes(BOARD));
  });

  test("bob's answer to alice: sphere_read refuses the direct conversation and #board, reads #general and #lounge", async () => {
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online/.test(bobOut), 15000, `bob online\n${bobOut}`);
    await sleep(300); // its catch-up

    fake.control({ text: 'for alice' });
    const a = await rep(['ask', 'bob', ALICE_ASK, '--profile', 'alice', '--wait', '45']);
    assert.ok(a.out.includes('for alice'), `alice got bob's reply\n${a.out}\n${bobOut.slice(-2000)}`);
    const server = sessionFor(ALICE_ASK);
    assert.equal(server.env.SPHERE_ASKER, ids.alice);
    assert.ok(server.args.includes('--as-session'));

    const r = await reads(server, [dm, 'board', null, 'lounge']);
    refused(r[dm], "alice's answer reading bob and carol's direct conversation");
    assert.match(r[dm].text, /a direct conversation the one you're answering isn't in/);
    refused(r.board, "alice's answer reading #board");
    assert.match(r.board.text, /a private channel the one you're answering isn't in/);
    opened(r['(none)'], [ALICE_ASK], "alice's answer reading its own channel");
    opened(r.lounge, [LOUNGE], "alice's answer reading a public channel");
  });

  test("bob's answer to carol reads both of hers", async () => {
    fake.control({ text: 'for carol' });
    const c = await rep(['ask', 'bob', CAROL_ASK, '--profile', 'carol', '--wait', '45']);
    assert.ok(c.out.includes('for carol'), `${c.out}\n${bobOut.slice(-2000)}`);
    const server = sessionFor(CAROL_ASK);
    assert.equal(server.env.SPHERE_ASKER, ids.carol);
    const r = await reads(server, [dm, 'board']);
    opened(r[dm], [BOB_DM, CAROL_DM], "carol's answer reading her direct conversation with bob");
    opened(r.board, [BOARD], "carol's answer reading #board");
  });

  test('with no asker named, sphere_read reads only the ask\'s own channel', async () => {
    const session = { SPHERE_DEPTH: '1', SPHERE_ATTACH: '0', SPHERE_CONSULT: '0' };
    const inGeneral = await reads(bobMcp(['--as-session'], { ...session, SPHERE_CHANNEL: 'general' }), [null, dm, 'board', 'lounge']);
    opened(inGeneral['(none)'], [ALICE_ASK], 'no asker, its own channel');
    for (const ch of [dm, 'board', 'lounge']) {
      refused(inGeneral[ch], `no asker, #${ch}`);
      assert.match(inGeneral[ch].text, /no asker is named, so you read only #general/);
    }
    const inDm = await reads(bobMcp(['--as-session'], { ...session, SPHERE_CHANNEL: dm }), [null, 'general']);
    opened(inDm['(none)'], [BOB_DM, CAROL_DM], 'no asker, an ask in the direct conversation');
    refused(inDm.general, 'no asker, #general from an ask elsewhere');
    const nowhere = await reads(bobMcp(['--as-session'], session), ['general']);
    assert.ok(nowhere.general.isError, nowhere.general.text);
    assert.match(nowhere.general.text, /neither the asker nor the ask's channel is named/);
  });

  test("bob's own session reads every channel bob is in", async () => {
    const r = await reads(bobMcp([]), [dm, 'board', 'general']);
    opened(r[dm], [BOB_DM, CAROL_DM], "bob's own session, the direct conversation");
    opened(r.board, [BOARD], "bob's own session, #board");
    opened(r.general, [ALICE_ASK, CAROL_ASK], "bob's own session, #general");
  });
});
