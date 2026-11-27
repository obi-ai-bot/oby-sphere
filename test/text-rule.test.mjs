// The rule for invisible characters, the same in the relay (server.mjs, clean) and in every
// representative (rep.mjs, printable): what could hide words from a person while a model still
// reads them goes; what writing needs stays. Characters are written as code points, so this file
// holds none of them itself. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruleOf = (file, start, end, fn) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${fn} is in ${file}`);
  return { src: src.slice(a, b), fn: new Function(`${src.slice(a, b)}; return ${fn};`)() };
};
const relay = ruleOf('server.mjs', 'const NON_JOINING', '// one line: names', 'clean');
const rep = ruleOf('rep.mjs', 'const NON_JOINING', 'function cleanLine(s, max)', 'printable');
const u = (...xs) => String.fromCodePoint(...xs);
const cps = (s) => [...s].map((c) => c.codePointAt(0).toString(16).toUpperCase()).join(' ');

const KEPT = [
  ['a joiner inside an emoji, and the emoji selector after one', u(0x1f469, 0x200d, 0x1f4bb, 0x20, 0x2764, 0xfe0f, 0x20, 0x31, 0xfe0f, 0x20e3)],
  ["England's flag", u(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)],
  ['a non-joiner in Persian', u(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645)],
  ["a joiner in Sinhala's \"Sri\"", u(0xdc1, 0xdca, 0x200d, 0xdbb, 0xdd3)],
  ['a Devanagari half form', u(0x915, 0x94d, 0x200d, 0x937)],
  ['an old-style Malayalam chillu, before a space', u(0xd28, 0xd4d, 0x200d, 0x20, 0x61)],
  ['an Arabic number sign (visible)', u(0x600, 0x661, 0x662)],
  ['a Mongolian variation selector after a Mongolian letter', u(0x1820, 0x180b)],
  ['tab and newline', u(0x61, 9, 0x62, 10, 0x63)],
];
const CHANGED = [
  ['zero-width, bidi, soft hyphen, BOM, fillers, the grapheme joiner', u(0x61, 0x200b, 0x62, 0x202e, 0x63, 0x2066, 0x64, 0xad, 0x65, 0xfeff, 0x66, 0x3164, 0x67, 0x115f, 0x68, 0x34f, 0x69), 'abcdefghi'],
  ['tag characters that spell words', 'Status' + u(0xe0020, 0xe0072, 0xe0075, 0xe006e), 'Status'],
  ['default-ignorables, assigned or not', 'Looks fine.' + u(0xe0200, 0xe0241, 0x17b4, 0x2065, 0xfff0, 0xe0080, 0xe01f0, 0xe0100, 0xfe00, 0xfff9), 'Looks fine.'],
  ['a joiner or non-joiner between Latin letters', u(0x61, 0x200d, 0x62, 0x200c, 0x63), 'abc'],
  ['an emoji joiner before a letter', u(0x1f469, 0x200d, 0x61), u(0x1f469, 0x61)],
  ['a selector after a letter, a second one after an emoji', u(0x67, 0xfe0f, 0x1f600, 0xfe0f, 0xfe0f, 0xfe0e), u(0x67, 0x1f600, 0xfe0f)],
  ["another flag's tags", u(0x1f3f4, 0xe0068, 0xe0069, 0xe007f), u(0x1f3f4)],
  ['a Mongolian selector after a Latin letter', u(0x61, 0x180b), 'a'],
  ['controls, C1 included', u(0x61, 1, 0x62, 0x85, 0x63, 0x7f, 0x64), 'abcd'],
  ['line and paragraph separators become newlines', u(0x61, 0x2028, 0x62, 0x2029, 0x63), 'a\nb\nc'],
];

for (const [side, f] of [['relay', relay.fn], ['rep', rep.fn]]) {
  test(`${side}: what writing needs stays`, () => {
    for (const [what, s] of KEPT) assert.equal(cps(f(s)), cps(s), what);
  });
  test(`${side}: what could hide words goes`, () => {
    for (const [what, s, want] of CHANGED) assert.equal(cps(f(s)), cps(want), what);
  });
  test(`${side}: a megabyte of hostile text takes well under a second`, () => {
    const t = Date.now();
    f(('a' + u(0x200d)).repeat(150000) + (u(0xdc1, 0xdca, 0x200d)).repeat(100000) + (u(0x1f469, 0xfe0f)).repeat(50000));
    assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
  });
}

test('the relay and every representative keep the same rule', () => {
  const body = (s) => s.replace(/function (clean|printable)Part/g, 'function part').replace(/function (clean|printable)\(\w+\)[\s\S]*$/, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');
  assert.equal(body(rep.src), body(relay.src));
  const raw = [...relay.src + rep.src].filter((c) => { const n = c.codePointAt(0); return n < 32 ? n !== 10 : n > 126 && n !== 0x2019; });
  assert.deepEqual(raw.filter((c) => !/[❤️⃣1]/u.test(c) && !/\p{Extended_Pictographic}/u.test(c)), [], 'the rule is written with escapes, never raw invisible characters');
});
