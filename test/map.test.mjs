// Overview's map: who asked whom in a window (Live, Today, 7 days), each Oby's state and what it
// did, amber where an ask waits on someone or went wrong, and the Traffic page an arrow or a name
// opens. The page's own functions, run on their own with made-up asks (as accessibility.test.mjs
// renders its markup). `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fnSource, constSource } from './accessibility-helpers.mjs';

// the page's functions and consts, run with what's given; anything else they call returns ''
function run(names, call, given = {}, consts = []) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = { esc, ...given };
  const ctx = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : k in globalThis ? globalThis[k] : () => ''),
  }));
  vm.runInContext(`${consts.map((c) => constSource(c)).join('\n')}\n${names.map((n) => fnSource(n)).join('\n')}\nthis.__out = (${call});`, ctx);
  return base.__out;
}
// an object made in the page's context, as one of this test's own (for deepStrictEqual)
const plain = (v) => JSON.parse(JSON.stringify(v));
const MAP_CONSTS = ['MAP_WINDOWS', 'MAP_WHEN', 'OPEN_STATES', 'NEEDS_STATES', 'mapWin', 'linkNeeds'];
const people = { a_me: 'Dana', a_alice: 'Alice', a_bob: 'Bob', a_carol: 'Carol' };
const who = (id) => ({ id, owner: people[id], name: people[id].toLowerCase(), online: true });
const names = {
  agent: who,
  isMe: (a) => a?.id === 'a_me',
  ownerName: (a) => a.owner,
  obyOf: (a) => (a.id === 'a_me' ? 'Your Oby' : `${a.owner}’s Oby`),
  obyLower: (a) => (a.id === 'a_me' ? 'your Oby' : `${a.owner}’s Oby`),
};
const span = (from, to, status, extra = {}) => ({ from: who(from), target: who(to), status, posted: 0, endMs: status === 'answered' ? 90e3 : null, ask: { id: `m_${from}${to}${status}`, ts: new Date(0).toISOString() }, ...extra });
const idsFound = (html) => [...html.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((id) => !html.includes(`id="${id}"`));

describe('who asked whom', () => {
  const spans = [
    span('a_alice', 'a_me', 'answered'),
    span('a_alice', 'a_me', 'answered'),
    span('a_alice', 'a_me', 'working'),
    span('a_me', 'a_bob', 'owner'),
    span('a_me', 'a_bob', 'lapsed'),
    span('a_bob', 'a_alice', 'error'),
    span('a_me', 'a_alice', 'declined'),
  ];
  const links = run(['mapLinks'], 'mapLinks(SPANS)', { SPANS: spans }, MAP_CONSTS);

  test('one arrow per pair and direction, with how its asks went', () => {
    const by = Object.fromEntries(links.map((l) => [`${l.from}>${l.to}`, l]));
    assert.deepEqual(Object.keys(by).sort(), ['a_alice>a_me', 'a_bob>a_alice', 'a_me>a_alice', 'a_me>a_bob']);
    assert.deepEqual({ n: by['a_alice>a_me'].n, answered: by['a_alice>a_me'].answered, working: by['a_alice>a_me'].working, open: by['a_alice>a_me'].open }, { n: 3, answered: 2, working: 1, open: 1 });
    assert.deepEqual({ owner: by['a_me>a_bob'].owner, late: by['a_me>a_bob'].late, open: by['a_me>a_bob'].open }, { owner: 1, late: 1, open: 1 });
    assert.equal(by['a_bob>a_alice'].failed, 1);
    assert.equal(by['a_me>a_alice'].declined, 1);
    // amber: an ask waiting on someone, late, or failed; a declined one is an answer
    const needs = run([], 'L.map(linkNeeds)', { L: [by['a_alice>a_me'], by['a_me>a_bob'], by['a_bob>a_alice'], by['a_me>a_alice']] }, MAP_CONSTS);
    assert.deepEqual(needs, [false, true, true, false]);
  });

  test('each arrow says in words who asked whom, how often, and how it went', () => {
    const words = (l, win) => run(['linkWords'], 'linkWords(L, W)', { ...names, L: l, W: win }, MAP_CONSTS);
    const by = Object.fromEntries(links.map((l) => [`${l.from}>${l.to}`, l]));
    assert.equal(words(by['a_alice>a_me'], 'today'), 'Alice’s Oby asked your Oby 3 times today: 2 answered, 1 being worked on');
    assert.equal(words(by['a_me>a_bob'], 'week'), 'Your Oby asked Bob’s Oby twice in the last 7 days: 1 waiting for Bob, 1 not answered in time');
    assert.equal(words(by['a_bob>a_alice'], 'today'), 'Bob’s Oby asked Alice’s Oby once today: 1 failed');
    assert.equal(words({ ...by['a_alice>a_me'], n: 1, answered: 0 }, 'live'), 'Alice’s Oby has an ask open with your Oby: 1 being worked on');
    // an ask that waits for you (your own Oby, your OK)
    assert.equal(words({ from: 'a_bob', to: 'a_me', n: 1, answered: 0, open: 1, working: 0, owner: 1, late: 0, failed: 0, declined: 0 }, 'today'), 'Bob’s Oby asked your Oby once today: 1 waiting for you');
  });
});

describe('the asks in a window', () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const today = new Date(new Date(now).toDateString()).getTime();
  const agents = new Map(Object.keys(people).map((id) => [id, who(id)]));
  const messages = [
    { id: 'm_today', kind: 'ask', from: 'a_alice', to: ['a_me'], ts: new Date(Math.max(today, now - 60e3)).toISOString() },
    { id: 'm_today_r', kind: 'reply', from: 'a_me', replyTo: 'm_today', ts: new Date(now).toISOString(), meta: {} },
    { id: 'm_open', kind: 'ask', from: 'a_me', to: ['a_bob'], ts: new Date(Math.max(today, now - 30e3)).toISOString() },
    { id: 'm_old', kind: 'ask', from: 'a_bob', to: ['a_alice'], ts: at(3 * 864e5) },
    { id: 'm_older', kind: 'ask', from: 'a_bob', to: ['a_alice'], ts: at(9 * 864e5) },
    { id: 'm_post', kind: 'post', from: 'a_alice', ts: at(1000) },
  ];
  const spansIn = (win) =>
    run(['spansIn', 'spanOf', 'awayOf'], `spansIn(W).map((s) => s.ask.id + ':' + s.status)`, { W: win, S: { messages, agents }, agent: (id) => agents.get(id) }, MAP_CONSTS);

  test('Today starts at midnight here, 7 days goes back a week, Live keeps only the open asks', () => {
    assert.deepEqual(spansIn('today'), ['m_today:answered', 'm_open:waiting']);
    assert.deepEqual(spansIn('week'), ['m_today:answered', 'm_open:waiting', 'm_old:waiting']);
    assert.deepEqual(spansIn('live'), ['m_open:waiting', 'm_old:waiting', 'm_older:waiting']);
  });
});

