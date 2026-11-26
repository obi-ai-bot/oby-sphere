// The console's accessibility (#137), without a browser. It reads public/index.html: its template
// and the markup its script builds in template literals. Every button has a name and every field a
// label; the dialogs are modal, named, and hold the focus; the view switch is a set of tabs and the
// side panel's lists are navigation; the live parts (the map, the live log, new messages, what
// waits for you) have their regions, and the voice that speaks for them sums up instead of flooding;
// and every text colour, field edge and focus ring meets WCAG 2.2 AA in each theme the page
// defines, worked out from its CSS tokens. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  PAGE, STYLE, TEMPLATE, SCRIPT,
  tags, attr, hasAttr, buttonName, fieldLabel, fnSource,
  cssRules, themes, resolve, parseColor, tokenColor, over, ratio,
  h, fakeDocument, cssEscape,
} from './accessibility-helpers.mjs';

const both = [['the template', TEMPLATE], ['the script', SCRIPT]];
const fn = (name) => fnSource(name);
// the part of the template inside <div class="window"> (the page behind a dialog)
const windowAt = TEMPLATE.indexOf('<div class="window">');
const windowEnd = TEMPLATE.indexOf('<div class="modal-backdrop"');

// ---------------------------------------------------------------- names and labels

describe('names and labels', () => {
  test('every button the page makes has a name', () => {
    const missing = [];
    let seen = 0;
    for (const [where, src] of both) {
      for (const t of tags(src, ['button'])) {
        seen++;
        let name = buttonName(src, t);
        if (!name && where === 'the template') {
          // a template button the script names before it's shown: its own words, or a part of it
          const close = src.indexOf('</button>', t.end);
          const ids = [attr(t.tag, 'id'), ...[...src.slice(t.end, close).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])].filter(Boolean);
          if (ids.some((id) => SCRIPT.includes(`$('#${id}').textContent =`))) name = '(named by the script)';
        }
        if (!name) missing.push(`${where}: ${t.tag.slice(0, 120)}`);
      }
    }
    assert.ok(seen > 80, `found only ${seen} buttons: the scan lost them`);
    assert.deepEqual(missing, []);
  });

  test('an icon-only button is named in words, not by its picture', () => {
    // the ones whose only content is an icon: their aria-label is what a screen reader says
    for (const id of ['toggle', 'plus', 'send', 'rail-console', 'rail-conv']) {
      const t = tags(TEMPLATE, ['button']).find((x) => attr(x.tag, 'id') === id);
      assert.ok(t, id);
      assert.match(attr(t.tag, 'aria-label') || '', /^[A-Z][a-z]/, `#${id} has words for a name`);
    }
    for (const t of tags(TEMPLATE, ['button']).filter((x) => hasAttr(x.tag, 'data-close'))) assert.equal(attr(t.tag, 'aria-label'), 'Close');
    // the rows' icon buttons in Settings, and the composer's file tags
    for (const marker of ['data-rule-move="${i}" data-dir="-1"', 'data-rule-remove=', 'data-folder-remove=', 'data-untag="${i}"', 'data-untag="to"']) {
      const t = tags(SCRIPT, ['button']).find((x) => x.tag.includes(marker));
      assert.ok(t && attr(t.tag, 'aria-label'), marker);
    }
  });

  test('every field has a label', () => {
    const missing = [];
    let seen = 0;
    for (const [where, src] of both) {
      for (const t of tags(src, ['input', 'select', 'textarea'])) {
        const type = attr(t.tag, 'type');
        if (type === 'hidden' || (type === 'file' && hasAttr(t.tag, 'hidden'))) continue; // never shown: "Add files" opens it
        seen++;
        if (!fieldLabel(src, t)) missing.push(`${where}: ${t.tag.slice(0, 120)}`);
      }
    }
    assert.ok(seen > 35, `found only ${seen} fields`);
    assert.deepEqual(missing, []);
  });

  test('a placeholder is never the only label', () => {
    for (const [where, src] of both) {
      for (const t of tags(src, ['input', 'textarea'])) {
        if (!attr(t.tag, 'placeholder')) continue;
        assert.ok(fieldLabel(src, t), `${where}: ${t.tag.slice(0, 100)}`);
      }
    }
  });

  test('roles: interactive ones are on buttons, a picture with a role has words, aria-label only where a role allows it', () => {
    const wrong = [];
    for (const [where, src] of both) {
      for (const t of tags(src, ['[a-z][a-z0-9]*'])) {
        const role = attr(t.tag, 'role');
        if (['tab', 'switch', 'menuitem', 'option'].includes(role) && t.name !== 'button') wrong.push(`${where}: ${role} on a ${t.name}`);
        if (role === 'img' && !attr(t.tag, 'aria-label')) wrong.push(`${where}: a picture without words: ${t.tag.slice(0, 90)}`);
        // a div, span, p or pre has no role of its own, so a label on it is ignored (or refused)
        if (['div', 'span', 'p', 'pre'].includes(t.name) && attr(t.tag, 'aria-label') && !role) wrong.push(`${where}: aria-label on a plain ${t.name}: ${t.tag.slice(0, 90)}`);
        if (role === 'switch' && !hasAttr(t.tag, 'aria-checked')) wrong.push(`${where}: a switch without aria-checked: ${t.tag.slice(0, 90)}`);
      }
    }
    assert.deepEqual(wrong, []);
    // the Policy page's switches say whether they're on
    for (const k of ['data-pause', 'data-seal']) assert.match(fn('pagePolicy'), new RegExp(`${k} \\$\\{dis\\} role="switch" aria-checked="\\$\\{`));
  });

  test('a table column of buttons has a header for screen readers', () => {
    for (const f of ['pageMembers', 'pageAdmins']) {
      assert.ok(!/<th><\/th>/.test(fn(f)), `${f}: an empty header`);
      assert.match(fn(f), /<th><span class="sr-only">Actions<\/span><\/th>/);
    }
  });

  test("a table's hidden header stays inside the table's own scroll, so the page never scrolls sideways", () => {
    // .sr-only is absolutely placed: without a placed .table-wrap, it lands beside the whole page on a phone
    assert.match(STYLE, /\.table-wrap \{ position: relative; overflow-x: auto;/);
  });
});

