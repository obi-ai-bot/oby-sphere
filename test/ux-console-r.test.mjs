// The console stream's review (ux/console-r): what looking at the pages and reading the code found.
// The audit log keeps the 1,000 events it loads, whichever load finishes last; relay numbers that
// reach markup are numbers; Export all pages past a short page; Overview's numbers carry no line
// that repeats them; a model reads the same everywhere. The page's functions run in a sandbox:
// no relay, no network. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOSTILE = '<img src=x onerror=alert(1)>';

// a function of the page's script (two-space indent in its IIFE), by its braces
function fn(name) {
  const m = new RegExp(`\\n  (?:async )?function ${name}\\(`).exec(SCRIPT);
  assert.ok(m, `the page has function ${name}`);
  const start = m.index + 1;
  let depth = 0;
  for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') depth++;
    else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}
// a const of the page's script, up to the next statement at its indent
function konst(name) {
  const m = new RegExp(`\\n  const ${name} = `).exec(SCRIPT);
  assert.ok(m, `the page has const ${name}`);
  const next = /\n {2}(?! )/g;
  next.lastIndex = m.index + 1;
  const end = next.exec(SCRIPT);
  return SCRIPT.slice(m.index + 1, end ? end.index : undefined);
}
// run some of the page's functions and consts in a context of our stubs
function sandbox({ fns = [], consts = [] }, ctx = {}) {
  vm.createContext(ctx);
  const names = [...consts, ...fns];
  vm.runInContext(`${consts.map(konst).join('\n')}\n${fns.map(fn).join('\n')}\nthis.f = { ${names.join(', ')} };`, ctx);
  return ctx.f;
}
const seqs = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, ts: '2026-11-25T10:00:00.000Z', type: 'ask', detail: '', hash: `h${from + i}` }));

describe('the audit log keeps what it loads', () => {
  const load = () => {
    const ctx = { S: { audit: [], auditHead: null, auditVerified: null } };
    return { ctx, ...sandbox({ fns: ['okAuditEvent', 'auditHeadOf', 'mergeAudit'] }, ctx) };
  };
  const big = { events: seqs(1, 1000), head: { seq: 1000, hash: 'h1000' }, verified: true, total: 1000 };
  const small = { events: seqs(701, 1000), head: { seq: 1000, hash: 'h1000' }, verified: true, total: 1000 };

  test("the page's 1,000 and the console's 300, finishing in either order: 1,000 either way", () => {
    for (const order of [[big, small], [small, big]]) {
      const { ctx, mergeAudit } = load();
      order.forEach(mergeAudit);
      assert.equal(ctx.S.audit.length, 1000);
      assert.deepEqual(ctx.S.audit.map((e) => e.seq), seqs(1, 1000).map((e) => e.seq), 'in order, each once');
      assert.equal(ctx.S.auditHead.seq, 1000);
      assert.equal(ctx.S.auditVerified, true);
    }
    // the bug was a plain assignment in loadConsoleData, after the page had merged its 1,000
    const console = fn('loadConsoleData');
    assert.match(console, /mergeAudit\(await api\('\/api\/audit\?limit=300'\)\)/);
    assert.ok(!/S\.audit = a\.events/.test(console), 'it no longer replaces what the page loaded');
    assert.match(fn('loadAudit'), /mergeAudit\(a\)/);
  });

  test('the head never goes back, and the newest 2,000 stay', () => {
    const { ctx, mergeAudit } = load();
    ctx.S.auditHead = { seq: 1005, hash: 'live' };
    mergeAudit(big);
    assert.equal(ctx.S.auditHead.seq, 1005, 'a live event already moved it on');
    mergeAudit({ events: seqs(1001, 2600), head: { seq: 2600, hash: 'h2600' } });
    assert.equal(ctx.S.audit.length, 2000);
    assert.equal(ctx.S.audit[0].seq, 601);
    assert.equal(ctx.S.auditHead.seq, 2600);
  });

  test("an event or head from the relay without a whole-number seq is dropped: its seq reaches the page's markup", () => {
    const { ctx, mergeAudit, okAuditEvent, auditHeadOf } = load();
    mergeAudit({ events: [{ seq: HOSTILE }, { seq: '7' }, { seq: -1 }, { seq: 1.5 }, null, 'x', { seq: 3, hash: 'ok' }], head: { seq: HOSTILE, hash: 'x' }, verified: true });
    assert.deepEqual(ctx.S.audit.map((e) => e.seq), [3]);
    assert.equal(ctx.S.auditHead, null, 'a head with no number is no head');
    assert.equal(okAuditEvent({ seq: 1 }), true);
    assert.deepEqual({ ...auditHeadOf({ seq: 9, hash: 42 }) }, { seq: 9, hash: '42' });
    assert.equal(auditHeadOf({ seq: '9' }), null);
  });

  test('a live event the same way', () => {
    const ctx = { S: { audit: [], auditHead: null, mode: 'conversation' } };
    const { onAudit } = sandbox({ fns: ['okAuditEvent', 'onAudit'] }, ctx);
    onAudit({ seq: HOSTILE, hash: 'x' });
    onAudit({ seq: '12', hash: 'x' });
    assert.equal(ctx.S.audit.length, 0);
    assert.equal(ctx.S.auditHead, null);
    onAudit({ seq: 12, hash: 7 });
    onAudit({ seq: 12, hash: 7 });
    assert.equal(ctx.S.audit.length, 1, 'once');
    assert.deepEqual({ ...ctx.S.auditHead }, { seq: 12, hash: '7' });
  });

  test("the header's count is escaped, and Export says when it's working", () => {
    const ctx = {
      S: { auditVerified: true, auditHead: { seq: HOSTILE }, audit: [] },
      AU: { q: '', type: 'all', member: '', time: 'all', exporting: false },
      head: (t, sub, right = '') => `<h1>${t}</h1>${sub}${right}`,
      esc,
    };
    const { auditHead } = sandbox({ consts: ['auditFiltering', 'auditExportLabel'], fns: ['auditHead'] }, ctx);
    assert.ok(!auditHead().includes('<img'), auditHead());
    ctx.S.auditHead = { seq: 1234 };
    assert.match(auditHead(), /Chain verified · 1,234 events/);
    assert.match(auditHead(), /data-export title="Download as JSON">Export all</);
    ctx.AU.exporting = true;
    assert.match(auditHead(), /data-export title="Download as JSON" disabled>Exporting…</);
  });
});

