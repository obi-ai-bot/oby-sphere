// When an Oby can't answer (#160), in the console: "Away until Mon 9:00 · on holiday" and "Offline
// since 18:02" on Members, the drawer and a direct conversation's head; an ask that waits for an
// away Oby, or expired; Settings › Answers' "When your runtime can't answer"; Your Oby's away and
// held asks; and an older rep.mjs or relay without any of it, which shows none of it. The page's
// functions run in a sandbox with stand-ins: no browser, no network. `npm test`.
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
// a part of the page's script, between two comments of its own
const between = (from, to) => {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to}`);
  return SCRIPT.slice(a, b);
};

// local times this week, so the words don't depend on the machine's zone
const NOW = new Date(2026, 10, 26, 12, 0); // Thursday, Nov 26 2026, 12:00
const at = (days, h, m = 0) => new Date(2026, 10, 26 + days, h, m);
const weekday = (d) => d.toLocaleDateString([], { weekday: 'short' });
const monthDay = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });

const AVAIL = ['MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'availWords', 'availDot'];

describe('whether an Oby can answer, in one short line', () => {
  const { whenWords, awayOf, availWords, availDot } = sandbox(AVAIL);
  const now = NOW.getTime();

  test('a time: today, within six days, or further', () => {
    assert.equal(whenWords(at(0, 18, 2).toISOString(), now), '18:02');
    assert.equal(whenWords(at(4, 9).toISOString(), now), `${weekday(at(4, 9))} 9:00`, 'Monday at nine');
    assert.equal(whenWords(at(-2, 7, 5).toISOString(), now), `${weekday(at(-2, 7))} 7:05`, 'two days ago');
    assert.equal(whenWords(at(9, 9).toISOString(), now), `${monthDay(at(9, 9))}, 9:00`);
    assert.equal(whenWords(at(-30, 23, 59).toISOString(), now), `${monthDay(at(-30, 23))}, 23:59`);
    assert.equal(whenWords('not a time', now), '');
    assert.equal(whenWords(undefined, now), '');
  });

  test('an away lasts until its time; a relay without one, or one that passed, is none', () => {
    assert.equal(awayOf({}, now), null, 'an older relay sends no away');
    assert.equal(awayOf({ away: null }, now), null);
    assert.equal(awayOf({ away: { until: at(-1, 9).toISOString(), note: 'gone' } }, now), null, 'its time has passed');
    assert.equal(awayOf({ away: { until: 'soon', note: '' } }, now), null, 'not a time');
    assert.deepEqual({ ...awayOf({ away: { until: null, note: '  on\n holiday ' } }, now) }, { until: null, note: 'on holiday' });
    assert.equal(awayOf({ away: { until: at(4, 9).toISOString(), note: 'x'.repeat(500) } }, now).note.length, 120);
  });

  test('Away until Mon 9:00 · on holiday; Offline since 18:02; or its state', () => {
    const away = { until: at(4, 9).toISOString(), note: 'on holiday', since: at(0, 8).toISOString() };
    assert.equal(availWords({ online: false, away }, now), `Away until ${weekday(at(4, 9))} 9:00 · on holiday`);
    assert.equal(availWords({ online: true, away: { ...away, note: '' } }, now), `Away until ${weekday(at(4, 9))} 9:00`, 'online too: its owner is away');
    assert.equal(availWords({ online: false, away: { until: null, note: 'parental leave' } }, now), 'Away · parental leave', 'no set time');
    assert.equal(availWords({ online: false, lastSeen: at(0, 9, 41).toISOString() }, now), 'Offline since 9:41');
    assert.equal(availWords({ online: false, lastSeen: at(-1, 18, 2).toISOString() }, now), `Offline since ${weekday(at(-1, 18))} 18:02`);
    assert.equal(availWords({ online: false }, now), 'Offline', 'no lastSeen: just the state');
    assert.equal(availWords({ online: true }, now), 'Online');
    assert.equal(availWords({ online: true, status: { state: 'working' } }, now), 'Working');
    assert.equal(availWords({ online: true, suspended: true, away }, now), 'Suspended');
    assert.equal(availWords({ online: true, away: { until: at(-1, 9).toISOString(), note: 'old' } }, now), 'Online', 'an away that ended');
    assert.equal(availDot({ online: true, away: { until: null, note: '' } }), 'away');
    assert.equal(availDot({ online: false }), 'offline');
  });

  test('Members: the line in the Status column, escaped, with the away dot', () => {
    const ctx = {
      S: { me: { id: 'a_me' }, admin: false, sphere: { policy: {} } },
      members: () => [
        { id: 'a_bob', name: 'bob', owner: 'Bob', online: false, away: { until: null, note: HOSTILE } },
        { id: 'a_sam', name: 'sam', owner: 'Sam', online: false, lastSeen: new Date(Date.now() - 60e3).toISOString() },
      ],
      isMe: (a) => a.id === 'a_me', ownerName: (a) => a.owner, label: (a) => a.owner, obyOf: (a) => a.owner, picture: () => '',
      fmtMs: (n) => `${n} ms`, head: (t, sub, right = '') => `<h1>${t}</h1>${sub}${right}`, answersWith: () => '', esc,
    };
    const { pageMembers } = sandbox([...AVAIL, 'agentIdOk', 'pageMembers'], ctx);
    const html = pageMembers();
    assert.ok(!html.includes('<img'), 'a note from the relay is text');
    assert.ok(html.includes(`Away · ${esc(HOSTILE)}`));
    assert.match(html, /status-dot is-away/);
    assert.match(html, /Offline since \d{1,2}:\d{2}/);
    assert.ok(!/seen \d|just now/.test(html), 'the time it went offline, not "seen 1m ago"');
  });

  test('the drawer, a member row and a direct conversation’s head say it too', () => {
    const row = pick('memberRow');
    assert.match(row, /esc\(availWords\(a\)\)/, 'the drawer');
    assert.match(row, /status-dot is-away/, 'the row’s dot');
    const head = pick('renderHead');
    assert.match(head, /conv-avail">\$\{esc\(availWords\(o\)\)\}/, 'before you ask their Oby');
    const you = pick('youSub');
    assert.match(you, /esc\(availWords\(me\)\)/, 'Your Oby’s own line');
  });

  test('under the message box: when the Oby you’d ask answers', () => {
    const { laterWords } = sandbox([...AVAIL, 'laterWords'], { obyOf: (a) => `${a.owner}’s Oby` });
    const until = new Date(Date.now() + 2 * 3600e3);
    assert.match(laterWords({ owner: 'Bob', online: true, away: { until: until.toISOString(), note: 'x' } }), /^Bob’s Oby is away until \d{1,2}:\d{2}|^Bob’s Oby is away until \w+ \d{1,2}:\d{2}/);
    assert.equal(laterWords({ owner: 'Bob', online: false, away: { until: null, note: '' } }), 'Bob’s Oby is away; it answers when it’s back.');
    assert.equal(laterWords({ owner: 'Sam', online: false }), 'Sam’s Oby is offline; it answers when it’s back.');
    assert.equal(laterWords({ owner: 'Sam', online: true }), '');
  });

  test('Settings no longer calls an offline Oby "away"', () => {
    for (const f of ['askerOptions', 'agentsHtml']) assert.ok(!/' · away'/.test(pick(f)), f);
  });
});

describe('an ask that waits for an away Oby, or expired', () => {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const agents = {
    a_bob: { id: 'a_bob', name: 'bob', online: true },
    a_amy: { id: 'a_amy', name: 'amy', online: false, away: { until: iso(3600e3), note: 'on holiday' } },
    a_sam: { id: 'a_sam', name: 'sam', online: false },
  };
  const make = (messages) => {
    const ctx = { S: { messages }, agent: (id) => agents[id] || { id, name: 'unknown' } };
    return sandbox(['MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'spanOf'], ctx).spanOf;
  };
  const ask = (to, extra = {}) => ({ id: `m_${to}`, kind: 'ask', from: 'a_me', to: [to], channel: 'general', ts: iso(-60e3), ...extra });

  test('its state: away, offline, waiting; expired by its deadline or by the answering Oby', () => {
    const replyTo = (a, meta) => ({ id: `m_r_${a.id}`, kind: 'reply', from: a.to[0], replyTo: a.id, ts: iso(-1e3), meta });
    const asks = [ask('a_amy'), ask('a_sam'), ask('a_bob'), ask('a_bob', { id: 'm_late', neededBy: iso(-5e3) }), ask('a_sam', { id: 'm_old' })];
    const spanOf = make([...asks, replyTo(asks[4], { expired: true })]);
    assert.equal(spanOf(asks[0]).status, 'away');
    assert.equal(spanOf(asks[1]).status, 'offline');
    assert.equal(spanOf(asks[2]).status, 'waiting');
    const late = spanOf(asks[3]);
    assert.equal(late.status, 'expired', 'its deadline passed with no reply');
    assert.equal(late.endMs, Date.parse(asks[3].neededBy), 'it ended then: the time taken stops growing');
    assert.equal(spanOf(asks[4]).status, 'expired', 'the "expired" reply');
    assert.equal(make([ask('a_bob', { neededBy: iso(60e3) })])(ask('a_bob', { neededBy: iso(60e3) })).status, 'waiting', 'a deadline still ahead');
  });

  test('its words and its dot', () => {
    const { STATUS_WORDS } = sandbox(['STATUS_WORDS']);
    assert.equal(STATUS_WORDS.away, 'Waiting, away');
    assert.equal(STATUS_WORDS.expired, 'Expired');
    assert.match(PAGE, /\.status-dot\.is-away \{ background: var\(--needs\); \}/);
    assert.match(PAGE, /\.status-dot\.is-expired \{ background: var\(--muted\); \}|\.status-dot\.is-expired[^{]*\{ background: var\(--muted\); \}/);
    const trace = pick('traceHtml');
    assert.match(trace, /can answer after \$\{esc\(whenWords\(w\.until\)\)\}/);
    assert.match(trace, /is offline\$\{/);
  });

  test('the audit log: away is a Members event', () => {
    const { auditFilter } = sandbox(['AUDIT_GROUPS', 'auditFilter']);
    const ev = [{ seq: 1, ts: new Date().toISOString(), type: 'away', actor: 'a_bob', detail: 'bob is away until further notice' }, { seq: 2, ts: new Date().toISOString(), type: 'ask', actor: 'a_bob', detail: '' }];
    assert.deepEqual(auditFilter(ev, { type: 'members' }).map((e) => e.seq), [1]);
    assert.match(pick('TYPE_WORDS'), /away: 'away'/);
  });
});

describe("Settings › Answers: when your runtime can't answer", () => {
  const CTLS = ['CTL', 'ctlSame', 'ctlName', 'ctlAttrs', 'CTL_CHEV', 'ctlSegmented', 'ctlDropdown', 'ctlDdInner', 'ctlStepper', 'ctlSwitch'];
  const render = (availability, envReady = {}) => {
    const ctx = {
      esc,
      SET: { settings: { routing: { default: { runtime: 'claude' } }, availability } },
      envRuntime: (id) => envReady[id] || null,
      rtLabel: (id) => ({ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[id] || id),
      trustedOnly: (id) => id !== 'claude',
      runtimeOptions: () => ['claude', 'codex', 'cursor', 'other'].map((v) => ({ value: v, label: v })),
    };
    const f = sandbox([...CTLS, 'fid', 'swRow', 'RUNTIME_IDS', 'AVAIL_DEFAULTS', 'UNABLE_WORDS', 'UNABLE_SUB', 'otherRuntimePick', 'availabilityHtml'], ctx);
    return { html: f.availabilityHtml(), f, ctx };
  };
  const DEFAULTS = { whenUnable: 'hold', otherRuntime: null, holdHours: 24, showReason: false };

  test('Hold, Another runtime or Decline; a longest hold in hours; whether askers hear why', () => {
    const { html } = render({ ...DEFAULTS });
    assert.match(html, /When your runtime can’t answer/);
    assert.match(html, /role="radiogroup"[^>]*aria-labelledby="set-availability-l"[^>]*data-k="availability\.whenUnable"/);
    for (const w of ['>Hold<', '>Another runtime<', '>Decline<']) assert.ok(html.includes(w), w);
    assert.match(html, /aria-checked="true" tabindex="0">Hold</, 'hold is picked');
    assert.match(html, /The ask waits, and your Oby answers it once it can\./);
    assert.match(html, /Longest hold, in hours/);
    assert.match(html, /Also how old an ask your Oby still answers after being offline\./, 'one line: it is also the oldest ask answered after being offline');
    assert.match(html, /role="spinbutton"[^>]*aria-valuemin="1" aria-valuemax="168" aria-valuenow="24"/);
    assert.match(html, /data-k="availability\.holdHours"/);
    assert.match(html, /Tell askers why/);
    assert.match(html, /role="switch" aria-checked="false"[^>]*data-k="availability\.showReason"/);
    assert.ok(!/data-k="availability\.otherRuntime"/.test(html), 'no runtime to pick unless Another runtime');
    for (const bad of ['<select', 'type="number"', 'type="time"', 'type="checkbox"']) assert.ok(!html.includes(bad), bad);
  });

  test('Another runtime: a runtime to pick, among the three; Codex and Cursor for trusted Obys only', () => {
    const { html } = render({ ...DEFAULTS, whenUnable: 'other', otherRuntime: 'codex' });
    assert.match(html, /data-k="availability\.otherRuntime"/);
    assert.match(html, /Codex answers trusted Obys only: anyone else’s ask is declined\./);
    assert.match(html, /Another runtime answers it\./);
    const claude = render({ ...DEFAULTS, whenUnable: 'other', otherRuntime: 'claude' }).html;
    assert.ok(!/trusted Obys only/.test(claude));
    assert.match(render({ ...DEFAULTS, whenUnable: 'decline' }).html, /The asker is told your Oby can’t answer it right now\./);
  });

  test('picking Another runtime picks one for you: not the default’s, a ready one first', () => {
    assert.equal(render({ ...DEFAULTS }).f.otherRuntimePick(), 'codex');
    assert.equal(render({ ...DEFAULTS }, { cursor: { installed: true, signedIn: true }, codex: { installed: false } }).f.otherRuntimePick(), 'cursor');
    const af = pick('afterChange');
    assert.match(af, /if \(a\.whenUnable === 'other' && !a\.otherRuntime\) a\.otherRuntime = otherRuntimePick\(\);/);
  });

  test('an older rep.mjs has no availability: the card isn’t there, and nothing is added to what is saved', () => {
    const ctx = {};
    const { normalizeSettings } = sandbox(['AVAIL_DEFAULTS', 'normalizeSettings'], ctx);
    const old = { routing: {}, access: {}, machine: { folders: [] } };
    normalizeSettings(old);
    assert.ok(!('availability' in old), 'never sent to a rep.mjs that would refuse it');
    const now = { routing: {}, access: {}, machine: { folders: [] }, availability: { whenUnable: 'decline' } };
    normalizeSettings(now);
    assert.deepEqual({ ...now.availability }, { ...DEFAULTS, whenUnable: 'decline' });
    assert.match(pick('renderSettings'), /\$\{s\.availability \? `<div class="route-unable" data-part="availability"/);
    // the field's words when the rep says it doesn't pass
    assert.match(pick('FIELD_WORDS'), /holdHours: 'longest hold'/);
  });

  test('notifications: pausing and coming back, only when rep.mjs has them', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`${between('const NOTIFY_EVENT_ROWS = [', '];')}];\n${pick('normalizeNotify')}\nthis.normalizeNotify = normalizeNotify;`, ctx);
    const s = { notify: {} };
    ctx.normalizeNotify(s);
    assert.equal(Object.keys(s.notify.events).length, 6, 'the six events every rep.mjs has');
    assert.ok(!('paused' in s.notify.events) && !('resumed' in s.notify.events), 'not added for an older rep.mjs, which refuses them');
    assert.match(pick('notifyHtml'), /NOTIFY_EVENT_ROWS_NEWER\.filter\(\(\[k\]\) => k in ev\)/);
    assert.match(SCRIPT, /\['paused', 'Your Oby pauses: out of usage or signed out'\]/);
  });
});