// ---------------------------------------------------------------- dialogs

describe('dialogs', () => {
  const dialogs = tags(TEMPLATE, ['div']).filter((t) => attr(t.tag, 'role') === 'dialog');

  test('each is a modal dialog with a name, inside its own backdrop', () => {
    assert.equal(dialogs.length, 4, 'Invite member, New exchange, Admin access, New channel');
    assert.equal((TEMPLATE.match(/class="modal-backdrop"/g) || []).length, dialogs.length);
    for (const d of dialogs) {
      assert.equal(attr(d.tag, 'aria-modal'), 'true', d.tag);
      const by = attr(d.tag, 'aria-labelledby');
      assert.ok(by && TEMPLATE.includes(`id="${by}"`), `${d.tag}: named by a heading in it`);
      assert.match(TEMPLATE.slice(d.end, d.end + 300), new RegExp(`<h2 id="${by}">`));
      assert.equal(attr(d.tag, 'tabindex'), '-1', 'it can take the focus itself when nothing in it can');
      const desc = attr(d.tag, 'aria-describedby');
      if (desc) assert.ok(TEMPLATE.includes(`id="${desc}"`), desc);
      assert.ok(d.at > windowEnd, 'outside the page, so the page can go inert behind it');
    }
  });

  test('focus goes in, stays in, leaves on Escape and comes back', () => {
    const modal = fn('a11yModal');
    assert.match(modal, /\$\('\.window'\)\.inert = true/, 'the page behind goes inert');
    assert.match(modal, /querySelectorAll\(FOCUSABLE\)\][\s\S]*?\.focus\(\)/, 'focus goes in when the opener left it outside');
    assert.match(modal, /\$\('\.window'\)\.inert = false/, 'and the page comes back');
    assert.match(modal, /was\.from/, 'focus goes back to what opened it');
    const setup = fn('a11ySetup');
    assert.match(setup, /e\.key === 'Tab' && openModal\(\)/, 'Tab and Shift+Tab wrap inside an open dialog');
    assert.match(setup, /r\.target\.classList\?\.contains\('modal-backdrop'\)\) a11yModal\(r\.target\)/, 'every way of opening or closing one is seen');
    assert.match(setup, /attributeFilter: \['hidden'\]/);
    // Escape: the existing handler closes dialogs, after an open menu (a11yEscape) has had its turn
    assert.match(fn('wire'), /if \(e\.key === 'Escape' && a11yEscape\(\)\) return;[\s\S]*?if \(e\.key === 'Escape'\) \{\s*document\.querySelectorAll\('\.modal-backdrop'\)\.forEach\(\(m\) => !m\.hidden && closeModal\(m\)\)/);
  });

  test('a dialog that only fills in later still puts focus somewhere useful, and errors are spoken', () => {
    assert.match(fn('openAdmin'), /\$\('#adm-key'\)\.focus\(\)/);
    assert.match(fn('openNew'), /\$\('#text'\)\.focus\(\)/);
    assert.match(fn('paintInvite'), /form\.link\.focus\(\)[\s\S]*main\?\.focus\(\)/);
    assert.match(TEMPLATE, /id="adm-error" role="alert"/);
    assert.match(fn('paintInvite'), /id="inv-err" role="alert"/);
    for (const f of ['openChannelModal', 'openMembersModal']) assert.match(fn(f), /id="ch-problem" role="alert"/, f);
  });
});

// ---------------------------------------------------------------- landmarks, tabs and keyboard paths