describe('Export all', () => {
  // the relay's own paging (server.mjs auditPage): `limit` after `after`, holes (a damaged line) dropped
  const relay = (events, head) => async (url) => {
    const q = new URL(url, 'http://x').searchParams;
    const after = Number(q.get('after')), limit = Math.min(1000, Number(q.get('limit')) || 200);
    const first = events.findIndex((e) => e && e.seq > after);
    const list = first < 0 ? [] : events.slice(first, first + limit);
    return { events: list.filter(Boolean), head, verified: false, total: events.length };
  };
  const run = async (api) => {
    let saved = null, clicked = 0;
    const ctx = {
      S: { sphere: { name: 'Demo Sphere' }, auditHead: null, auditVerified: null },
      AU: { q: '', type: 'all', member: '', time: 'all', exporting: false },
      api,
      updateAudit: () => {},
      Blob: class { constructor(parts) { saved = parts.join(''); } },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      document: { createElement: () => ({ click() { clicked++; } }), querySelector: () => null },
      setTimeout: () => {},
    };
    const { exportAudit } = sandbox({ consts: ['auditFiltering', 'auditExportLabel'], fns: ['exportAudit'] }, ctx);
    await exportAudit();
    return { out: saved && JSON.parse(saved), clicked, ctx };
  };

  test('pages past a page short of 1,000: the head says where the log ends', async () => {
    const events = seqs(1, 2500);
    events[500] = null; // seq 501's line couldn't be read
    const { out, clicked, ctx } = await run(relay(events, { seq: 2500, hash: 'h2500' }));
    assert.equal(clicked, 1);
    assert.equal(out.events.length, 2499, 'every event but the damaged one');
    assert.equal(out.events.at(-1).seq, 2500);
    assert.equal(ctx.AU.exporting, false);
  });

  test('a relay without a head: a short page is the last', async () => {
    const { out } = await run(relay(seqs(1, 1500), null));
    assert.equal(out.events.length, 1500);
  });

  test("a relay that doesn't move on is left, and a failure downloads nothing", async () => {
    let calls = 0;
    const stuck = await run(async () => { calls++; return { events: seqs(1, 1000), head: { seq: 5000 } }; });
    assert.equal(calls, 2, 'the second page gave nothing new');
    assert.equal(stuck.out.events.length, 2000);
    const failed = await run(async () => { throw new Error('offline'); });
    assert.equal(failed.clicked, 0);
    assert.equal(failed.ctx.AU.exporting, false, 'the button comes back');
  });
});

