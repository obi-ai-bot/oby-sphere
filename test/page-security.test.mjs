// The console page's own defences (sec/console): what a relay sends as a message-update, a file id
// or a message's words never becomes markup or script; a link says where it goes; the Markdown
// rules never read their own output and stay fast on any input; and members who share an owner's
// name are told apart. The page's own functions run in a sandbox. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SCRIPT, PAGE, fnSource, constSource } from './accessibility-helpers.mjs';

// the page's functions and constants, as written (a one-line constant by its line: a regex in it
// may hold quotes)
const pick = (n) => {
  if (new RegExp(`\\n\\s*(?:async )?function ${n}\\(`).test(SCRIPT)) return fnSource(n);
  const line = new RegExp(`\\n  const ${n} = [^\\n]*`).exec(SCRIPT)?.[0].trim();
  return line?.endsWith(';') ? line : constSource(n);
};
function sandbox(names, ctx = {}) {
  const src = names.map(pick).join('\n');
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.f = { ${names.join(', ')} };`, ctx);
  return ctx.f;
}

describe("what the relay sends never becomes the page's markup", () => {
  const RIDS = () => sandbox(['RID']).RID;
  test('a message-update changes timing and waiting only, each checked', () => {
    const msg = { id: 'm_one', from: 'a_alice', channel: 'general', text: 'the words alice wrote', files: [{ id: 'f_ok', name: 'notes.txt' }] };
    let redraws = 0;
    const { onUpdate } = sandbox(['RID', 'isWhen', 'onUpdate'], { S: { byId: new Map([['m_one', msg]]) }, dirty: () => redraws++ });
    const at = '2026-11-26T10:00:00.000Z';
    onUpdate(JSON.parse(JSON.stringify({ id: 'm_one', text: 'words the relay swapped in', from: 'a_mallory', files: [{ id: 'x"><img src=x onerror=alert(1)>' }], claimedAt: at, waiting: { for: 'owner', until: at, by: 'a_bob', note: '<b>x</b>' } })));
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), { id: 'm_one', from: 'a_alice', channel: 'general', text: 'the words alice wrote', files: [{ id: 'f_ok', name: 'notes.txt' }], claimedAt: at, waiting: { for: 'owner', until: at, by: 'a_bob' } });
    onUpdate({ id: 'm_one', waiting: null, startedAt: 'not a time', claimedAt: { toString: () => at } });
    assert.equal(msg.waiting, null);
    assert.equal(msg.claimedAt, at, 'not an object');
    assert.ok(!('startedAt' in msg));
    onUpdate(JSON.parse('{"id":"m_one","__proto__":{"text":"from the prototype"},"constructor":{"x":1}}'));
    assert.equal(Object.getPrototypeOf(msg), Object.prototype);
    assert.equal(msg.text, 'the words alice wrote');
    onUpdate({ id: '"><img src=x>', claimedAt: at });
    assert.ok(redraws >= 2);
    assert.ok(RIDS().m.test('m_one'));
    assert.match(SCRIPT, /'message-update': \(u\) => onUpdate\(u\)/, 'the live event goes through it');
  });

  test("a file's id is escaped in its link, and a peek checks it before it's a selector or markup", () => {
    const { fileHtml } = sandbox(['esc', 'fileUrl', 'fileIcon', 'size', 'fileHtml']);
    const html = fileHtml({ id: 'x"><img src=x onerror=alert(1)>', name: 'a.txt', mime: 'text/plain', size: 10 });
    assert.ok(!html.includes('<img'), html);
    assert.ok(!/href="[^"]*"[^ >]/.test(html), html);
    // nowhere does the page put an element's data-… value back into markup or a selector unescaped
    assert.ok(!/="\$\{[\w.?]*dataset\.\w+\}"/.test(SCRIPT), 'a data- value in markup');
    assert.ok(!/\[data-[\w-]+="\$\{(?!CSS\.escape\()[^}]*dataset/.test(SCRIPT), 'a data- value in a selector');
    assert.ok(!/href="\$\{fileUrl\(/.test(SCRIPT), 'fileUrl in an href, unescaped');
  });

  test('no inline script in the page: no on… attributes or javascript: links, one <script> (with the nonce the server adds)', () => {
    assert.equal((PAGE.match(/<script\b/g) || []).length, 1);
    assert.match(PAGE, /<script>\n/, 'plain, for the server to add its nonce');
    assert.ok(!/<[a-z][^<>]*\son[a-z]+\s*=/i.test(PAGE.replace(/<script>[\s\S]*<\/script>/, '')), 'an on… attribute in the markup');
    assert.ok(!/<[a-z][^<>`]*\son[a-z]+\s*=\s*["'\\]/i.test(SCRIPT), 'an on… attribute in markup the script builds');
    assert.ok(!/javascript:/i.test(PAGE));
  });
});