describe('landmarks, tabs and keyboard paths', () => {
  test('Console and Conversation are tabs, each controlling its panel', () => {
    const list = tags(TEMPLATE, ['div']).find((t) => attr(t.tag, 'role') === 'tablist');
    assert.ok(list, 'a tablist');
    assert.equal(attr(list.tag, 'aria-orientation'), 'vertical');
    assert.ok(attr(list.tag, 'aria-label'));
    for (const [tab, panel] of [['rail-console', 'console'], ['rail-conv', 'conv']]) {
      const t = tags(TEMPLATE, ['button']).find((x) => attr(x.tag, 'id') === tab);
      assert.ok(t.at > list.at && t.at < TEMPLATE.indexOf('</div>', list.end), `${tab} is in the tablist`);
      assert.equal(attr(t.tag, 'role'), 'tab');
      assert.equal(attr(t.tag, 'aria-controls'), panel);
      assert.ok(!hasAttr(t.tag, 'aria-pressed'), 'a tab, not a toggle');
      const p = tags(TEMPLATE, ['div']).find((x) => attr(x.tag, 'id') === panel);
      assert.equal(attr(p.tag, 'role'), 'tabpanel');
      assert.equal(attr(p.tag, 'aria-labelledby'), tab);
    }
    assert.match(fn('renderAll'), /a11yTabs\(con\);/);
    assert.match(fn('a11yTabs'), /setAttribute\('aria-selected', String\(on\)\)[\s\S]*tabIndex = on \? 0 : -1/, 'one tab stop: the selected tab');
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.ok(fn('a11ySetup').includes(`${key}:`), key);
  });

  test('the side panel is labelled, and its lists are navigation that says where you are', () => {
    assert.match(TEMPLATE, /<nav id="nav" aria-label="Pages"><\/nav>/);
    assert.match(TEMPLATE, /<nav class="side-part" id="side-conv" aria-label="Conversations" hidden>/);
    // <aside> and the rail's <nav> keep their tags (console-polish checks them), so the script labels them
    assert.match(fn('a11ySetup'), /side\.setAttribute\('aria-label', 'Side panel'\)/);
    assert.match(fn('a11ySetup'), /\$\('\.rail'\)\.setAttribute\('aria-label', 'Views'\)/);
    assert.match(fn('renderNav'), /page === k \? ' aria-current="page"' : ''/);
    assert.match(fn('renderChannels'), /c\.name === S\.current \? ' aria-current="page"' : ''/);
    assert.match(fn('memberRow'), /active \? ' aria-current="page"' : ''/);
    // its group names are headings (Sphere, You, Admin; Channels, Direct messages, Bots)
    assert.match(fn('renderNav'), /<h3 class="sidebar-group-head">\$\{label\}<\/h3>/);
    assert.equal((TEMPLATE.match(/<h3 class="sidebar-group-head"/g) || []).length, 3);
    // the Sphere's tile and your picture in the rail are pictures with words, not buttons that do nothing
    assert.match(TEMPLATE, /<div class="rail-button is-on" id="rail-sphere" role="img" aria-label="[^"]+"/);
    assert.match(fn('a11ySetup'), /\$\('#rail-sphere'\)\.setAttribute\('aria-label', S\.sphere\.name\)/);
    assert.match(fn('boot'), /<span class="rail-button" role="img" aria-label="You: \$\{esc\(S\.me\.owner\)\} \(\$\{esc\(S\.me\.name\)\}\)"/);
  });

  test('a skip link comes first, and lands on the page or the message box', () => {
    const first = /<div class="window">\s*<a class="skip-link" id="skip" href="#page">Skip to the content<\/a>/;
    assert.match(TEMPLATE, first);
    assert.match(fn('a11ySetup'), /\$\('#skip'\)\.addEventListener\('click', \(e\) => \{ e\.preventDefault\(\); a11yLanding\(\)\?\.focus\(\); \}\)/, "the link's hash would replace the key's");
    assert.match(fn('a11yLanding'), /\$\('#page h1'\)/);
    assert.match(fn('head'), /<h1 class="page-title" tabindex="-1">/, 'the page title can take the focus');
  });

  test('everything that opens something is reachable with Tab', () => {
    // the exchanges tables' rows open on click; each holds a button that does the same
    const table = fn('exchangeTable');
    const row = /<tr class="is-link" data-page="exchange:\$\{e\.id\}">([\s\S]*?)<\/tr>/.exec(table);
    assert.ok(row, 'a row that opens its exchange');
    assert.match(row[1], /<button type="button" class="row-open" aria-label="\$\{esc\(a11yExchangeName\(e\)\)\}">\$\{esc\(clock\(e\.start\)\)\}<\/button>/);
    // nothing else that opens a page is anything but a button
    for (const t of tags(SCRIPT, ['[a-z][a-z0-9]*']).filter((x) => /\sdata-page="/.test(x.tag))) assert.ok(['button', 'tr'].includes(t.name), t.tag.slice(0, 80));
    // the old "button" in the rail that did nothing is gone
    assert.ok(!/<button class="rail-button[^"]*" id="rail-sphere"/.test(TEMPLATE));
  });

  test('menus take arrow keys; the @ list points the message box at its pick', () => {
    const setup = fn('a11ySetup');
    assert.match(setup, /closest\?\.\('\[role="menu"\]'\)/);
    assert.match(setup, /ArrowDown: i \+ 1, ArrowUp: i - 1, Home: 0, End: items\.length - 1/);
    assert.match(fn('a11yEscape'), /toggleAccount\(false\); \$\('#account-button'\)\?\.focus\(\)/, 'Escape closes your account menu and returns to its button');
    assert.match(fn('a11yEscape'), /closeAdd\(\); \$\('#plus'\)\.focus\(\)/, 'and the + menu');
    assert.match(fn('openAdd'), /a11yMenuOpened\(\$\('#add-panel'\), 'menu'\)/);
    assert.match(fn('mentionMenu'), /role="option" id="mention-\$\{i\}" aria-selected="\$\{i === C\.pick\}"/);
    assert.match(fn('mentionMenu'), /a11yMenuOpened\(\$\('#add-panel'\), 'listbox'\)/);
    assert.match(fn('a11yMenuOpened'), /setAttribute\('aria-activedescendant', `mention-\$\{C\.pick\}`\)/);
    assert.match(fn('closeAdd'), /removeAttribute\('aria-activedescendant'\)/);
    assert.match(TEMPLATE, /id="text"[^>]*aria-autocomplete="list" aria-controls="add-panel"/);
    assert.match(TEMPLATE, /id="plus"[^>]*aria-expanded="false" aria-controls="add-panel"/);
  });

  test('the side panel on a phone: its toggle says whether it is open, and it opens for the keyboard', () => {
    assert.match(TEMPLATE, /id="toggle" aria-label="Side panel" aria-expanded="false" aria-controls="side"/);
    const setup = fn('a11ySetup');
    assert.match(setup, /\$\('#toggle'\)\.setAttribute\('aria-expanded', String\(open\)\)/);
    assert.match(setup, /side\.addEventListener\('focusin'/);
    assert.match(fn('a11yEscape'), /\$\('#toggle'\)\.focus\(\); side\.classList\.remove\('is-open'\)/);
  });

  test('focus survives the re-renders of a busy Sphere', () => {
    const setup = fn('a11ySetup');
    assert.match(setup, /\.observe\(\$\('#root'\), \{ childList: true, subtree: true/);
    assert.match(setup, /if \(A11Y\.key && \(!a \|\| a === document\.body\)\) a11yRestore\(\)/);
    assert.match(fn('a11yKeyOf'), /startsWith\('data-'\)/, 'found again by its data-* attributes');
  });
});

// ---------------------------------------------------------------- live updates

describe('live updates', () => {
  test('one polite, atomic region, outside the page a dialog makes inert', () => {
    const r = tags(TEMPLATE, ['div']).find((t) => attr(t.tag, 'id') === 'a11y-status');
    assert.ok(r, '#a11y-status');
    assert.equal(attr(r.tag, 'role'), 'status');
    assert.equal(attr(r.tag, 'aria-live'), 'polite');
    assert.equal(attr(r.tag, 'aria-atomic'), 'true');
    assert.match(attr(r.tag, 'class'), /\bsr-only\b/);
    assert.ok(r.at > windowEnd, 'outside .window');
    assert.match(STYLE, /\.sr-only \{ position: absolute !important; width: 1px; height: 1px;/);
  });

  test('the map, the live log and the messages have names and roles, and stay quiet themselves', () => {
    const ov = fn('renderOverview');
    assert.match(ov, /id="topo" role="group" aria-labelledby="map-title" aria-describedby="map-about"/);
    assert.match(fn('buildTopo'), /<svg class="edges" id="edges" aria-hidden="true">/);
    assert.match(fn('buildTopo'), /id="nodes" role="list"/);
    assert.match(fn('updateTopo'), /<div class="node is-\$\{st\}" role="listitem"/);
    // the log: a named log that keyboard users can scroll; its rows aren't read one by one
    assert.match(ov, /id="log" role="log" aria-labelledby="log-title" aria-live="off" tabindex="0"/);
    // the thread: a log too (browser tests find it by that role), quiet for the same reason
    assert.match(TEMPLATE, /<section class="chat" id="feed" role="log" aria-label="Messages" aria-live="off" tabindex="-1">/);
    // what ticks every second (seconds, KPIs) is never in a polite region of its own
    const polite = [...PAGE.matchAll(/<[a-z]+\b[^>]*aria-live="polite"[^>]*>/g)].map((m) => attr(m[0], 'id') || attr(m[0], 'class'));
    assert.deepEqual(polite.sort(), ['a11y-status', 'set-row-sub notify-note', 'set-try-out', 'settings-state'].sort());
  });

  test('every live change reaches the voice', () => {
    assert.match(fn('onMessage'), /noteUnread\(m\);\s*a11yMessage\(m\);/, 'new messages');
    assert.match(fn('onAudit'), /a11yLog\(ev\);/, 'the live log');
    assert.match(fn('upsertAgent'), /a11yPresence\(S\.agents\.get\(a\.id\), a\);\s*S\.agents\.set/, 'the map: before the change, to compare');
    assert.match(fn('pollPending'), /a11yWaiting\(\(S\.pending \|\| \[\]\)\.length, \(pending \|\| \[\]\)\.length\);\s*S\.pending = pending/, 'Waiting for you');
    assert.match(fn('problem'), /a11ySay\('problem', m\)/, "the message box's problems");
    assert.match(fn('copyText'), /a11ySay\('note', btn\.textContent\)/, 'Copied');
    assert.match(fn('a11yWaiting'), /if \(now > before\)/, 'only when more wait');
    // the map speaks on the Overview, the log too; the thread only for its own conversation
    assert.match(fn('a11yLog'), /S\.mode === 'console' && S\.page === 'overview'/);
    assert.match(fn('a11yPresence'), /if \(S\.page !== 'overview'\) return;/);
    assert.match(fn('a11yMessage'), /if \(!A11Y\.voice \|\| !countsAsNew\(m\)\) return;/, 'never your own');
  });
});

// The voice, run with a made-up clock: what it would say, and when
function voice() {
  let now = 0;
  const timers = [];
  const said = [];
  const env = { now: () => now, setTimeout: (f, ms) => timers.push({ at: now + ms, f }), hidden: () => env.isHidden, isHidden: false };
  const ctx = vm.createContext({});
  vm.runInContext(`${fn('a11yAnnouncer')}; this.make = a11yAnnouncer;`, ctx);
  const v = ctx.make((text) => said.push({ at: now, text }), env);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.f();
    }
    now = end;
  };
  return { v, said, advance, env };
}

describe('the voice sums up instead of flooding', () => {
  test('one message: its words; a burst: one sentence for all of it', () => {
    const { v, said, advance } = voice();
    v.say('message', { who: 'Bob Test', where: 'in #general', line: 'Bob Test’s Oby says: the release notes are out' });
    advance(2000);
    assert.deepEqual(said.map((s) => s.text), ['Bob Test’s Oby says: the release notes are out']);
    for (let i = 0; i < 25; i++) { v.say('message', { who: i % 2 ? 'Bob Test' : 'Sam Test', where: 'in #general', line: `line ${i}` }); advance(30); }
    advance(3000);
    assert.equal(said.length, 2, said.map((s) => s.text).join(' | '));
    assert.equal(said[1].text, '25 new messages in #general, the last from Sam Test.');
  });

  test('a long message is cut short', () => {
    const { v, said, advance } = voice();
    v.say('message', { who: 'Bob', where: 'here', line: 'x '.repeat(400) });
    advance(2000);
    assert.ok(said[0].text.length <= 220 && said[0].text.endsWith('…'), said[0].text.length);
  });

  test('the live log: a summary at most every 15 seconds, however busy', () => {
    const { v, said, advance } = voice();
    for (let s = 0; s < 60 * 10; s++) { v.say('log', { type: 'ask', detail: `alice asks bob (${s})` }); advance(100); } // 10 events a second for a minute
    advance(20000);
    assert.ok(said.length >= 3 && said.length <= 5, `${said.length} sentences in a minute`);
    for (let i = 1; i < said.length; i++) assert.ok(said[i].at - said[i - 1].at >= 15000, 'at least 15 seconds apart');
    assert.match(said[0].text, /^Live log: \d+ new events, the latest ask: alice asks bob \(\d+\)\.$/);
    const total = said.reduce((n, s) => n + Number(/(\d+) new event/.exec(s.text)[1]), 0);
    assert.equal(total, 600, 'every event counted once');
  });

  test('the map: one line per Oby, its latest state, and no more than three', () => {
    const { v, said, advance } = voice();
    v.say('presence', { id: 'a_bob', words: 'Bob’s Oby is answering, on Bob’s machine.' });
    v.say('presence', { id: 'a_bob', words: 'Bob’s Oby finished.' });
    v.say('presence', { id: 'a_sam', words: 'Sam’s Oby went offline.' });
    advance(3000);
    assert.deepEqual(said.map((s) => s.text), ['Bob’s Oby finished. Sam’s Oby went offline.']);
    for (const id of ['a', 'b', 'c', 'd', 'e']) v.say('presence', { id, words: `${id} is online.` });
    advance(20000);
    assert.equal(said[1].text, 'a is online. b is online. And 3 more changes on the map.');
    assert.ok(said[1].at - said[0].at >= 8000);
  });

  test('what waits for you, a problem and a note go out at once; kinds that meet are one write', () => {
    const { v, said, advance } = voice();
    v.say('waiting', 'Something waits for you, in Your Oby.');
    v.say('waiting', '2 things wait for you, in Your Oby.');
    advance(700);
    assert.deepEqual(said.map((s) => s.text), ['2 things wait for you, in Your Oby.']);
    v.say('problem', 'That isn’t this Sphere’s admin key.');
    v.say('note', 'Copied');
    advance(100);
    assert.deepEqual(said.slice(1).map((s) => s.text), ['That isn’t this Sphere’s admin key. Copied']);
  });

  test('nothing while the tab is hidden, and nothing empty', () => {
    const { v, said, advance, env } = voice();
    env.isHidden = true;
    v.say('message', { who: 'Bob', where: 'here', line: 'hello' });
    env.isHidden = false;
    v.say('note', '');
    v.say('nonsense', 'x');
    advance(5000);
    assert.deepEqual(said, []);
  });
});

// ---------------------------------------------------------------- contrast

const SURFACES = (t) => {
  const W = { rgb: [255, 255, 255], a: 1 };
  const solid = (n) => tokenColor(n, t).rgb;
  const bg = solid('--bg'), chip = solid('--chip'), chipHover = solid('--chip-hover'), surface = solid('--surface');
  const on = (n, back) => over(tokenColor(n, t), back);
  return {
    page: bg, card: chip, 'raised card': chipHover, 'dialog or menu': surface,
    'hovered row': on('--hover', bg), 'chosen row': on('--active', bg), 'hovered menu item': on('--hover', surface), field: on('--field', chip),
    _white: W.rgb,
  };
};
const THEMES = themes();

describe('contrast (WCAG 2.2 AA), from the CSS tokens', () => {
  test('the themes are found', () => {
    assert.ok(THEMES.length >= 1);
    assert.equal(THEMES[0].name, 'dark (the default)');
    assert.match(THEMES[0].tokens['color-scheme'], /dark/);
    // the console has one look, dark; Increase contrast (prefers-contrast: more) is checked as a theme too
    assert.ok(THEMES.some((t) => /prefers-contrast: more/.test(t.name)), THEMES.map((t) => t.name).join(', '));
  });

  for (const th of THEMES) {
    test(`text: 4.5:1 for every text token on every surface (${th.name})`, () => {
      const s = SURFACES(th.tokens);
      const low = [];
      for (const fg of ['--ink', '--text', '--item', '--muted', '--label', '--danger', '--needs']) {
        for (const [where, back] of Object.entries(s)) {
          if (where === '_white') continue;
          const r = ratio(over(tokenColor(fg, th.tokens), back), back);
          if (r < 4.5) low.push(`${fg} on the ${where}: ${r.toFixed(2)}:1`);
        }
      }
      assert.deepEqual(low, []);
    });

    test(`controls: field edges and the focus ring at 3:1 (${th.name})`, () => {
      const s = SURFACES(th.tokens);
      const low = [];
      for (const ui of ['--field-edge', '--field-edge-on', '--focus']) {
        for (const [where, back] of Object.entries(s)) {
          if (where === '_white' || where === 'hovered menu item') continue;
          const r = ratio(over(tokenColor(ui, th.tokens), back), back);
          if (r < 3) low.push(`${ui} on the ${where}: ${r.toFixed(2)}:1`);
        }
      }
      // the focus ring next to a white button (New exchange, Open, Send my answer)
      const ring = ratio(over(tokenColor('--focus', th.tokens), s._white), s._white);
      if (ring < 3) low.push(`--focus next to --ink: ${ring.toFixed(2)}:1`);
      assert.deepEqual(low, []);
    });

    test(`every colour the stylesheet gives text meets 4.5:1 (${th.name})`, () => {
      const t = th.tokens;
      const s = SURFACES(t);
      const low = [];
      let seen = 0;
      for (const r of cssRules()) {
        if (/forced-colors/.test(r.media) || !r.decl.color) continue;
        const v = resolve(r.decl.color, t);
        const fg = parseColor(v);
        if (!fg) { assert.match(v, /^(inherit|currentColor|transparent)$/i, `${r.selector}: ${v}`); continue; }
        seen++;
        // on its own background when the rule gives one (a badge, a button), else on the page's surfaces
        const own = r.decl.background || r.decl['background-color'];
        const ownColor = own && parseColor(resolve(own, t));
        const backs = ownColor ? { 'its own background': over(ownColor, s.page) } : { page: s.page, card: s.card, 'dialog or menu': s['dialog or menu'] };
        for (const [where, back] of Object.entries(backs)) {
          const x = ratio(over(fg, back), back);
          if (x < 4.5) low.push(`${r.selector} (${v}) on the ${where}: ${x.toFixed(2)}:1`);
        }
      }
      assert.ok(seen > 100, `found only ${seen} colours`);
      assert.deepEqual(low, []);
    });
  }

  test('badges: the unread count and the waiting count', () => {
    const t = THEMES[0].tokens;
    const rule = (sel) => cssRules().find((r) => r.selector === sel && !r.media);
    const unread = rule('.unread-count');
    assert.equal(unread.decl.background, 'var(--unread-badge)');
    assert.ok(ratio(parseColor(unread.decl.color).rgb, tokenColor('--unread-badge', t).rgb) >= 4.5);
    const needs = rule('.connector .needs');
    assert.ok(ratio(parseColor(needs.decl.color).rgb, tokenColor('--needs', t).rgb) >= 4.5);
  });

  test('the old faint greys are gone', () => {
    const rule = (sel) => cssRules().find((r) => r.selector === sel && !r.media);
    assert.equal(rule('.group-none p').decl.color, 'var(--muted)', 'an empty conversation says so legibly');
    // offline rows and map nodes dim their pictures, not their words
    assert.ok(!cssRules().some((r) => /^\.oby-row\.is-offline$|^\.node\.is-offline$/.test(r.selector) && r.decl.opacity), 'no row-wide opacity');
    assert.equal(rule('.oby-row.is-offline .connector-name').decl.color, 'var(--muted)');
    // fields have an edge you can see
    for (const sel of ['.set-field', '.set-select', '.set-area', '.composer-field']) assert.match(rule(sel).decl.border, /var\(--field-edge\)/, sel);
    // a link inside someone's words is underlined, not told apart by colour alone
    assert.match(rule('.tok-url').decl['text-decoration'], /^underline/);
  });
});

// ---------------------------------------------------------------- visible focus

describe('visible focus', () => {
  const rules = cssRules();
  test('a focus ring everywhere, in the focus colour', () => {
    const ring = rules.find((r) => r.selector === ':focus-visible' && !r.media);
    assert.ok(ring, 'a :focus-visible rule for everything');
    assert.equal(ring.decl.outline, '2px solid var(--focus)');
    // it comes after the rules that set outline: none on fields, so it wins for keyboard focus
    const at = STYLE.indexOf(':focus-visible { outline: 2px solid var(--focus)');
    for (const sel of ['.set-field {', '.set-select {', '.set-area {']) assert.ok(STYLE.indexOf(sel) < at, sel);
  });

  test('nothing takes the ring away without showing focus some other way', () => {
    const bare = rules.filter((r) => /:focus-visible/.test(r.selector) && /^(0|none)$/.test(r.decl.outline || '') && !/forced-colors/.test(r.media));
    assert.deepEqual(bare.map((r) => r.selector), ['.composer-input:focus-visible'], 'only the message box, whose rounded box shows it');
    const box = rules.find((r) => r.selector === '.composer-field:hover, .composer-field:focus-within');
    assert.equal(box.decl['border-color'], 'var(--field-edge-on)');
    // menus show the ring inside their items rather than hiding it
    for (const sel of ['.add-panel button:hover, .add-panel button:focus-visible', '.account-menu button:hover, .account-menu button:focus-visible']) {
      const r = rules.find((x) => x.selector === sel);
      assert.ok(r && !/^(0|none)$/.test(r.decl.outline || ''), sel);
      assert.equal(r.decl['outline-offset'], '-2px');
    }
  });

  test("Windows' contrast themes keep the state of switches and the chosen item", () => {
    const fc = rules.filter((r) => /forced-colors: active/.test(r.media));
    assert.ok(fc.some((r) => /\.switch::after/.test(r.selector) && /CanvasText/.test(r.decl.background)));
    assert.ok(fc.some((r) => /\.connector\.is-active/.test(r.selector) && /Highlight/.test(r.decl.outline)));
  });
});

// ---------------------------------------------------------------- markup the script builds, rendered

// a page function run on its own, with made-up data: anything it calls that isn't given returns ''
function render(names, call, given = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = { esc, ...given };
  const ctx = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : k in globalThis ? globalThis[k] : () => ''),
  }));
  vm.runInContext(`${names.map(fn).join('\n')}\nthis.__out = (${call});`, ctx);
  return base.__out;
}

