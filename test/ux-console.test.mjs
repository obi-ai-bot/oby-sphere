// The console's usability pass (ux/console): the audit log's search and filters, what an Oby
// answers with, the side panel's version and uptime, Overview's numbers, and the words the
// console no longer uses. The page's functions run in a sandbox; one relay on a free port says
// what a new Sphere's #general is for. No model, no network beyond this machine. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one of the page's functions or one-line constants, as written (two-space indent in the page's IIFE)
function pick(name) {
  const fn = new RegExp(`\\n  (?:async )?function ${name}\\(`).exec(SCRIPT);
  if (fn) {
    const start = fn.index + 1;
    const end = SCRIPT.indexOf('\n  }\n', start);
    assert.ok(end > start, `the end of ${name}`);
    return SCRIPT.slice(start, end + 4);
  }
  const c = new RegExp(`\\n  const ${name} = [^\\n]*`).exec(SCRIPT);
  assert.ok(c, `the page has ${name}`);
  return c[0].slice(1);
}
function sandbox(names, ctx = {}) {
  vm.createContext(ctx);
  vm.runInContext(`${names.map(pick).join('\n')}\nthis.f = { ${names.join(', ')} };`, ctx);
  return ctx.f;
}

describe('the audit log: search and filters', () => {
  const { auditFilter } = sandbox(['AUDIT_GROUPS', 'auditFilter']);
  const at = (h, m = 0, day = 25) => new Date(2026, 10, day, h, m).toISOString(); // local time, Nov 2026
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  const events = [
    { seq: 1, ts: at(9, 0, 17), type: 'join', actor: 'a_bob', target: null, detail: 'bob joined, representing Bob' },
    { seq: 2, ts: at(9, 0, 22), type: 'ask', actor: 'a_bob', target: 'a_sam', detail: 'bob → sam · 80 B sealed · #general' },
    { seq: 3, ts: at(8, 0), type: 'reply', actor: 'a_sam', target: 'a_bob', detail: 'sam → bob · 300 B sealed · 4.1s' },
    { seq: 4, ts: at(11, 30), type: 'policy', actor: 'operator', target: null, detail: 'hop limit 3 → 2' },
    { seq: 5, ts: at(11, 50), type: 'deny', actor: null, target: null, detail: 'unauthorized: join from 10.0.0.9' },
    { seq: 6, ts: at(11, 55), type: 'suspend', actor: 'a_bob', target: 'a_sam', detail: 'sam suspended · by bob' },
  ];
  const names = { a_bob: 'bob Bob Stone', a_sam: 'sam Sam Reyes', operator: 'admin key' };
  const run = (f) => auditFilter(events, { q: '', type: 'all', member: '', time: 'all', ...f }, { now, nameOf: (id) => names[id] || '' }).map((e) => e.seq);

  test('no filter: every event, newest first', () => {
    assert.deepEqual(run({}), [6, 5, 4, 3, 2, 1]);
  });
  test('event type: a group, or one type', () => {
    assert.deepEqual(run({ type: 'traffic' }), [3, 2]);
    assert.deepEqual(run({ type: 'members' }), [1]);
    assert.deepEqual(run({ type: 'admin' }), [6, 4]);
    assert.deepEqual(run({ type: 'refused' }), [5]);
    assert.deepEqual(run({ type: 't:reply' }), [3]);
    assert.deepEqual(run({ type: 't:nothing-like-it' }), []);
    assert.deepEqual(run({ type: 'no-such-group' }), [], 'an unknown group matches nothing, not everything');
  });
  test('member: what they did, and what was done to them; the admin key is a member of its own', () => {
    assert.deepEqual(run({ member: 'a_sam' }), [6, 3, 2]);
    assert.deepEqual(run({ member: 'a_bob' }), [6, 3, 2, 1]);
    assert.deepEqual(run({ member: 'operator' }), [4]);
  });
  test('time: the last hour, today, the last 7 days, any time', () => {
    assert.deepEqual(run({ time: 'hour' }), [6, 5, 4]);
    assert.deepEqual(run({ time: 'today' }), [6, 5, 4, 3]);
    assert.deepEqual(run({ time: 'week' }), [6, 5, 4, 3, 2]);
    assert.deepEqual(run({ time: 'all' }), [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(auditFilter([{ seq: 9, ts: 'not a date', type: 'ask', detail: '' }], { time: 'week' }, { now }), [], 'an event without a time is never "recent"');
  });
  test('search: across type, #seq, who, whom and detail; every word, any case', () => {
    assert.deepEqual(run({ q: 'Reyes' }), [6, 3, 2], "the owner's name of either side");
    assert.deepEqual(run({ q: 'SAM bob' }), [6, 3, 2], 'every word must be there');
    assert.deepEqual(run({ q: 'deny' }), [5], 'the type');
    assert.deepEqual(run({ q: '#4' }), [4], 'the sequence number');
    assert.deepEqual(run({ q: 'admin key' }), [4]);
    assert.deepEqual(run({ q: '10.0.0.9' }), [5], 'the detail');
    assert.deepEqual(run({ q: '   ' }), [6, 5, 4, 3, 2, 1], 'blank is no search');
    assert.deepEqual(run({ q: 'nobody-here' }), []);
  });
  test('filters combine', () => {
    assert.deepEqual(run({ type: 'traffic', member: 'a_sam', time: 'today' }), [3]);
    assert.deepEqual(run({ type: 'admin', q: 'sam' }), [6]);
  });
  test('the list it was given is left alone', () => {
    const copy = JSON.stringify(events);
    run({ type: 'traffic', q: 'bob' });
    assert.equal(JSON.stringify(events), copy);
  });

  test('Export says what it exports: what is shown, or everything', () => {
    const ctx = { AU: { q: '', type: 'all', member: '', time: 'all' } };
    const f = sandbox(['auditFiltering', 'auditExportLabel'], ctx);
    assert.equal(f.auditExportLabel(), 'Export all');
    for (const change of [{ q: 'bob' }, { type: 'traffic' }, { member: 'a_bob' }, { time: 'hour' }]) {
      Object.assign(ctx.AU, { q: '', type: 'all', member: '', time: 'all' }, change);
      assert.equal(f.auditExportLabel(), 'Export shown', JSON.stringify(change));
    }
    Object.assign(ctx.AU, { q: '   ', type: 'all', member: '', time: 'all' });
    assert.equal(f.auditExportLabel(), 'Export all', 'spaces are no search');
  });

  test('Export all pages through the log, a request at a time; the filters are our own dropdowns', () => {
    const exp = pick('exportAudit');
    assert.match(exp, /\/api\/audit\?after=\$\{after\}&limit=1000/, 'it asks for the events after the last one it has');
    assert.ok(!/limit=100000/.test(SCRIPT), 'not one request the relay caps at 1,000');
    assert.ok(!/<select\b/.test(pick('pageAudit') + pick('auditPick') + pick('wireAuditPick')), 'no native <select>');
    assert.match(pick('wireAuditPick'), /ArrowDown/, 'arrows move through the options');
    assert.match(pick('wireAuditPick'), /Escape/, 'Escape closes the menu');
    assert.match(pick('auditPick'), /aria-haspopup="listbox"/);
  });
});

describe('Members: what each Oby answers with, in plain words', () => {
  const ctx = {};
  const { answersWith } = sandbox(['RUNTIME_NAMES', 'plainModel', 'answersWith'], ctx);
  test('the runtime and model it declares', () => {
    assert.equal(answersWith({ declared: { runtime: 'claude', model: 'opus', runtimes: ['claude'] } }), 'Claude Code · Opus');
    assert.equal(answersWith({ declared: { runtime: 'claude', model: 'claude-sonnet-5-5' } }), 'Claude Code · Sonnet 5.5');
    assert.equal(answersWith({ declared: { runtime: 'codex', model: 'gpt-5.5-codex' } }), 'Codex · gpt-5.5-codex');
    assert.equal(answersWith({ declared: { runtime: 'cursor' } }), 'Cursor');
  });
  test('the other runtimes its routing uses', () => {
    assert.equal(answersWith({ declared: { runtime: 'claude', model: 'haiku', runtimes: ['claude', 'codex', 'cursor'] } }), 'Claude Code · Haiku, or Codex, Cursor');
    assert.equal(answersWith({ declared: { runtime: 'claude', model: 'haiku', runtimes: ['claude', 'mystery'] } }), 'Claude Code · Haiku', 'one it doesn’t know is left out');
  });
  test('an older Oby: its runtime line; nothing when it says nothing we know', () => {
    assert.equal(answersWith({ runtime: 'claude code · haiku' }), 'Claude Code · Haiku');
    assert.equal(answersWith({ runtime: 'something else · v2' }), '');
    assert.equal(answersWith({}), '');
    assert.equal(answersWith(null), '');
    assert.equal(answersWith({ declared: { runtime: 'claude', model: 'x'.repeat(60) } }).length, 'Claude Code · '.length + 24, 'a long model name is cut');
  });
  test('the table has no Scope column, and the words that confused people are gone', () => {
    const members = pick('pageMembers');
    assert.ok(!/Scope|declared|representative|in a session/i.test(members), 'Members says none of it');
    assert.match(members, /Answers with/);
    assert.match(members, /S\.admin \? `<td/, 'the action buttons only for admins');
  });
});

describe('the side panel, Overview and Your Oby', () => {
  const { versionWords, upFor } = sandbox(['versionWords', 'upFor']);
  test('the foot: the version and how long it has been up', () => {
    assert.equal(versionWords('obysphere/0.3'), 'v0.3');
    assert.equal(versionWords('obysphere/0.3.1'), 'v0.3.1');
    assert.equal(versionWords('obysphere/1.0.0-rc.1'), 'v1.0.0-rc.1');
    assert.equal(versionWords(undefined), '');
    assert.equal(versionWords('<b>'), '');
    assert.equal(upFor(20e3), '1 min');
    assert.equal(upFor(3 * 60e3), '3 min');
    assert.equal(upFor((4 * 60 + 10) * 60e3), '4 h 10 min');
    assert.equal(upFor((49 * 60 + 5) * 60e3), '2 d 1 h');
    const health = pick('renderHealth');
    assert.ok(!/runs no agents|relay only/.test(health), health);
    assert.match(health, /textContent/, 'set as text, not markup');
  });

  test('Working now counts asks being answered, and those not taken yet', () => {
    const { workingNow } = sandbox(['workingNow']);
    const ex = [{ spans: [{ status: 'working' }, { status: 'answered' }] }, { spans: [{ status: 'waiting' }, { status: 'working' }] }, { spans: [{ status: 'offline' }] }];
    assert.deepEqual({ ...workingNow(ex) }, { working: 2, waiting: 1 });
    assert.deepEqual({ ...workingNow([]) }, { working: 0, waiting: 0 });
  });

  test('Overview: Working now and Waiting for you instead of Relay overhead and Agents run here', () => {
    const k = pick('updateKpis');
    for (const gone of ['Relay overhead', 'Agents run here', 'agent-to-agent hops', '`p95']) assert.ok(!k.includes(gone), gone);
    assert.match(k, /kpi\('Working now'[^\n]*'traffic'\)/, 'Working now opens Traffic');
    assert.match(k, /kpi\('Waiting for you'[^\n]*'you'/, 'Waiting for you opens Your Oby');
    assert.match(k, /if \(CONSOLE && S\.me\)/, 'Waiting for you only in your own console');
    const ov = pick('renderOverview');
    assert.ok(!/tailing|The relay in the middle|relay only/.test(ov), 'no captions that say nothing');
    assert.ok(!/0 agents/.test(pick('buildTopo')));
  });

  test('Your Oby: no Scope number, no This Sphere card', () => {
    const you = pick('pageYou') + pick('youRest');
    assert.ok(!/Scope|This Sphere|represents|thisSphere/.test(you), you);
    assert.ok(!/function thisSphere\(/.test(SCRIPT), 'the card is gone, not moved');
  });

  test('an exchange: no "payload", no "as data", no hop chips; the messages under "What was said"', () => {
    const ex = pick('pageExchange') + pick('traceHtml');
    for (const gone of ['Payload', 'as data', 'representative', 'hop ${s.depth}', 'turns', 'queued']) assert.ok(!ex.includes(gone), gone);
    assert.match(ex, /What was said/);
    assert.match(pick('pageTraffic'), /in progress/);
  });

  test('a name in the timeline is escaped', () => {
    const t = pick('traceHtml');
    assert.ok(!/meta\.push\(`ran on \$\{machineOf/.test(t));
    assert.match(t, /esc\(machineOf\(s\.target\)\)/);
    assert.match(t, /esc\(obyOf\(s\.target\)\)/);
  });

  test("the page's script compiles", () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT, { filename: 'index.html' }));
  });
});

describe('the Conversation view says less', () => {
  test('no side panel paragraph, and short hints', () => {
    assert.ok(!/This Obysphere runs no agents/.test(PAGE));
    const hints = pick('renderTo');
    assert.ok(!/with their files and their rules/.test(hints), 'the hint under the message box is short');
    assert.ok(!/representative|operator/.test(hints), hints);
    assert.ok(!/payload|as data/i.test(pick('pageExchange')));
  });
  test("an older Sphere's #general topic is shown in today's words", () => {
    assert.match(pick('renderHead'), /'Where representatives meet\.'/);
  });
});

// a free port: never the demo's (4848-4851) nor the ones other work uses (4881-4999)
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (p < 4848 || p > 4999) return p;
  }
};

describe("a new Sphere's #general", () => {
  let tmp, relay, base;
  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-ux-console-')));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay'), '--name', 'UX Sphere'], {
      env: { ...process.env, SPHERE_KEY: 'join-key-ux-console-0123456789', SPHERE_ADMIN_KEY: 'admin-key-ux-console-0123456789', SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
  });
  after(async () => {
    if (relay && relay.exitCode === null) await new Promise((r) => { relay.once('exit', r); relay.kill(); });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  test('says what it is for in plain words', async () => {
    const r = await fetch(base + '/api/channels', { headers: { 'x-sphere-key': 'join-key-ux-console-0123456789' } });
    assert.equal(r.status, 200);
    const general = (await r.json()).channels.find((c) => c.name === 'general');
    assert.equal(general.topic, 'Where everyone in the Sphere meets.');
  });
});