describe("Overview's numbers", () => {
  const render = (S, list = [{ online: true }, { online: true }], ex = []) => {
    const k = { innerHTML: '', querySelectorAll: () => [] };
    const ctx = {
      S: { pending: [], me: { id: 'a_me' }, ...S },
      CONSOLE: {},
      document: { getElementById: (id) => (id === 'kpis' ? k : null) },
      members: () => list,
      exchanges: () => ex,
      median: () => null,
      fmtMs: (n) => `${n}ms`,
      setPage: () => {},
    };
    const { updateKpis } = sandbox({ consts: ['KPI_GO', 'kpi'], fns: ['workingNow', 'updateKpis'] }, ctx);
    updateKpis();
    return k.innerHTML;
  };

  test("the relay's count of today's exchanges is a number, or ours", () => {
    const html = render({ stats: { counts: { exchangesToday: HOSTILE }, answers: {} } });
    assert.ok(!html.includes('<img'), html);
    assert.match(html, /Exchanges today<\/span>[\s\S]*?<span class="kpi-value">0<\/span>/);
    assert.match(render({ stats: { counts: { exchangesToday: 7 }, answers: {} } }), /<span class="kpi-value">7<\/span>/);
  });

  test('no line that only repeats the number', () => {
    const calm = render({ stats: null });
    for (const gone of ['all online', 'all idle', 'nothing to decide', 'your decision']) assert.ok(!calm.includes(gone), gone);
    assert.match(render({ stats: null }, [{ online: true }, { online: false }]), /1 offline/);
    const waiting = render({ stats: null }, undefined, [{ spans: [{ status: 'waiting' }] }]);
    assert.match(waiting, /1 waiting to start/);
    assert.match(render({ stats: null, pending: [{}, {}] }), /class="kpi is-needs" data-page="you"[\s\S]*?kpi-value">2</, 'what waits for you stands out');
  });
});

describe('Members: numbers from the relay are escaped', () => {
  test('Answered', () => {
    const ctx = {
      S: { me: { id: 'a_me' }, admin: false, sphere: { policy: {} } },
      members: () => [{ id: 'a_bob', name: 'bob', owner: 'Bob', online: true, stats: { answered: HOSTILE } }],
      isMe: (a) => a.id === 'a_me',
      ownerName: (a) => a.owner,
      label: (a) => a.owner,
      obyOf: (a) => a.owner,
      picture: () => '',
      stateOf: () => 'online',
      ago: () => 'now',
      fmtMs: (n) => `${n} ms`,
      head: (t, sub, right = '') => `<h1>${t}</h1>${sub}${right}`,
      answersWith: () => '',
      MEMBER_STATE: { online: 'Online', working: 'Working', offline: 'Offline', suspended: 'Suspended' },
      esc,
    };
    const { pageMembers } = sandbox({ fns: ['agentIdOk', 'pageMembers'] }, ctx);
    const html = pageMembers();
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes(esc(HOSTILE)));
  });
});

describe('a model reads the same everywhere', () => {
  const { plainModel } = sandbox({ fns: ['plainModel'] });
  test('in plain words', () => {
    const cases = {
      'claude-haiku-5-5': 'Haiku 5.5',
      opus: 'Opus',
      'claude-opus-4-1-20250805': 'Opus 4.1',
      'claude-sonnet-4-20250514': 'Sonnet 4',
      'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
      'claude-3-5-haiku-20241022': 'Haiku 3.5',
      'claude-3-opus-20240229': 'Opus 3',
      'gpt-5.5-codex': 'gpt-5.5-codex',
      '': '',
    };
    for (const [m, words] of Object.entries(cases)) assert.equal(plainModel(m), words, m);
    assert.equal(plainModel('x'.repeat(40)).length, 24, 'a long one is cut');
  });
  test('Members, the timeline and the conversation all use it', () => {
    assert.match(fn('answersWith'), /plainModel/);
    assert.match(fn('traceHtml'), /esc\(plainModel\(r\.model\)\)/);
    assert.match(fn('messageHtml'), /esc\(plainModel\(mt\.model\)\)/);
  });
});