describe('the markup, rendered', () => {
  test("an exchange's row: its button says when, who and to whom, and shows the time", () => {
    const e = { id: 'm_1', start: 0, root: { kind: 'ask', from: 'a_me', text: 'hi' }, spans: [], hops: 0, durationMs: 5, status: 'answered' };
    const html = render(['exchangeTable', 'a11yExchangeName'], 'exchangeTable([E], true)', {
      E: e, clock: () => '12:01:02', routeWords: () => 'Your Oby → Bob Test’s Oby', STATUS_WORDS: {}, fmtMs: () => '5ms',
    });
    assert.match(html, /<button type="button" class="row-open" aria-label="Open the exchange at 12:01:02: Your Oby asks Bob Test’s Oby">12:01:02<\/button>/);
  });

  test("a member's row says its state in words; an unread count says what it counts", () => {
    // the state is the row's description, so its name stays the person's ("Bob Test", "Bob Test 3 new")
    const a = { id: 'a_bob', name: 'bob', owner: 'Bob Test', online: false, about: 'the mobile app' };
    const html = render(['memberRow'], 'memberRow(A)', {
      A: a, S: { me: { id: 'a_me' }, open: new Set(), unread: {}, current: 'general' }, stateOf: () => 'offline', ownerName: (x) => x.owner, label: (x) => x.owner,
      isMe: () => false, dmWith: () => null, picture: () => '<svg aria-hidden="true"></svg>', unreadHtml: () => '',
    });
    assert.match(html, /data-member="a_bob" aria-describedby="about-a_bob"/);
    assert.match(html, /<span id="about-a_bob" hidden>offline · the mobile app<\/span>/);
    assert.match(html, /<span class="connector-name">Bob Test<\/span>/);
    // a private channel says so the same way
    assert.match(fn('renderChannels'), /aria-describedby="about-ch-\$\{esc\(c\.name\)\}"[\s\S]*<span id="about-ch-\$\{esc\(c\.name\)\}" hidden>Private/);
    // the count reads "3 new" (an aria-label on a plain span would be ignored)
    assert.match(SCRIPT,/const unreadHtml = \(n\) => \(n \? `<span class="unread-count">\$\{n > 99 \? '99\+' : n\}<span class="sr-only"> new<\/span><\/span>` : ''\);/);
  });

  test('the side panel says what its Waiting for you count counts', () => {
    // "Your Oby 2 waiting for you", not "Your Oby 2" (a title on a span isn't read)
    const nav = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    render(['renderNav'], 'renderNav()', {
      S: { page: 'overview', pending: [{ id: 'p_1' }, { id: 'p_2' }], me: { id: 'a_me' }, admin: false, messages: [] },
      NAV: [['you', 'Your Oby', null, 'you']], NAV_GROUPS: [['you', 'You']], CONSOLE: {},
      exchanges: () => [], members: () => [], $: () => nav, a11yDraw: (el, html) => { el.innerHTML = html; return true; },
    });
    assert.match(nav.innerHTML, /<span class="connector-name">Your Oby<\/span><span class="needs" title="2 waiting for you">2<span class="sr-only"> waiting for you<\/span><\/span>/);
  });

  test('Policy: the switches say whether they are on, the choices are named', () => {
    const html = render(['pagePolicy'], 'pagePolicy()', {
      S: { admin: true, adminKey: null, me: null, sphere: { paused: true, policy: { sealed: true, maxDepth: 3, maxFileBytes: 5242880 } } },
      head: (t, s) => `<h1>${t}</h1>${s}`, size: (n) => `${n} B`, CONSOLE: null,
    });
    assert.match(html, /data-pause  role="switch" aria-checked="false" aria-label="Accept new messages"/, 'paused: not accepting');
    assert.match(html, /data-seal  role="switch" aria-checked="true" aria-label="Seal message contents"/);
    assert.match(html, /data-policy="maxDepth"  aria-label="Agents asking agents"/);
    assert.match(html, /data-policy="maxFileBytes"  aria-label="Largest file"/);
  });

  test('the audit log filters say which one is on', () => {
    const html = render(['pageAudit'], 'pageAudit()', {
      S: { audit: [], auditFilter: 'traffic', auditVerified: true, auditHead: { seq: 0, hash: '' } },
      AUDIT_FILTERS: { all: null, traffic: [], denials: [] }, head: (t, s, r) => `<h1>${t}</h1>${s}${r}`,
    });
    assert.match(html, /<div class="filters" role="group" aria-label="Show events">/);
    assert.match(html, /data-filter="traffic" class="is-on" aria-pressed="true">Traffic/);
    assert.match(html, /data-filter="all" class="" aria-pressed="false">All/);
  });
});