describe('Your Oby: away, and the asks it holds', () => {
  const now = new Date(2026, 10, 27, 15, 30); // a Friday afternoon
  const parts = ['ctlPad', 'midnight', 'nextWorkday', 'awayDays', 'awayUntil', 'okAway'];

  test('the days to pick: none, today, tomorrow, then up to 29 days ahead; Monday after a Friday', () => {
    const { awayDays, nextWorkday } = sandbox(parts);
    const days = awayDays(now);
    assert.equal(days.length, 31);
    assert.deepEqual([days[0].value, days[0].label], ['none', 'No set time']);
    assert.deepEqual([days[1].value, days[1].label, days[2].label], [0, 'Today', 'Tomorrow']);
    assert.equal(days[30].value, 29);
    assert.equal(nextWorkday(now), 3, 'Friday → Monday');
    assert.equal(nextWorkday(new Date(2026, 10, 28)), 2, 'Saturday → Monday');
    assert.equal(nextWorkday(new Date(2026, 10, 30)), 1, 'Monday → Tuesday');
  });

  test('a day and a time make the until; no set time is null', () => {
    const { awayUntil } = sandbox(parts);
    assert.equal(awayUntil(3, '09:00', now).getTime(), new Date(2026, 10, 30, 9, 0).getTime());
    assert.equal(awayUntil(0, '23:45', now).getTime(), new Date(2026, 10, 27, 23, 45).getTime());
    assert.equal(awayUntil('none', '09:00', now), null);
  });

  test('what rep.mjs says is kept in the page’s shape: a passed away is none', () => {
    const { okAway } = sandbox(parts);
    const t = now.getTime();
    assert.equal(okAway(null, t), null);
    assert.equal(okAway({ by: 'owner', until: new Date(t - 1).toISOString(), note: 'x' }, t), null);
    assert.deepEqual({ ...okAway({ by: 'pause', until: null, note: '' }, t) }, { by: 'pause', until: null, note: '' });
    assert.equal(okAway({ by: 'someone', until: null, note: 'n' }, t).by, 'owner');
  });

  // the page's Your Oby functions with stand-ins for the rest of the page
  const youCtx = (local, extra = {}) => {
    const ctx = {
      CONSOLE: { profile: 'me' }, S: { me: { id: 'a_me' }, mode: 'console', page: 'you', agents: new Map() }, esc,
      RID: { m: /^m_[A-Za-z0-9_-]{1,32}$/, a: /^a_[A-Za-z0-9_-]{1,32}$/ }, CHAN: /^[a-z0-9-]{1,32}$/,
      local, members: () => [{ id: 'a_bob', name: 'bob', owner: 'Bob' }], agent: (id) => ({ id, name: 'x', owner: 'X' }),
      avatar: () => '', obyOf: (a) => `${a.owner}’s Oby`, where: (c) => `#${c}`, time: () => '14:02', ctlInfo: () => '(i)',
      document: { getElementById: () => null }, ...extra,
    };
    const f = sandbox(['YOU', 'HELD_WHY', ...parts, 'MEMBER_STATE', 'stateOf', 'whenWords', 'awayOf', 'loadYou', 'paintYou', 'awayHtml', 'heldFrom', 'heldHtml'], ctx);
    return { f, ctx };
  };

  test('an older rep.mjs (404 for both): nothing about away or held on the page', async () => {
    const calls = [];
    const { f, ctx } = youCtx(async (method, p) => { calls.push(p); const e = new Error('not found'); e.status = 404; throw e; });
    await f.loadYou();
    vm.runInContext('this.off = [YOU.awayOff, YOU.heldOff]', ctx);
    assert.deepEqual([...ctx.off], [true, true]);
    assert.equal(f.awayHtml(), '');
    assert.equal(f.heldHtml(), '');
    await f.loadYou();
    assert.deepEqual(calls, ['/local/away', '/local/held'], 'not asked again');
  });

  test('away: set it, change it or end it; a pause says so; the held asks, escaped', async () => {
    const until = new Date(Date.now() + 3 * 864e5).toISOString();
    const replies = {
      '/local/away': { away: { by: 'owner', until, note: HOSTILE, since: new Date().toISOString() } },
      '/local/held': { held: [
        { id: 'm_held1', from: 'bob', channel: 'general', ts: new Date().toISOString(), heldAt: new Date().toISOString(), until: null, tries: 1, kind: 'limit', words: HOSTILE },
        { id: 'not an id', from: 'bob', words: 'dropped' },
      ] },
    };
    const { f } = youCtx(async (method, p) => replies[p]);
    await f.loadYou();
    const away = f.awayHtml();
    assert.match(away, /Away until /);
    assert.ok(!away.includes('<img') && away.includes(esc(HOSTILE)), 'the note is text');
    assert.match(away, /data-away="edit">Change</);
    assert.match(away, /data-away="back">I’m back</);
    const held = f.heldHtml();
    assert.match(held, /Held · 1/, 'an id that isn’t one is dropped');
    assert.ok(!held.includes('<img') && held.includes(esc(HOSTILE)), 'the ask’s words are text');
    assert.match(held, /Bob’s Oby asks/);
    assert.match(held, /Out of usage · next try when it can/);
    assert.match(held, /data-held-do="retry">Try now</);
    assert.match(held, /data-held-do="drop"[^>]*>Drop</);

    const none = youCtx(async (method, p) => (p === '/local/away' ? { away: null } : { held: [] }));
    await none.f.loadYou();
    assert.match(none.f.awayHtml(), /data-away="edit">Set away</);
    assert.equal(none.f.heldHtml(), '', 'nothing held: no section');

    const pause = youCtx(async (method, p) => (p === '/local/away' ? { away: { by: 'pause', until, note: '' } } : { held: [] }));
    await pause.f.loadYou();
    assert.match(pause.f.awayHtml(), /Paused until [\s\S]*Your runtime can’t answer right now\./);
  });

  test('the form: our dropdown and time picker, a note of 120 characters at most; POST /local/away', () => {
    const form = pick('awayFormHtml');
    assert.match(form, /ctlDropdown\(\{ id: 'you-away-day'/);
    assert.match(form, /ctlTime\(\{ id: 'you-away-time'/);
    assert.match(form, /maxlength="120"/);
    const act = pick('awayDo');
    assert.match(act, /local\('POST', '\/local\/away', body\)/);
    assert.match(act, /body = \{ off: true \}/);
    assert.match(act, /That time has passed: pick a later one\./);
    assert.match(pick('heldDo'), /local\('POST', '\/local\/held', \{ id, action \}\)/);
    const you = between("// ---------------------------------------------------------------- your Oby: away, and the asks it holds", '// ---------------------------------------------------------------- what waits for you');
    for (const bad of ['<select', 'type="number"', 'type="time"', 'type="checkbox"', 'type="date"', 'type="datetime-local"']) assert.ok(!you.includes(bad), `Your Oby has no ${bad}`);
  });
});
