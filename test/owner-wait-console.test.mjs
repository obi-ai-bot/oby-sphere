// When an Oby can't answer (#160), in the console: an ask that waits for its Oby's owner to OK it
// ("Waiting for its owner", and "waiting for Bob’s OK · lapses at 18:02" on its exchange), one that
// lapsed ("No answer in time"), "not taken yet" only when nobody took it ("taken, not started yet"
// when an older Oby took it and says nothing more), and "Always answer @x" on the owner's waiting
// card, offered only where rep.mjs says it applies. The page's functions run in a sandbox with
// stand-ins: no browser, no network. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const HOSTILE = '<img src=x onerror=alert(1)>';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const agents = {
  a_bob: { id: 'a_bob', name: 'bob', owner: 'Bob', online: true },
  a_sam: { id: 'a_sam', name: 'sam', owner: 'Sam', online: false },
  a_eve: { id: 'a_eve', name: 'eve', owner: HOSTILE, online: true },
};
const ask = (to, extra = {}) => ({ id: `m_${to}_${Math.random().toString(36).slice(2, 8)}`, kind: 'ask', from: 'a_me', to: [to], channel: 'general', ts: iso(-60e3), ...extra });
const waitingFor = (by, ms = 3600e3) => ({ waiting: { for: 'owner', until: iso(ms), since: iso(-30e3), by } });
const replyTo = (a, meta) => ({ id: `m_r_${a.id}`, kind: 'reply', from: a.to[0], replyTo: a.id, ts: iso(-1e3), meta });
const spanOfWith = (messages) => sandbox(['MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'spanOf'], { S: { messages }, agent: (id) => agents[id] || { id, name: 'unknown' } }).spanOf;

describe('an ask that waits for its owner, or lapsed', () => {
  test('its state: waiting for its owner while its until is ahead and its Oby is online', () => {
    const owner = ask('a_bob', { claimedAt: iso(-50e3), ...waitingFor('a_bob') });
    const passed = ask('a_bob', { claimedAt: iso(-50e3), ...waitingFor('a_bob', -1000) });
    const another = ask('a_bob', { claimedAt: iso(-50e3), ...waitingFor('a_sam') });
    const older = ask('a_bob', { claimedAt: iso(-50e3), waiting: { for: 'owner', until: iso(3600e3) } }); // no by: the Oby it's addressed to
    const offline = ask('a_sam', waitingFor('a_sam'));
    const late = ask('a_bob', { neededBy: iso(-5e3), ...waitingFor('a_bob') });
    const spanOf = spanOfWith([owner, passed, another, older, offline, late]);
    assert.equal(spanOf(owner).status, 'owner');
    assert.equal(spanOf(owner).endMs, null, 'still going');
    assert.equal(spanOf(passed).status, 'waiting', 'its until passed: no longer said');
    assert.equal(spanOf(another).status, 'waiting', 'another Oby it was asked of waits, not this one');
    assert.equal(spanOf(older).status, 'owner');
    assert.equal(spanOf(offline).status, 'offline', 'its representative stopped: the wait stopped with it');
    assert.equal(spanOf(late).status, 'expired', 'past its deadline');
  });

  test('a reply decides: lapsed reads as its own state, a decline as declined; working comes first', () => {
    const lapsed = ask('a_bob', waitingFor('a_bob'));
    const declined = ask('a_bob');
    const working = ask('a_bob', waitingFor('a_bob'));
    const spanOf = sandbox(['MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'spanOf'], {
      S: { messages: [lapsed, declined, working, replyTo(lapsed, { declined: true, lapsed: true, local: true }), replyTo(declined, { declined: true, local: true })] },
      agent: (id) => (id === 'a_bob' ? { ...agents.a_bob, status: { state: 'working', about: working.id } } : agents[id]),
    }).spanOf;
    assert.equal(spanOf(lapsed).status, 'lapsed');
    assert.equal(spanOf(declined).status, 'declined');
    assert.equal(spanOf(working).status, 'working');
  });

  test('its words and its dot: Waiting for its owner; No answer in time, styled like declined', () => {
    const { STATUS_WORDS } = sandbox(['STATUS_WORDS']);
    assert.equal(STATUS_WORDS.owner, 'Waiting for its owner');
    assert.equal(STATUS_WORDS.lapsed, 'No answer in time');
    assert.match(PAGE, /\.status-dot\.is-owner \{ background: var\(--needs\); \}/);
    assert.match(PAGE, /\.status-dot\.is-lapsed \{ background: var\(--muted\); \}/);
    assert.match(PAGE, /\.status-dot\.is-declined[^{]*\{ background: var\(--muted\); \}/, 'the same as declined');
  });

  test('the exchange: waiting for Bob’s OK · lapses at 18:02; taken, not started yet; not taken yet', () => {
    const ctx = {
      esc, ownerName: (a) => a.owner, machineOf: (a) => `${a.owner}’s machine`, obyOf: (a) => `${a.owner}’s Oby`,
      plainModel: (m) => m, fmtMs: (n) => `${Math.round(n)}ms`, picture: () => '', postTo: () => '#general', isMe: () => false,
    };
    const f = sandbox(['MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'STATUS_WORDS', 'stateHtml', 'traceHtml'], ctx);
    const span = (a, status, target = agents.a_bob) => ({ ask: a, target, reply: null, posted: Date.parse(a.ts), claimed: a.claimedAt ? Date.parse(a.claimedAt) : null, started: a.claimedAt ? Date.parse(a.claimedAt) : null, endMs: null, status, from: { id: 'a_me', owner: 'Me' }, depth: 0 });
    const trace = (s) => f.traceHtml({ start: s.posted, end: now, spans: [s] });
    const owner = ask('a_bob', { claimedAt: iso(-50e3), ...waitingFor('a_bob') });
    const html = trace(span(owner, 'owner'));
    assert.ok(html.includes('Waiting for its owner'), html);
    assert.ok(html.includes(`waiting for Bob’s OK · lapses at ${f.whenWords(owner.waiting.until)}`), html);
    const hostile = trace(span(ask('a_eve', { claimedAt: iso(-50e3), ...waitingFor('a_eve') }), 'owner', agents.a_eve));
    assert.ok(!hostile.includes('<img') && hostile.includes(`waiting for ${esc(HOSTILE)}’s OK`), 'an owner’s name is text');
    assert.match(trace(span(ask('a_bob', { claimedAt: iso(-50e3) }), 'waiting')), /taken, not started yet/, 'an older Oby took it and says nothing more');
    const fresh = trace(span(ask('a_bob'), 'waiting'));
    assert.match(fresh, /not taken yet/);
    assert.ok(!fresh.includes('taken, not started'));
  });
});

describe('Your Oby › Waiting for you: Always answer @x', () => {
  const card = (p) => {
    const ctx = {
      esc, S: { pending: [p] }, SET: { settings: null }, riskyReach: () => false, githubCardHtml: () => '', avatar: () => '',
      ownerName: (a) => a.owner, where: (c) => `#${c}`, time: () => '12:00', size: (n) => `${n} B`, fileIcon: () => '',
    };
    return sandbox(['REASON_WORDS', 'pendingHtml'], ctx).pendingHtml();
  };
  const base = { id: 'w_0123456789ab', askId: 'm_abc', from: { name: 'alice', owner: 'Alice' }, channel: 'general', ts: iso(-5e3), text: 'the plan?', files: [], reason: 'asks wait for you unless you set otherwise', risky: false };

  test('offered for an Oby you haven’t listed, a quiet button that says what else it does', () => {
    const html = card({ ...base, always: true });
    const b = /<button class="set-button" data-decide="always" title="([^"]+)">([^<]+)<\/button>/.exec(html);
    assert.ok(b, html);
    assert.equal(b[2], 'Always answer @alice');
    assert.match(b[1], /adds @alice to Who can ask/);
    assert.ok(html.indexOf('data-decide="answer"') < html.indexOf('data-decide="always"'), 'after Let my Oby answer');
  });

  test('not offered for one you listed, nor by an older rep.mjs that doesn’t say', () => {
    assert.ok(!card({ ...base, always: false }).includes('data-decide="always"'));
    assert.ok(!card({ ...base }).includes('data-decide="always"'));
  });

  test('the handle is escaped', () => {
    const html = card({ ...base, from: { name: HOSTILE, owner: 'X' }, always: true });
    assert.ok(!html.includes('<img'), 'never markup');
    assert.ok(html.includes(`Always answer @${esc(HOSTILE)}`));
  });

  test('the click sends the decision as the other buttons do', () => {
    assert.match(pick('wirePending'), /const body = d === 'send' \? \{ decision: 'write', text: [^}]+\} : \{ decision: d \};/);
  });
});