describe('their words, in a little Markdown', () => {
  const agents = new Map([['a_1', { id: 'a_1', name: 'alice' }]]);
  const { md, cleanText, tidy, mdLines, esc } = sandbox(['esc', 'cleanText', 'tidy', 'MD_LINE', 'MD_INLINE', 'LOCAL_HOST', 'md', 'mdLines', 'mdInline', 'mdLink'], { S: { agents }, URL });
  const links = (html) => [...html.matchAll(/<a class="tok-url" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], text: m[2] }));
  const balanced = (html) => {
    // every tag opens and closes in order, and no attribute holds markup
    assert.ok(!/="[^"]*[<>]/.test(html), `markup in an attribute: ${html}`);
    const stack = [];
    for (const [, close, name] of html.matchAll(/<(\/?)([a-z0-9]+)\b[^>]*>/g)) {
      if (!close) stack.push(name);
      else assert.equal(stack.pop(), name, html);
    }
    assert.deepEqual(stack, [], html);
  };

  test('a link whose words say another address shows where it really goes', () => {
    let h = md('[https://github.com/obi-ai-bot/oby-sphere](https://evil.example/login)');
    assert.deepEqual(links(h), [{ href: 'https://evil.example/login', text: 'https://github.com/obi-ai-bot/oby-sphere' }]);
    assert.match(h, /<span class="tok-host">\(evil\.example\)<\/span>/);
    h = md('[the docs](https://docs.example.com/a)');
    assert.match(h, /\(docs\.example\.com\)/);
    h = md('[x](https://github.com@evil.example/)');
    assert.match(h, /\(evil\.example\)/, 'the host, not the user name before @');
    // the address itself, or one on the same host: nothing to add
    for (const s of ['https://github.com/x', '[https://github.com/a](https://github.com/b)', '[github.com](https://github.com/b)']) assert.ok(!md(s).includes('tok-host'), s);
    // an address on this machine isn't a link (your console's sign-in would go to any program there)
    for (const s of ['[open](http://bob.localhost:9999/)', 'see http://localhost:3000/x', '[x](http://127.0.0.1:4851/)', '[x](http://[::1]:80/)']) {
      const out = md(s);
      assert.deepEqual(links(out), [], out);
      assert.ok(!out.includes('href='), out);
    }
  });

  test('the rules never read their own output', () => {
    for (const s of [
      '[click](https://a.example/(https://b.example/x)',
      '[a](https://a.example/) https://b.example/ `[c](https://c.example/)` **[d](https://d.example/)**',
      '*[e](https://e.example/ "x")* and @alice and https://f.example/@alice',
      '[`x`](https://g.example/) [**y**](https://h.example/)',
      'see https://x.example/\u00000\u0000 and\n```\n<b>code</b>\n```',
      '\u00000\u0000 [a](https://x.example/\u00000\u0000)\n```\none\n```',
    ]) {
      const out = md(s);
      balanced(out);
      for (const l of links(out)) assert.ok(!/[<>"]/.test(l.href), l.href);
    }
    const nul = md('see https://x.example/\u00000\u0000 and\n```\n<b>code</b>\n```');
    assert.match(nul, /<pre class="ss-code">&lt;b&gt;code&lt;\/b&gt;<\/pre>/);
    assert.ok(!/href="[^"]*pre/.test(nul), nul);
  });

  test('markup they write is shown, never run; and the usual Markdown still works', () => {
    assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    assert.equal(md('**bold**, *it*, `<code>` and @alice, but not @nobody'), '<p><strong>bold</strong>, <i>it</i>, <code class="tok-code">&lt;code&gt;</code> and <span class="tok-mention">@alice</span>, but not @nobody</p>');
    assert.equal(md('# Head\n> quoted\n- a\n- b\n1. one'), '<h4>Head</h4><blockquote>quoted</blockquote><ul><li>a</li><li>b</li></ul><ol><li>one</li></ol>');
    assert.equal(md('```js\nlet x = "<y>";\n```'), '<pre class="ss-code">let x = &quot;&lt;y&gt;&quot;;</pre>');
  });

  test('sealed words lose control and direction-override characters, as the relay cleans plain ones', () => {
    assert.equal(md('pay\u202Egnp.exe\u0007 now\u2066'), '<p>paygnp.exe now</p>');
    assert.equal(cleanText('a\tb\nc\u200F\u061C\u0000'), 'a\tb\nc');
    assert.equal(tidy({ text: 'x\u202Ey' }).text, 'xy');
    assert.match(SCRIPT, /ms\.messages\.filter\(okMessage\)\.map\(tidy\)/, 'messages are cleaned as the page takes them');
  });

  test('a code fence that never closes, in a sealed message up to the relay’s 160 KB: fast, and fences read as before (R32)', () => {
    for (const s of ['```' + 'a'.repeat(160000), '```' + '-'.repeat(80000) + '\n' + 'b'.repeat(80000), ('```x\n' + 'y'.repeat(40) + '\n').repeat(4000), '````' + 'a'.repeat(160000), 'x```'.repeat(40000)]) {
      const t0 = performance.now();
      md(s);
      const ms = performance.now() - t0;
      assert.ok(ms < 600, `${JSON.stringify(s.slice(0, 12))}… (${s.length}) took ${ms.toFixed(0)} ms`); // the quadratic one took 2.2 s; CI's runners are slower than a laptop
    }
    // what a fence is hasn't changed
    assert.equal(md('```js\nlet x;\n```'), '<pre class="ss-code">let x;</pre>');
    assert.equal(md('a ```b``` c'), '<p>a </p><pre class="ss-code"></pre><p> c</p>', 'b: its info string');
    assert.equal(md('```\none\n```\nmid\n```two```'), '<pre class="ss-code">one</pre><p>mid</p><pre class="ss-code"></pre>');
    assert.equal(md('````x\n```'), '<pre class="ss-code">`x</pre>');
    assert.equal(md('```never closed'), '<p>```never closed</p>');
    assert.equal(md('```a-b_c\nz```'), '<pre class="ss-code">z</pre>');
    assert.equal(md('```a b\n```'), '<pre class="ss-code"> b</pre>');
    // and on any short input, the same as the regex it replaces
    const before = (src) => {
      const t = cleanText(src);
      const out = [];
      let at = 0;
      for (const m of t.matchAll(/```[\w-]*\n?([\s\S]*?)```/g)) {
        mdLines(t.slice(at, m.index), new Set(['alice']), out);
        out.push(`<pre class="ss-code">${esc(m[1].replace(/\n$/, ''))}</pre>`);
        at = m.index + m[0].length;
      }
      mdLines(t.slice(at), new Set(['alice']), out);
      return out.join('');
    };
    let seed = 7;
    const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let i = 0; i < 4000; i++) {
      const s = Array.from({ length: rand(24) }, () => '``` a-_\nb'[rand(10)]).join('');
      assert.equal(md(s), before(s), JSON.stringify(s));
    }
  });

  test('any input renders fast (no quadratic rules)', () => {
    const inputs = ['['.repeat(20000), ('['.repeat(3999) + '\n').repeat(5), '`'.repeat(20000), ('*a ').repeat(7000), ' *' + 'a'.repeat(20000), ('[x](' + 'h'.repeat(3000) + '\n').repeat(5), 'http://'.repeat(3000)];
    for (const s of inputs) {
      const t0 = performance.now();
      md(s);
      const ms = performance.now() - t0;
      assert.ok(ms < 150, `${JSON.stringify(s.slice(0, 12))}… took ${ms.toFixed(0)} ms`);
    }
  });
});

describe('members who share an owner’s name', () => {
  test("their Obys are told apart by handle; anyone else's name stays as it was", () => {
    const S = { me: { id: 'a_me' }, agents: new Map() };
    for (const a of [{ id: 'a_me', name: 'bob', owner: 'Bob Test' }, { id: 'a_m', name: 'mallory', owner: 'Bob Test' }, { id: 'a_a', name: 'alice', owner: 'Alice Test' }, { id: 'a_gone', name: 'old', owner: 'Alice Test', removed: true }]) S.agents.set(a.id, a);
    const f = sandbox(['ownerName', 'isMe', 'members', 'sharedOwner', 'ownerOf', 'obyOf', 'obyLower', 'machineOf'], { S });
    assert.equal(f.obyOf(S.agents.get('a_m')), 'Bob Test (@mallory)’s Oby', 'someone who joined with your name');
    assert.equal(f.obyOf(S.agents.get('a_me')), 'Your Oby');
    assert.equal(f.obyOf(S.agents.get('a_a')), 'Alice Test’s Oby', 'a removed member doesn’t count');
    assert.equal(f.machineOf(S.agents.get('a_m')), 'Bob Test (@mallory)’s machine');
  });
});
