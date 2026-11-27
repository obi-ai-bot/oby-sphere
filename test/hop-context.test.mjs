// What an answer to a hop may see: an ask another Oby passed on while answering someone else.
// With a real relay (unsealed first, so a direct conversation's words are plain text to its two
// Obys, then sealed) and fake runtimes first on PATH (no model, no network): bob and carol talk in
// their direct conversation and in #board, a private channel of theirs. Alice asks bob; the
// session answering her, started as bob's Oby starts it, asks carol in that direct conversation,
// in #board, and (answering alice in #pact, a private channel carol isn't in) through the direct
// conversation it falls back to. Carol's answers get none of those channels' history, start
// afresh each time, and their sphere_read refuses closed channels. Once the Sphere is sealed, an
// ask bob sealed for carol in #general is a marker in her answer to a hop there, and in its
// sphere_read. Bob asking carol himself still gets all of it. `npm test`.
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
const KEY = 'join-key-hop-context-0123456789abc';
const ADMIN = 'admin-key-hop-context-0123456789ab';
// what bob and carol said where alice can't read, and must not reach her through carol
const BOB_DM = 'BOB-DM-HP8 the offer for the house is in';
const CAROL_DM = 'CAROL-DM-HP8 good luck, tell no one yet';
const BOARD = 'BOARD-HP8 the budget is cut by a third';
const BOB_ASKS = 'BOB-ASKS-HP8 can we talk about the house?';
const SEALED_BC = 'SEALED-BC-HP8 the merger closes on Friday';
const CAROL_SEALED = 'CAROL-SEALED-HP8 noted, I will keep it quiet';
// what anyone may read
const LOUNGE = 'LOUNGE-HP8 coffee machine is fixed';
// the asks
const ALICE_ASK = 'ALICE-ASKS-HP8 what is going on?';
const ALICE_PACT = 'ALICE-PACT-HP8 just between us: any news?';
const ALICE_SEALED = 'ALICE-SEALED-HP8 anything new in here?';
const HOP_DM = 'HOP-DM-HP8 alice asks what is going on';
const HOP_BOARD = 'HOP-BOARD-HP8 alice asks about the budget';
const HOP_FALLBACK = 'HOP-FALLBACK-HP8 alice asks for news';
const HOP_SEALED = 'HOP-SEALED-HP8 alice asks what is new';
const BOB_AGAIN = 'BOB-AGAIN-HP8 and Friday?';
const HIDDEN = [BOB_DM, CAROL_DM, BOARD, BOB_ASKS, SEALED_BC, CAROL_SEALED];
const PASSED_ON = /You can't read #\S+ while answering: it's a (direct conversation|private channel), and this ask was passed on from another ask/;
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