describe("each Oby's state on the map", () => {
  const state = (a, open, given = {}) => plain(run(['mapState', 'awayOf', 'whenWords'], 'mapState(A, OPEN)', { ...names, A: a, OPEN: open, S: { byId: new Map([['m_1', { from: 'a_alice' }]]) }, ...given }, MAP_CONSTS));

  test('working for whom, waiting for its owner (since when), away, offline since, online', () => {
    assert.deepEqual(state({ ...who('a_me'), status: { state: 'working', about: 'm_1', since: 'T' } }, []), { st: 'working', words: 'Working for Alice', since: 'T' });
    // waiting for Bob's OK: the oldest such ask's time
    const owner = [span('a_me', 'a_bob', 'owner', { posted: 5, ask: { ts: 'later' } }), span('a_alice', 'a_bob', 'owner', { posted: 1, ask: { ts: 'first' } })];
    assert.deepEqual(state(who('a_bob'), owner), { st: 'needs', words: 'Waiting for Bob', since: 'first' });
    assert.deepEqual(state(who('a_me'), [span('a_alice', 'a_me', 'owner')]).words, 'Waiting for you');
    const until = new Date(Date.now() + 864e5 * 2);
    assert.match(state({ ...who('a_carol'), away: { until: until.toISOString() } }, []).words, /^Away until [A-Z][a-z]{2} \d{1,2}:\d\d$/);
    assert.deepEqual(state({ ...who('a_carol'), away: { until: null } }, []), { st: 'away', words: 'Away' });
    const seen = new Date();
    assert.deepEqual(state({ ...who('a_carol'), online: false, lastSeen: seen.toISOString() }, []), { st: 'offline', words: `Offline since ${seen.getHours()}:${String(seen.getMinutes()).padStart(2, '0')}` });
    assert.deepEqual(state(who('a_alice'), []), { st: 'online', words: 'Online' });
    assert.deepEqual(state({ ...who('a_alice'), suspended: true }, []), { st: 'suspended', words: 'Suspended' });
  });

  test('what it did in the window: answered of asked and its median, or what it asked', () => {
    const did = (id, spans, win = 'today') => run(['mapDid'], 'mapDid(A, SP, W)', { A: who(id), SP: spans, W: win, median: (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null), fmtMs: (ms) => `${ms / 1000}s` }, MAP_CONSTS);
    const spans = [span('a_alice', 'a_me', 'answered'), span('a_alice', 'a_me', 'answered'), span('a_bob', 'a_me', 'owner'), span('a_me', 'a_bob', 'owner')];
    assert.equal(did('a_me', spans), 'Answered 2 of 3 · 90s');
    assert.equal(did('a_alice', spans), 'Asked 2');
    assert.equal(did('a_carol', spans), '', 'quiet: nothing to say');
    assert.equal(did('a_me', spans.slice(2), 'live'), '1 open');
  });
});

