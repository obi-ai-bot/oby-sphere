// Your console signs in only with a link that works once, and keys never stay in the address bar
// (sec/console, sec2/console). The link carries a code in its fragment (#code=…): the page takes
// it out of the address, trades it once for the console's secret (POST /console-signin), keeps
// that in this tab's sessionStorage (its own origin, port included: never a cookie, which reaches
// every port of a host) and sends it in x-obysphere-auth on every call, the live stream and
// downloads included. A reload in the same tab stays signed in; a new tab needs a new link. The
// Sphere's own page keeps the join key from an invite link in this browser, out of the address,
// ignores an #admin= link, and never stores the admin key. The whole page runs in a sandbox with a
// stand-in browser. `npm test`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SCRIPT, fnSource } from './accessibility-helpers.mjs';

// the whole page, in a stand-in browser: what it fetched, what it put in the address bar and in
// storage, and what it drew in #root
function runPage({ hash = '', data, fetch: answer = () => new Promise(() => {}), session: kept = [] } = {}) {
  const calls = [];
  const errors = [];
  const replaced = [];
  const local = new Map();
  const session = new Map([['obysphere.admin', 'admin-key-from-before'], ...kept]);
  let reloads = 0;
  const root = { innerHTML: '', append() {} };
  const any = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : any), apply: () => any, construct: () => any, set: () => true });
  const location = { hash, pathname: '/', search: '', origin: 'http://bob.localhost:5000', reload: () => { reloads++; } };
  const storage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  const ctx = {
    console: { error: (...a) => errors.push(a.map(String).join(' ')), log() {}, warn() {} },
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
  return { calls, errors, replaced, local, session, root, reloads: () => reloads };
}
const tick = () => new Promise((r) => setImmediate(r));

const json = (status, body, auth = false) => ({ ok: status < 300, status, headers: { get: (h) => (auth && h === 'www-authenticate' ? 'Obysphere-Console' : null) }, json: async () => body });
const ME = { name: 'bob', owner: 'Bob Test', sphere: 'http://127.0.0.1:9', sphereName: 'S' };
// the console's answers, as boot reads them
const API = { '/local/me': ME, '/api/info': { sphere: { name: 'S', policy: {} }, me: null, admin: false }, '/api/agents': { agents: [] }, '/api/channels': { channels: [] }, '/api/messages?limit=500': { messages: [] } };
const answers = (more = {}) => (url) => Promise.resolve(json(200, { ...API, ...more }[url] ?? {}));
const KEY = 'obysphere.console';

describe('your console signs in with a link that works once', () => {
  test('a link’s #code=… leaves the address, is traded once for the secret, kept in this tab, and sent in a header on every call (R19)', async () => {
    const p = runPage({
      hash: '#code=CODE-FROM-THE-LINK&page=you',
      data: {},
      fetch: answers({ '/console-signin': { secret: 'THE-SECRET' } }),
    });
    assert.deepEqual(p.replaced, ['/#page=you'], 'the code leaves the address bar at once');
    assert.equal(p.calls[0].url, '/console-signin');
    assert.equal(p.calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(p.calls[0].opts.body), { code: 'CODE-FROM-THE-LINK' });
    assert.equal(p.calls[0].opts.credentials, 'omit', 'no cookie goes with it');
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(p.session.get(KEY), 'THE-SECRET', 'kept in this tab: a reload stays signed in');
    assert.ok(![...p.local.values()].some((v) => v.includes('SECRET')), 'never in localStorage, which other tabs share');
    assert.equal(p.reloads(), 0);
    const after = p.calls.slice(1);
    assert.equal(after[0].url, '/local/me', 'who you are, from the console');
    assert.ok(after.some((c) => c.url.startsWith('/api/')), 'then the page loads');
    for (const c of after) {
      assert.equal(c.opts.headers?.['x-obysphere-auth'], 'THE-SECRET', `${c.url}: the secret, in the header`);
      assert.equal(c.opts.credentials, 'omit', `${c.url}: no cookie`);
    }
    assert.deepEqual(p.errors, [], 'the page loads all the way (boot runs after the whole script)');
  });

  test('a reload in the same tab: the secret from this tab, no link needed', async () => {
    const p = runPage({ data: {}, session: [[KEY, 'KEPT-SECRET']], fetch: answers() });
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(p.calls[0].url, '/local/me');
    assert.ok(p.calls.length > 1);
    assert.ok(p.calls.every((c) => c.opts.headers?.['x-obysphere-auth'] === 'KEPT-SECRET'));
    assert.deepEqual(p.errors, []);
  });

  test('a link that was already used, or is from before your console last started: it says so', async () => {
    const p = runPage({ hash: '#code=OLD', data: {}, fetch: () => Promise.resolve(json(401, { error: 'This link was already used.', code: 'console_auth' }, true)) });
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(p.reloads(), 0, 'no loop');
    assert.match(p.root.innerHTML, /That link doesn’t open your console any more/);
    assert.match(p.root.innerHTML, /obysphere open/);
    assert.ok(!p.session.has(KEY));
  });

  test('the console started again since: the secret this tab kept is dropped, and the page asks for a new link', async () => {
    const p = runPage({ data: {}, session: [[KEY, 'OLD-SECRET']], fetch: () => Promise.resolve(json(401, { code: 'console_auth' }, true)) });
    for (let i = 0; i < 10; i++) await tick();
    assert.ok(!p.session.has(KEY), 'dropped');
    assert.match(p.root.innerHTML, /Open your console/);
  });

  test('without its link: how to open it, and nothing asked of the API', () => {
    const p = runPage({ data: {} });
    assert.match(p.root.innerHTML, /Open your console/);
    assert.match(p.root.innerHTML, /obysphere open/);
    assert.deepEqual(p.calls, []);
  });

  test('an old #auth= link leaves the address, and is never sent', () => {
    const p = runPage({ hash: '#auth=OLD&mode=conversation&c=general', data: {} });
    assert.deepEqual(p.replaced, ['/#mode=conversation&c=general']);
    assert.deepEqual(p.calls, [], 'nothing sent: it no longer signs in');
    assert.match(p.root.innerHTML, /Open your console/);
  });

  test('downloads and peeks go through fetch with the header, in your console too: never a plain link that needs a cookie', () => {
    assert.ok(!/dl && !CONSOLE/.test(SCRIPT), 'the console no longer leaves a download to the browser');
    assert.ok(!/x-obysphere-console/.test(SCRIPT), 'no cookie-era header');
    assert.ok(!/'\/local\/auth'/.test(SCRIPT), 'no trade for a cookie');
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