// ---------------------------------------------------------------- focus, found again (on a made-up DOM)

// the page's focus code, run with a made-up document: `view` stands for the page you're on
function focusCode(doc, view = 'console|members') {
  const ctx = vm.createContext({
    document: doc, CSS: { escape: cssEscape }, view,
    A11Y: { key: null, from: null, fromKey: null, opened: new Map() },
    reachable: (el) => !!el && el.isConnected,
    a11yLanding: () => doc.querySelector('h1'),
    $: (sel) => doc.querySelector(sel),
    openModal: () => null, FOCUSABLE: 'button', setTimeout: () => {},
  });
  vm.runInContext(`const viewKey = () => view;\n${['a11yKeyOf', 'a11yFind', 'a11yRestore', 'a11yModal'].map(fn).join('\n')}
    this.api = { a11yKeyOf, a11yFind, a11yRestore, a11yModal };`, ctx);
  return ctx;
}
// what has the focus, as the page's focusin handler records it
const focusOn = (ctx, el) => { el.focus(); ctx.A11Y.key = ctx.api.a11yKeyOf(el); ctx.A11Y.from = el; ctx.A11Y.fromKey = ctx.A11Y.key; };
// a redraw: the part is replaced by new markup, and the focus it held is lost
const redraw = (doc, old, fresh) => { const p = old.parentElement; old.remove(); p.append(fresh); doc.activeElement = doc.body; };