describe('the map, drawn', () => {
  const els = {};
  const el = (k) => (els[k] ||= { innerHTML: '', textContent: '', hidden: false, attrs: {}, setAttribute(n, v) { this.attrs[n] = v; } });
  const spans = [span('a_alice', 'a_me', 'answered'), span('a_alice', 'a_me', 'answered'), span('a_me', 'a_alice', 'answered'), span('a_me', 'a_bob', 'owner')];
  run(['updateTopo', 'mapLinks', 'linkWords', 'mapState', 'mapDid', 'awayOf', 'whenWords'], 'updateTopo()', {
    ...names, $: el, document: { getElementById: () => ({ clientWidth: 600, clientHeight: 360 }) }, S: { byId: new Map() },
    members: () => ['a_me', 'a_alice', 'a_bob', 'a_carol'].map((id) => ({ ...who(id), about: `${people[id]}’s notes` })),
    mapWindow: 'today', spansIn: (win) => (win === 'live' ? spans.filter((s) => s.status === 'owner') : spans),
    picture: () => '<svg aria-hidden="true"></svg>', secs: () => '1m 2s', median: () => 90e3, fmtMs: () => '1m 30s',
  }, MAP_CONSTS);

  test('an arrow per pair, bent apart when both ask each other, amber where one waits', () => {
    const paths = [...els['#edges'].innerHTML.matchAll(/<path class="link ([^"]*)" d="M([\d.]+) ([\d.]+) Q([\d.]+) ([\d.]+) [^"]*" stroke-width="([\d.]+)" marker-end="url\(#topo-head([^)]*)\)"\/>/g)];
    assert.equal(paths.length, 3);
    const [toMe, toSan, toErn] = [paths.find((p) => p[6] === '3.50'), paths.find((p) => p[6] !== '3.50' && p[1] === ''), paths.find((p) => p[1] === 'is-needs')];
    assert.ok(toMe && toSan && toErn, 'thickest for the most asks');
    assert.notDeepEqual([toMe[4], toMe[5]], [toSan[4], toSan[5]], 'A→B and B→A bend to different sides');
    assert.equal(toErn[7], '-is-needs', 'its head is amber too');
    assert.match(els['#edges'].innerHTML, /<marker id="topo-head-is-needs" class="topo-head is-needs"/);
  });

  test("each count is a button that says the arrow in words and opens those asks; each Oby is named by its Oby's name", () => {
    const links = els['#topo-links'].innerHTML;
    assert.equal(els['#topo-links'].attrs['aria-label'], 'Who asked whom, today');
    assert.match(links, /<span role="listitem" class="topo-count-wrap" style="left:[\d.]+px;top:[\d.]+px"><button type="button" class="topo-count " data-map-page="traffic:a_alice~a_me~today" title="Alice’s Oby asked your Oby twice today: 2 answered" aria-label="Alice’s Oby asked your Oby twice today: 2 answered\. Show them">2<\/button><\/span>/);
    assert.match(links, /class="topo-count is-needs" data-map-page="traffic:a_me~a_bob~today"[^>]*aria-label="Your Oby asked Bob’s Oby once today: 1 waiting for Bob\. Show them">1</);
    const nodes = els['#nodes'].innerHTML;
    assert.match(nodes, /<div class="node is-needs" role="listitem" aria-labelledby="node-n-a_bob" style="left:[\d.]+px;top:[\d.]+px">/);
    assert.match(nodes, /<button type="button" class="node-name" id="node-n-a_bob" data-map-page="traffic:a_bob~~today" title="Bob’s notes">Bob’s Oby<\/button>\s*<span class="node-where">Waiting for Bob · <span class="num" data-since="[^"]*">1m 2s<\/span><\/span>/);
    // the Oby at the top has its lines above it, clear of the arrows coming in
    assert.match(nodes, /<div class="node is-online is-up" role="listitem" aria-labelledby="node-n-a_me" style="left:[\d.]+px;bottom:[\d.]+px">/);
    // an Oby with no asks in the window is quieter, and says nothing more
    assert.match(nodes, /<div class="node is-online is-quiet" role="listitem" aria-labelledby="node-n-a_carol"/);
    assert.doesNotMatch(/aria-labelledby="node-n-a_carol"[\s\S]*?<\/div>/.exec(nodes)[0], /node-did/);
    assert.deepEqual(idsFound(nodes), []);
    assert.equal(els['#topo-empty'].hidden, true);
    assert.match(els['#topo-key'].innerHTML, /Arrows: who asked whom/);
  });
});