describe('fewer words on the pages', () => {
  test('in a sealed Sphere a message has no "Sealed end to end" line of its own; a forged one still says so', () => {
    const m = fn('messageHtml');
    assert.match(m, /S\.sphere\?\.policy\?\.sealed \? '' : `<p class="room-state">\$\{lock\(\)\}Sealed end to end<\/p>`/);
    assert.match(m, /Its signature didn’t verify: treat it as forged/);
    assert.match(m, /m\.sealed && m\.open && !S\.sphere\?\.policy\?\.sealed \? `<p class="room-state">/, 'your own messages too');
    assert.equal((m.match(/Sealed end to end<\/p>/g) || []).length, 2, 'no other line says it');
  });
  test('the side panel says "Sealed" as Overview does', () => {
    assert.match(fn('renderHealth'), /' · Sealed'/);
  });
  test("an exchange's line: no \"·\" left before its state when it wraps; a post has no timeline and says its channel once", () => {
    const ctx = {
      exchanges: () => [
        { id: 'm_post', root: { kind: 'post', ts: 't' }, spans: [], files: [], channel: 'general', status: 'posted', start: 0, durationMs: 0 },
        { id: 'm_ask', root: { kind: 'ask', ts: 't' }, spans: [], files: [], channel: 'general', status: 'answered', start: 0, durationMs: 5000 },
      ],
      routeWords: (ex) => (ex.root.kind === 'post' ? 'Spec’s Oby to #general' : 'Your Oby → Spec’s Oby'),
      where: (c) => `#${c}`,
      clock: () => '18:43:27',
      stateHtml: (st) => `<span class="state">${st}</span>`,
      head: (t, sub, right = '') => `<h1>${t}</h1><p>${sub}</p>${right}`,
      traceHtml: () => '<div class="trace"></div>',
      messageHtml: () => '',
      fmtMs: (n) => `${n / 1000}s`,
      esc,
    };
    const { pageExchange } = sandbox({ fns: ['pageExchange'] }, ctx);
    const post = pageExchange('m_post');
    assert.match(post, /<p><span>Spec’s Oby to #general · 18:43:27<\/span><span class="state">posted<\/span><\/p>/);
    assert.ok(!/trace|legend|How long it took/.test(post), post);
    const ask = pageExchange('m_ask');
    assert.match(ask, /<p><span>Your Oby → Spec’s Oby · #general · 18:43:27<\/span><span class="state">answered<\/span><\/p>/);
    assert.match(ask, /id="trace-box"/);
    assert.match(ask, /title="How long it took"[^>]*>5s</);
  });
});

describe("the audit log's keyboard", () => {
  test('up from the search field is the last option, down the first', () => {
    assert.match(fn('wireAuditPick'), /i < 0 \? \(down \? 0 : list\.length - 1\)/);
  });
  test('a focused button drawn again keeps the focus; Clear filters hands it to the search', () => {
    assert.match(fn('updateAudit'), /\['data-export', 'data-au-more'\]/);
    assert.match(fn('wireAuditResults'), /q\?\.focus\(\)/);
  });
  test("the page's script compiles", () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT, { filename: 'index.html' }));
  });
});

// Three streams add functions to one script. Two `function x(` at its top level compile, and the
// later one silently replaces the earlier everywhere: the review found Members' model words
// turned into Settings' "its default model" that way. Each name is declared once.
describe("the page's script", () => {
  test('declares each name once at its top level', () => {
    const names = [...SCRIPT.matchAll(/\n {2}(?:async )?function ([\w$]+)\(|\n {2}(?:const|let) ([\w$]+) =/g)].map((m) => m[1] || m[2]);
    assert.ok(names.length > 100, 'it found the declarations');
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual([...new Set(twice)], []);
  });
});