describe("an answer to a hop sees what anyone may, not what the Oby that passed it on may", () => {
  let relay, base, tmp, home, homeDir, work, cfg, fake, ids, dm;
  const out = { bob: '', carol: '' };
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
      let o = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (o += d));
      const t = setTimeout(() => p.kill(), 60000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out: o, code });
      });
    });
  const logs = () => `--- bob\n${out.bob.slice(-2000)}\n--- carol\n${out.carol.slice(-2000)}`;
  const profile = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const call = async (method, url, { tok, admin, body } = {}) => {
    const h = {};
    if (tok) h.authorization = `Bearer ${tok}`;
    if (admin) h['x-admin-key'] = admin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const say = async (who, channel, text) => {
    const r = await call('POST', '/api/messages', { tok: profile(who).token, body: { channel, text } });
    assert.ok(r.message, JSON.stringify(r));
  };
  // the one answer run whose ask had these words
  const runFor = (words) => {
    const c = fake.calls().filter((x) => x.bin === 'claude' && x.prompt.includes(words));
    assert.equal(c.length, 1, `one answer run for "${words}"\n${logs()}`);
    return c[0];
  };
  const contextOf = (run) => {
    const i = run.prompt.indexOf('Earlier in the channel');
    return i < 0 ? '' : run.prompt.slice(i);
  };
  const keeps = (text, words, what) => {
    for (const w of words) assert.ok(!text.includes(w), `${what} keeps "${w}"\n${text}`);
  };
  // an MCP client over stdio: `{ command, args, env }` as a runtime runs it
  const session = async (server) => {
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
    return {
      tool: async (name, args) => {
        const r = await req('tools/call', { name, arguments: args });
        return { text: r.result.content[0].text, isError: !!r.result.isError };
      },
      close: () => stop(p),
    };
  };
  // sphere_read in a session, channel by channel (null: no channel argument)
  const reads = async (server, channels) => {
    const s = await session(server);
    const got = {};
    for (const ch of channels) got[ch ?? '(none)'] = await s.tool('sphere_read', ch ? { channel: ch, limit: 50 } : { limit: 50 });
    await s.close();
    return got;
  };
  // the session bob's Oby gave its runtime to answer alice's ask with these words; it asks carol
  // as that session would, and carol's Oby answers
  const hopFrom = async (aliceWords, ask) => {
    const server = runFor(aliceWords).mcp.mcpServers.obysphere;
    assert.equal(server.env.SPHERE_ASKER, ids.alice);
    assert.equal(server.env.SPHERE_DEPTH, '1');
    const s = await session(server);
    const r = await s.tool('sphere_ask', { agent: 'carol', wait_seconds: 45, ...ask });
    await s.close();
    assert.ok(!r.isError && r.text.includes('from carol'), `carol answered the hop\n${r.text}\n${logs()}`);
    const run = runFor(ask.message);
    assert.equal(run.mcp.mcpServers.obysphere.env.SPHERE_DEPTH, '2', 'carol answers it as a hop');
    assert.ok(!run.argv.includes('--resume'), `a hop starts afresh\n${run.argv.join(' ')}`);
    return run;
  };
  const serve = async (n) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', n], { env: env() });
    procs.push(p);
    p.stdout.on('data', (d) => (out[n] += d));
    p.stderr.on('data', (d) => (out[n] += d));
    await waitFor(() => /is online/.test(out[n]), 15000, `${n} online\n${out[n]}`);
  };
  const sessionsOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'sessions.json'), 'utf8'));

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hop-context-')));
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
    // unsealed to start with; sealing goes on for the last test
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
      const { out: o } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(o, /joined/, o);
    }
    ids = Object.fromEntries(['alice', 'bob', 'carol'].map((n) => [n, profile(n).agent.id]));
    // bob and carol answer with the fakes; bob's answers may ask others, carol takes passed-on asks
    for (const n of ['bob', 'carol']) {
      fs.writeFileSync(path.join(home, n, 'profile.json'), JSON.stringify({ ...profile(n), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
      fs.writeFileSync(
        path.join(home, n, 'settings.json'),
        JSON.stringify({
          version: 2,
          routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
          access: { default: 'answer', agents: {}, consultOthers: true, acceptHops: true, hops: 'answer' },
          machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
        }),
        { mode: 0o600 },
      );
    }
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('bob and carol talk in their direct conversation and in #board, which the relay keeps from alice; #lounge is public', async () => {
    const made = await call('POST', '/api/dm', { tok: profile('bob').token, body: { with: 'carol' } });
    dm = made.channel?.name;
    assert.match(String(dm), /^dm-/, JSON.stringify(made));
    await say('bob', dm, BOB_DM);
    await say('carol', dm, CAROL_DM);
    const board = await call('POST', '/api/channels', { tok: profile('bob').token, body: { name: 'board', private: true, members: ['carol'] } });
    assert.equal(board.channel?.kind, 'private', JSON.stringify(board));
    await say('bob', 'board', BOARD);
    const pact = await call('POST', '/api/channels', { tok: profile('alice').token, body: { name: 'pact', private: true, members: ['bob'] } });
    assert.equal(pact.channel?.kind, 'private', JSON.stringify(pact));
    assert.equal((await call('POST', '/api/channels', { tok: profile('bob').token, body: { name: 'lounge' } })).channel?.kind, 'public');
    await say('bob', 'lounge', LOUNGE);
    for (const ch of [dm, 'board']) {
      const r = await call('GET', `/api/messages?channel=${ch}`, { tok: profile('alice').token });
      assert.ok(!JSON.stringify(r).includes('HP8'), `the relay keeps #${ch} from alice\n${JSON.stringify(r)}`);
    }
    await serve('bob');
    await serve('carol');
    await sleep(300); // their catch-up
  });

  test('bob asking carol himself in their direct conversation: her answer sees its history, and so does its sphere_read', async () => {
    fake.control({ text: 'from carol' });
    const r = await rep(['ask', 'carol', BOB_ASKS, '--channel', dm, '--profile', 'bob', '--wait', '45']);
    assert.ok(r.out.includes('from carol'), `${r.out}\n${logs()}`);
    const run = runFor(BOB_ASKS);
    for (const w of [BOB_DM, CAROL_DM]) assert.ok(contextOf(run).includes(w), `"${w}" is bob's to see\n${run.prompt}`);
    const server = run.mcp.mcpServers.obysphere;
    assert.deepEqual([server.env.SPHERE_ASKER, server.env.SPHERE_DEPTH], [ids.bob, '1']);
    const got = await reads(server, [dm, 'board']);
    assert.ok(!got[dm].isError && got[dm].text.includes(BOB_DM), got[dm].text);
    assert.ok(!got.board.isError && got.board.text.includes(BOARD), got.board.text);
    assert.ok(sessionsOf('carol')[`claude:${dm}:${ids.bob}`], "carol's Oby keeps bob's conversation");
  });

  test("the session answering alice asks carol in their direct conversation and in #board: carol's answers get none of their history", async () => {
    fake.control({ text: 'for alice' });
    const a = await rep(['ask', 'bob', ALICE_ASK, '--profile', 'alice', '--wait', '45']);
    assert.ok(a.out.includes('for alice'), `${a.out}\n${logs()}`);
    const kept = sessionsOf('carol');

    fake.control({ text: 'from carol' });
    const inDm = await hopFrom(ALICE_ASK, { message: HOP_DM, channel: dm });
    assert.equal(contextOf(inDm), '', `no history from the direct conversation\n${inDm.prompt}`);
    keeps(inDm.prompt, HIDDEN, "carol's answer to the hop in the direct conversation");
    const inBoard = await hopFrom(ALICE_ASK, { message: HOP_BOARD, channel: 'board' });
    assert.equal(contextOf(inBoard), '', `no history from #board\n${inBoard.prompt}`);
    keeps(inBoard.prompt, HIDDEN, "carol's answer to the hop in #board");
    assert.deepEqual(sessionsOf('carol'), kept, "a hop's conversation isn't kept, and bob's own isn't touched");
  });

  test("answering alice in #pact, the ask to carol falls back to the direct conversation: still no history, and no earlier hop", async () => {
    fake.control({ text: 'for alice' });
    const a = await rep(['ask', 'bob', ALICE_PACT, '--channel', 'pact', '--profile', 'alice', '--wait', '45']);
    assert.ok(a.out.includes('for alice'), `${a.out}\n${logs()}`);
    fake.control({ text: 'from carol' });
    const run = await hopFrom(ALICE_PACT, { message: HOP_FALLBACK });
    assert.ok(run.prompt.includes(`"channel": "${dm}"`), `asked in the direct conversation\n${run.prompt}`);
    assert.equal(contextOf(run), '', run.prompt);
    keeps(run.prompt, [...HIDDEN, HOP_DM, ALICE_PACT], "carol's answer to the hop through the fallback");
  });

  test("the session answering a hop reads public channels only", async () => {
    const server = runFor(HOP_DM).mcp.mcpServers.obysphere;
    const got = await reads(server, [null, dm, 'board', 'general', 'lounge']);
    for (const ch of ['(none)', dm, 'board']) {
      assert.ok(got[ch].isError, `${ch} is refused\n${got[ch].text}`);
      assert.match(got[ch].text, PASSED_ON, ch);
      keeps(got[ch].text, HIDDEN, `the hop's sphere_read of ${ch}`);
    }
    assert.ok(!got.general.isError && got.general.text.includes(ALICE_ASK), got.general.text);
    assert.ok(!got.lounge.isError && got.lounge.text.includes(LOUNGE), got.lounge.text);
  });

  test("sealed: bob's sealed ask to carol in #general is a marker in her answer to a hop there, and in its sphere_read; bob asking himself still sees it", async () => {
    assert.equal((await call('POST', '/api/admin/policy', { admin: ADMIN, body: { sealed: true } })).status, 200);
    fake.control({ text: CAROL_SEALED });
    const b = await rep(['ask', 'carol', SEALED_BC, '--profile', 'bob', '--wait', '45']);
    assert.match(b.out, /"sealed": true/, b.out);
    assert.ok(b.out.includes(CAROL_SEALED), `${b.out}\n${logs()}`);
    fake.control({ text: 'for alice' });
    const a = await rep(['ask', 'bob', ALICE_SEALED, '--profile', 'alice', '--wait', '45']);
    assert.ok(a.out.includes('for alice'), `${a.out}\n${logs()}`);

    fake.control({ text: 'from carol' });
    const run = await hopFrom(ALICE_SEALED, { message: HOP_SEALED });
    const context = contextOf(run);
    assert.ok(context, `#general is public: its history is there\n${run.prompt}`);
    assert.match(context, /bob \(for Bob Test\) → carol \(for Carol Test\): \[sealed\]/);
    keeps(run.prompt, HIDDEN, "carol's answer to the hop in #general");
    const got = await reads(run.mcp.mcpServers.obysphere, ['general']);
    assert.ok(!got.general.isError && got.general.text.includes('[sealed]'), got.general.text);
    keeps(got.general.text, HIDDEN, "the hop's sphere_read of #general");

    fake.control({ text: 'from carol' });
    const again = await rep(['ask', 'carol', BOB_AGAIN, '--profile', 'bob', '--wait', '45']);
    assert.ok(again.out.includes('from carol'), `${again.out}\n${logs()}`);
    const own = contextOf(runFor(BOB_AGAIN));
    for (const w of [SEALED_BC, CAROL_SEALED]) assert.ok(own.includes(w), `"${w}" is bob's to see\n${own}`);
  });
});