describe('Traffic, from the map', () => {
  const RID = { a: /^a_[A-Za-z0-9_-]{1,32}$/ };
  const parse = (arg) => plain(run(['trafficFilter'], 'trafficFilter(ARG)', { RID, ARG: arg }, MAP_CONSTS));

  test('a pair or one Oby, in a window; anything else is all traffic', () => {
    assert.deepEqual(parse('a_alice~a_me~week'), { a: 'a_alice', b: 'a_me', win: 'week' });
    assert.deepEqual(parse('a_alice~~live'), { a: 'a_alice', b: null, win: 'live' });
    assert.deepEqual(parse('a_alice~a_me~forever'), { a: 'a_alice', b: 'a_me', win: 'today' }, 'an unknown window is Today');
    for (const bad of ['', 'a_alice"><x~a_me~today', 'm_1~a_me~today', 'a_alice~a_me"~today', 'a_alice~../x~today']) assert.equal(parse(bad), null, bad);
  });

  test('the page lists only those asks, says whose, and leads back to all traffic', () => {
    const ex = [
      { id: 'e1', status: 'answered', spans: [{ ask: { id: 'm_1' } }] },
      { id: 'e2', status: 'waiting', spans: [{ ask: { id: 'm_2' } }, { ask: { id: 'm_3' } }] },
      { id: 'e3', status: 'answered', spans: [{ ask: { id: 'm_4' } }] },
    ];
    const asks = [span('a_alice', 'a_me', 'answered', { ask: { id: 'm_1' } }), span('a_me', 'a_bob', 'owner', { ask: { id: 'm_3' } }), span('a_bob', 'a_alice', 'answered', { ask: { id: 'm_4' } })];
    const page = (arg) => run(['pageTraffic', 'trafficFilter'], 'pageTraffic(ARG)', {
      ...names, RID, ARG: arg, exchanges: () => ex, spansIn: () => asks,
      head: (t, sub, right = '') => `<h1>${t}</h1><p>${sub}</p>${right}`, exchangeTable: (list, empty) => `[${list.map((e) => e.id).join(',')}]${empty ? `(${empty})` : ''}`,
    }, [...MAP_CONSTS, 'trafficWords']);
    assert.equal(page(''), '<h1>Traffic</h1><p>3 exchanges · 1 in progress</p>[e1,e2,e3]');
    assert.equal(page('a_alice~a_me~today'), '<h1>Traffic</h1><p>Alice’s Oby → your Oby, today · 1 exchange</p><button type="button" class="set-button" data-page="traffic">All traffic</button>[e1](No asks today.)');
    // one Oby: its asks, asking and asked
    assert.match(page('a_bob~~week'), /<p>Bob’s Oby, in the last 7 days · 2 exchanges · 1 in progress<\/p>.*\[e2,e3\]/);
  });
});
