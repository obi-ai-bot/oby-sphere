// The Settings page's review fixes (0.3.x usability pass): a time pasted into the hour keeps
// its minutes, a time left half empty shows the one it still has, quiet hours' error speaks
// the page's words, no internal word on the page, buttons that can't be used look it, an (i)
// opens on a tap, and gh's repository lists stop at their time limit. The page's functions run
// in a sandbox with stand-ins for its fields: no browser, no network. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const CSS = /<style>([\s\S]*?)<\/style>/.exec(PAGE)[1];
const REP = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');

// a declaration out of the page's script, by its braces
const fnSource = (name) => {
  const start = SCRIPT.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is in the page`);
  let depth = 0;
  for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') depth++;
    else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
};
const constLine = (name) => {
  const m = new RegExp(`\\n  const ${name} = [^\\n]*`).exec(SCRIPT);
  assert.ok(m, `${name} is in the page`);
  return m[0];
};
const settingsPart = () => {
  const a = SCRIPT.indexOf("// ---------------------------------------------------------------- your Oby's settings");
  const b = SCRIPT.indexOf('// an item in Waiting for you');
  assert.ok(a > 0 && b > a);
  return SCRIPT.slice(a, b);
};

// the time picker's two fields, and the control around them
function timePicker(value) {
  const field = (cls, v) => ({
    value: v,
    attrs: {},
    classList: { contains: (c) => c === cls },
    setAttribute(k, x) { this.attrs[k] = x; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { ctx.focused = cls; },
    select() {},
  });
  const [hh, mm] = value ? value.split(':') : ['', ''];
  const h = field('ctl-time-h', hh);
  const m = field('ctl-time-m', mm);
  const root = { id: 'quiet-from', querySelector: (sel) => (sel === '.ctl-time-h' ? h : sel === '.ctl-time-m' ? m : null) };
  const ctx = { emitted: [], focused: null, h, m, root };
  vm.createContext(ctx);
  vm.runInContext(
    `const CTL = { data: new Map([['quiet-from', { value: ${JSON.stringify(value)} }]]) };
     const ctlEmit = (el, v) => emitted.push(v);
     ${constLine('ctlPad')}
     ${fnSource('ctlTimeCommit')}
     ${fnSource('ctlTimeInput')}
     this.input = (el) => ctlTimeInput(el, root);
     this.leave = () => ctlTimeCommit(root, true);
     this.stored = () => CTL.data.get('quiet-from').value;`,
    ctx,
  );
  return ctx;
}

describe('Settings, review fixes', () => {
  test('the time picker: "23:30" pasted into the hour is 23:30, not 23:00', () => {
    const t = timePicker('22:00');
    t.h.value = '23:30';
    t.input(t.h);
    assert.deepEqual([t.h.value, t.m.value, t.stored(), t.emitted], ['23', '30', '23:30', ['23:30']]);
    assert.equal(t.focused, 'ctl-time-m', 'the minutes are next');
    // digits alone, as fast typing sends them, the same
    const u = timePicker('22:00');
    u.h.value = '0745';
    u.input(u.h);
    assert.deepEqual([u.h.value, u.m.value, u.stored()], ['07', '45', '07:45']);
    // one digit that can only start an hour as 0x, as before
    const w = timePicker('22:00');
    w.h.value = '7';
    w.input(w.h);
    assert.deepEqual([w.h.value, w.stored()], ['07', '07:00']);
  });

  test('the time picker: left with one half empty, it shows the time it still has', () => {
    const t = timePicker('22:15');
    t.h.value = '';
    t.input(t.h);
    assert.equal(t.stored(), '22:15', 'half a time changes nothing');
    assert.deepEqual(t.emitted, []);
    t.leave();
    assert.deepEqual([t.h.value, t.m.value, t.h.attrs['aria-valuenow'], t.m.attrs['aria-valuenow']], ['22', '15', '22', '15']);
    // with no time yet, both halves are emptied again
    const u = timePicker(null);
    u.m.value = '30';
    u.input(u.m);
    u.leave();
    assert.deepEqual([u.h.value, u.m.value, u.stored()], ['', '', null]);
  });

  test("quiet hours' error says the start, not the file's from", () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`${constLine('curly')}\n${constLine('dotted')}\n${fnSource('errorWords')}\nthis.errorWords = errorWords;`, ctx);
    assert.equal(ctx.errorWords({ field: 'notify.quiet.to', message: "notify.quiet.to: can't be the same time as from" }), 'can’t be the same time as the start');
  });

  test('no internal words on the Settings page', () => {
    // the words people read: the strings, without the code's own CSS selectors
    const words = settingsPart().replace(/:scope\b/g, '');
    for (const banned of [/\bscope\b/i, /\bpayload\b/i, /\bas data\b/i, /\bdeclared\b/i, /\brepresentative\b/i, /\bin a session\b/i]) assert.doesNotMatch(words, banned);
    assert.match(words, /The ones in your own Claude Code\./, 'what the MCP servers list is, in plain words');
  });

  test("a button that can't be used looks it, and an (i) opens on a tap", () => {
    assert.match(CSS, /\.set-root \.set-button:disabled \{ opacity: 0\.4;/);
    assert.match(CSS, /\.set-root \.icon-button:disabled \{ opacity: 0\.3;/);
    // a phone has no hover, and a tap focuses without :focus-visible
    assert.match(CSS, /\.ctl-info:hover::after, \.ctl-info:focus::after \{ display: block; \}/);
  });

  test("gh's repository lists stop at the time limit: no new gh starts after it", () => {
    const start = REP.indexOf('async function listGhRepos(');
    const src = REP.slice(start, REP.indexOf('\n}\n', start));
    assert.match(src, /const deadline = Date\.now\(\) \+ 20e3;/);
    assert.match(src, /lists\[i\] = Date\.now\(\) < deadline \? json\(await ghRun\(\['repo', 'list', owners\[i\]/, 'each list starts only before the deadline');
    assert.match(src, /if \(!Array\.isArray\(list\)\) \{\n\s+partial = true;/, 'an owner left out is said: partial');
  });
});
