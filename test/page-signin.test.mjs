// Your console signs in only with its link, and keys never stay in the address bar (sec/console).
// The console's link carries its secret in the fragment (#auth=…): the page trades it once for the
// console's cookie, takes it out of the address and loads again; without it, the page says how to
// open it. The Sphere's own page keeps the join key from an invite link in this browser, out of the
// address, ignores an #admin= link, and never stores the admin key. The whole page runs in a
// sandbox with a stand-in browser. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SCRIPT, fnSource } from './accessibility-helpers.mjs';

// the whole page, in a stand-in browser: what it fetched, what it put in the address bar and in
// storage, and what it drew in #root
function runPage({ hash = '', data, fetch: answer = () => new Promise(() => {}) } = {}) {
  const calls = [];
  const replaced = [];
  const local = new Map();
  const session = new Map([['obysphere.admin', 'admin-key-from-before']]);
  let reloads = 0;
  const root = { innerHTML: '' };
  const any = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : any), apply: () => any, construct: () => any, set: () => true });
  const location = { hash, pathname: '/', search: '', origin: 'http://bob.localhost:5000', reload: () => { reloads++; } };
  const storage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  const ctx = {
    console: { error() {}, log() {}, warn() {} },
    location,
    history: { replaceState: (s, t, u) => { replaced.push(u); location.hash = u.includes('#') ? u.slice(u.indexOf('#')) : ''; } },
    localStorage: storage(local),
    sessionStorage: storage(session),
    document: new Proxy({}, { get: (t, k) => (k === 'querySelector' ? (sel) => (sel === '#root' ? root : any) : any) }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, queueMicrotask() {}, requestAnimationFrame: () => 0, addEventListener() {},
    URLSearchParams, URL, TextDecoder, AbortController,
    CSS: { escape: (s) => String(s) }, MutationObserver: function () { return any; }, navigator: any, matchMedia: () => any, getComputedStyle: () => any, Notification: any,
  };
  ctx.window = ctx;
  ctx.OBYSPHERE_CONSOLE = data;
  ctx.fetch = (url, opts = {}) => { calls.push({ url: String(url), opts }); return answer(String(url), opts); };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return { calls, replaced, local, session, root, reloads: () => reloads };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('your console signs in with its link only', () => {
  test('a link’s #auth=… is traded once for the cookie, taken out of the address, and the page loads again', async () => {
    const ok = { ok: true, status: 204, headers: { get: () => null } };
    const p = runPage({ hash: '#auth=SECRET-FROM-THE-LINK&page=you', data: { signin: true }, fetch: () => Promise.resolve(ok) });
    assert.deepEqual(p.replaced, ['/#page=you'], 'the secret leaves the address bar at once');
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, '/local/auth');
    assert.equal(p.calls[0].opts.method, 'POST');
    assert.equal(p.calls[0].opts.headers['x-obysphere-auth'], 'SECRET-FROM-THE-LINK');
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(p.reloads(), 1, 'then the page loads again, signed in');
    assert.ok(![...p.local.values(), ...p.session.values()].some((v) => v.includes('SECRET')), 'never kept in storage');
  });

  test('a link from before the console last started: it says so', async () => {
    const no = { ok: false, status: 401, headers: { get: () => 'Obysphere-Console' } };
    const p = runPage({ hash: '#auth=OLD', data: { signin: true }, fetch: () => Promise.resolve(no) });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(p.reloads(), 0, 'no loop');
    assert.match(p.root.innerHTML, /from before your console last started/);
  });

  test('without its link: how to open it, and nothing asked of the API', () => {
    const p = runPage({ data: { signin: true } });
    assert.match(p.root.innerHTML, /Open your console/);
    assert.match(p.root.innerHTML, /obysphere open/);
    assert.deepEqual(p.calls, []);
  });

  test('already signed in: a stale #auth= leaves the address, and is never sent', () => {
    const p = runPage({ hash: '#auth=OLD&mode=conversation&c=general', data: { name: 'bob', owner: 'Bob Test', sphere: 'http://127.0.0.1:9', sphereName: 'S' } });
    assert.deepEqual(p.replaced, ['/#mode=conversation&c=general']);
    assert.ok(p.calls.length > 0 && p.calls.every((c) => c.url !== '/local/auth' && !JSON.stringify(c.opts).includes('OLD')));
    assert.ok(p.calls.every((c) => c.opts.headers?.['x-obysphere-console'] === '1'), 'the page’s header, with the cookie');
  });
});

describe('the Sphere’s own page: keys leave the address bar, and an #admin= link is ignored', () => {
  test('the join key is kept in this browser and taken out of the URL; the admin key from a link is never used or stored', () => {
    const p = runPage({ hash: '#key=join-key-from-link&admin=admin-key-from-link&mode=console&page=audit' });
    assert.deepEqual(p.replaced, ['/#mode=console&page=audit'], 'neither key stays in the address');
    assert.equal(p.local.get('obysphere.key'), 'join-key-from-link', 'the join key: kept, for the next visit');
    assert.ok(!p.session.has('obysphere.admin'), 'an admin key from before is forgotten');
    assert.ok(![...p.local.values(), ...p.session.values()].includes('admin-key-from-link'), 'one from a link is never stored');
    assert.ok(p.calls.length > 0, 'the page loads');
    for (const c of p.calls) {
      assert.equal(c.opts.headers?.['x-sphere-key'], 'join-key-from-link');
      assert.equal(c.opts.headers?.['x-admin-key'], undefined, `${c.url}: no admin key from a link`);
    }
  });

  test('syncHash never puts the key back', () => {
    assert.ok(!/p\.set\('key'/.test(fnSource('syncHash')), fnSource('syncHash'));
  });
});