describe('focus, found again after a redraw', () => {
  const member = (id, suspended) => h('tr', {}, h('td', {}, h('button', { class: 'set-button sm', 'data-suspend': id, 'data-to': suspended ? 0 : 1 })));
  const membersPage = (bobSuspended) => h('div', { class: 'page', id: 'page' },
    h('h1', { class: 'page-title', tabindex: '-1' }),
    h('button', { class: 'set-button', 'data-invite': '' }),
    h('table', {}, h('tbody', {}, member('a_alice', false), member('a_bob', bobSuspended), member('a_sam', false))));

  test("a Suspend that became Resume: the focus is on the same member's button, never another's", () => {
    const doc = fakeDocument(h('div', { id: 'root' }, h('div', { id: 'console-scroll' }, membersPage(false))));
    const ctx = focusCode(doc);
    focusOn(ctx, doc.querySelector('[data-suspend="a_bob"]'));
    redraw(doc, doc.getElementById('page'), membersPage(true)); // bob is suspended: his button is Resume now
    ctx.api.a11yRestore();
    assert.equal(doc.activeElement.getAttribute('data-suspend'), 'a_bob', 'not the first member in the table');
    assert.equal(doc.activeElement.getAttribute('data-to'), '0');
  });

  test("an ask you decided leaves Waiting for you: the focus goes to the page's title, not to the next ask's buttons", () => {
    const card = (id) => h('div', { class: 'ask-card', 'data-pending': id }, h('div', { class: 'ask-actions' },
      h('button', { class: 'modal-primary', 'data-decide': 'answer' }), h('button', { class: 'set-button', 'data-decide': 'decline' })));
    const doc = fakeDocument(h('div', { id: 'root' }, h('div', { id: 'page' }, h('h1', { class: 'page-title', tabindex: '-1' }), h('div', { id: 'pending-box' }, card('p_1'), card('p_2')))));
    const ctx = focusCode(doc, 'console|you');
    focusOn(ctx, doc.querySelector('[data-pending="p_1"] [data-decide="answer"]'));
    doc.querySelector('[data-pending="p_1"]').remove(); // Let my Oby answer: the card goes
    doc.activeElement = doc.body;
    ctx.api.a11yRestore();
    assert.equal(doc.activeElement.tagName, 'H1', 'one more Enter must not answer the next ask');
    assert.equal(doc.querySelector('[data-pending="p_2"] [data-decide="answer"]').focused, 0);
  });

  test('a dialog gives the focus back to what opened it, even when that was redrawn meanwhile', () => {
    const modal = h('div', { class: 'modal-backdrop', id: 'invite-modal' }, h('div', { role: 'dialog' }, h('button', { 'data-close': '' })));
    const doc = fakeDocument(h('div', { id: 'root' }, h('div', { class: 'window' }, h('div', { id: 'console-scroll' }, membersPage(false))), modal));
    const ctx = focusCode(doc);
    focusOn(ctx, doc.querySelector('[data-invite]'));
    modal.hidden = false;
    ctx.api.a11yModal(modal);
    assert.equal(doc.querySelector('.window').inert, true);
    doc.querySelector('[data-close]').focus();
    redraw(doc, doc.getElementById('page'), membersPage(false)); // Members redraws every 3 seconds
    doc.querySelector('[data-close]').focus();
    modal.hidden = true;
    ctx.api.a11yModal(modal);
    assert.equal(doc.querySelector('.window').inert, false);
    assert.equal(doc.activeElement, doc.querySelector('[data-invite]'), 'Invite member, as drawn now');
    // the page's focusin handler keeps the key of what opened a dialog, beside the element
    assert.match(fn('a11ySetup'), /A11Y\.key = a11yKeyOf\(e\.target\);\s*if \(!e\.target\.closest\?\.\('\.modal-backdrop'\)\) \{ A11Y\.from = e\.target; A11Y\.fromKey = A11Y\.key; \}/);
  });

  test('a part drawn again with the same markup is left as it is; anything else drawing there is noticed', () => {
    const ctx = vm.createContext({ A11Y: { drawn: new WeakMap() } });
    vm.runInContext(`${fn('a11yDraw')}; this.draw = a11yDraw;`, ctx);
    let made = 0;
    const el = { firstChild: null, set innerHTML(html) { this.html = html; this.firstChild = html ? { made: ++made } : null; } };
    assert.equal(ctx.draw(el, '<button data-suspend="a_bob">Suspend</button>'), true);
    const button = el.firstChild;
    assert.equal(ctx.draw(el, '<button data-suspend="a_bob">Suspend</button>'), false, 'the same markup: the same button, with the focus in it');
    assert.equal(el.firstChild, button);
    assert.equal(ctx.draw(el, '<button data-suspend="a_bob">Resume</button>'), true);
    el.innerHTML = '<p>Loading…</p>'; // another part of the page drew here
    assert.equal(ctx.draw(el, '<button data-suspend="a_bob">Resume</button>'), true, 'drawn again over what was put there meanwhile');
    assert.equal(el.html, '<button data-suspend="a_bob">Resume</button>');

    // where the console redraws as the Sphere moves (Members every 3 seconds, the rest with each message)
    assert.match(fn('renderNav'), /if \(!a11yDraw\(\$\('#nav'\), /);
    const page = fn('renderPage');
    assert.match(page, /const draw = \(html\) => \(drawn = a11yDraw\(el, html\)\);/);
    for (const p of ['pageExchange', 'pageTraffic', 'pageMembers', 'pageInstruments', 'pageFiles', 'pageAudit', 'pagePolicy', 'pageAdmins', 'pageYou']) assert.match(page, new RegExp(`draw\\(${p}\\(`), p);
    assert.ok(!/el\.innerHTML =/.test(page), 'every page goes through it');
    // a page left as it is isn't wired again (Policy's switches would toggle twice)
    assert.match(page, /if \(!drawn\) return;\s*if \(!fresh\) \$\('#console-scroll'\)\.scrollTop = keep;\s*wirePage\(\);/);
    assert.match(page, /if \(a11yDraw\(\$\('#you-rest'\), youRest\(\)\)\) wirePage\(\);/);
    assert.match(fn('renderOverview'), /a11yDraw\(\$\('#ov-head'\), head\(/);
    assert.match(fn('renderOverview'), /a11yDraw\(\$\('#ov-recent'\), exchangeTable\(ex, true\)\);/);
    assert.match(fn('renderChannels'), /if \(!a11yDraw\(\$\('#channels'\),[\s\S]*\)\) return;/);
    assert.match(fn('renderMembers'), /a11yDraw\(\$\('#members'\), [\s\S]*a11yDraw\(\$\('#bots'\), /);
  });

  test('a dialog that took you to another page puts the focus on its title', () => {
    const modal = h('div', { class: 'modal-backdrop', id: 'channel-modal' }, h('div', { role: 'dialog' }, h('button', { 'data-close': '' })));
    const doc = fakeDocument(h('div', { id: 'root' }, h('div', { class: 'window' }, h('div', { id: 'console-scroll' }, membersPage(false))), modal));
    const ctx = focusCode(doc);
    focusOn(ctx, doc.querySelector('[data-invite]'));
    modal.hidden = false;
    ctx.api.a11yModal(modal);
    doc.querySelector('[data-close]').focus();
    ctx.view = 'conversation|new-one';
    modal.hidden = true;
    ctx.api.a11yModal(modal);
    assert.equal(doc.activeElement.tagName, 'H1');
  });
});
