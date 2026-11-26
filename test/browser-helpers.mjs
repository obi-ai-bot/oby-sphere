// Helpers for the browser tests (test/browser-tests.test.mjs): a Sphere and its members on this
// machine, each Oby answering with the fake runtimes (test/fake-runtimes.mjs) and working on GitHub
// through the fake gh (test/fake-gh.mjs), both first on PATH; a fake ntfy and Slack; small steps
// for driving the console in Chromium through Playwright; and axe-core's accessibility checks.
// Nothing here imports Playwright or axe-core: the test file loads them when they're installed, so
// `npm test` runs without them.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { makeFakeGh } from './fake-gh.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// the versions CI installs (.github/workflows/ci.yml); keep them the same
export const PLAYWRIGHT_VERSION = '1.64.1';
export const AXE_VERSION = '4.10.2';

export const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Playwright and Chromium: a reason instead of an error when either is missing

// Chromium is started once here, to know it can, and closed again: the tests start their own
// in before(), so nothing is left running (and the run doesn't hang) when a filter such as
// --test-name-pattern leaves them out and node:test skips their hooks.
export async function loadChromium() {
  let pw;
  try {
    pw = await import('playwright');
  } catch (e) {
    return { reason: `Playwright isn't installed (${e.code || firstLine(e.message)}). To run these tests: npm install --no-save playwright@${PLAYWRIGHT_VERSION} axe-core@${AXE_VERSION} && npx playwright install chromium` };
  }
  const chromium = pw.chromium || pw.default?.chromium;
  try {
    await (await chromium.launch()).close();
    return { chromium };
  } catch (e) {
    return { reason: `Chromium didn't start (${firstLine(e.message)}). Install it with: npx playwright install chromium` };
  }
}

// axe-core's script, to run in a page, or a reason it can't (the accessibility checks skip then)
export function loadAxe() {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve('axe-core/axe.min.js');
    const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'package.json'), 'utf8'));
    return { source: fs.readFileSync(file, 'utf8'), version };
  } catch (e) {
    return { reason: `axe-core isn't installed (${e.code || firstLine(e.message)}). To run the accessibility checks: npm install --no-save axe-core@${AXE_VERSION}` };
  }
}

// ---- the machine: a Sphere, its members' profiles, their representatives and consoles

// a free port on 127.0.0.1, never the demo's (4848 to 4850), which may be running on this machine
export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p >= 4848 && p <= 4850 ? freePort() : p));
    });
  });

// what a member's machine would show on its desktop or open in a browser: here each only
// writes a line to desktop.log beside it, so nothing reaches this machine's own desktop
const DESKTOP_FAKES = ['osascript', 'terminal-notifier', 'notify-send', 'open', 'xdg-open'];
function makeDesktopFakes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of DESKTOP_FAKES) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "$(dirname "$0")/desktop.log"\nexit 0\n`, { mode: 0o755 });
}

// Everything lives in one temp folder (OBYSPHERE_HOME, the relay's data, the members' folders,
// a Claude Code config folder with nothing in it, a HOME and an app home of their own), and
// every process started here is stopped.
export class World {
  constructor() {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-browser-')));
    this.home = path.join(this.tmp, 'reps');
    this.cfg = path.join(this.tmp, 'claude-config');
    this.userHome = path.join(this.tmp, 'home');
    this.appHome = path.join(this.tmp, 'app');
    for (const d of [this.home, this.cfg, this.userHome, this.appHome]) fs.mkdirSync(d, { recursive: true });
    this.bin = path.join(this.tmp, 'bin');
    this.fake = makeFakeRuntimes(this.bin);
    // gh in a folder of its own: it keeps its own control.json and calls.jsonl
    this.gh = makeFakeGh(path.join(this.tmp, 'gh-bin'));
    makeDesktopFakes(path.join(this.tmp, 'desktop-bin'));
    this.notifyLog = path.join(this.tmp, 'notify.jsonl');
    this.procs = [];
  }

  // The members' environment: the fake runtimes, gh and desktop first on PATH, and nothing of
  // this machine's own: no update check on GitHub, notifications recorded in a log (a Slack or
  // phone address on 127.0.0.1 is still called), and HOME a temp folder.
  env() {
    const fakes = [this.bin, this.gh.dir, path.join(this.tmp, 'desktop-bin')];
    const e = {
      ...process.env,
      PATH: [...fakes, process.env.PATH || ''].join(path.delimiter),
      HOME: this.userHome,
      OBYSPHERE_HOME: this.home,
      OBYSPHERE_APP_HOME: this.appHome,
      OBYSPHERE_DOWNLOADS: path.join(this.tmp, 'downloads'),
      OBYSPHERE_NO_UPDATE_CHECK: '1',
      OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
      OBYSPHERE_NOTIFY_LOG: this.notifyLog,
      CLAUDE_CONFIG_DIR: this.cfg,
      OBYSPHERE_CHROME: '0',
    };
    for (const k of Object.keys(e)) if (/^SPHERE_/.test(k) || /^(OBYSPHERE_(ADMIN_KEY|PROFILE|CLI)|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR)$/.test(k)) delete e[k];
    return e;
  }

  // a process that keeps running; its output is kept for failure messages
  start(label, file, args, env) {
    return this.keep(label, spawn(process.execPath, [path.join(ROOT, file), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  keep(label, proc) {
    const p = { label, proc, out: '' };
    const add = (d) => {
      p.out += d;
      if (p.out.length > 200e3) p.out = p.out.slice(-100e3);
    };
    proc.stdout.on('data', add);
    proc.stderr.on('data', add);
    p.exited = new Promise((resolve) => proc.on('close', (code) => resolve({ code, out: p.out })));
    this.procs.push(p);
    return p;
  }

  async waitFor(p, re, timeoutMs = 20000) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
      if (re.test(p.out)) return;
      if (p.proc.exitCode !== null) break;
    }
    throw new Error(`${p.label} didn't say ${re}:\n${p.out.slice(-3000)}`);
  }

  // what each process said last, for a failure message
  logs() {
    return this.procs.map((p) => `--- ${p.label}\n${p.out.slice(-1500)}`).join('\n');
  }

  async startSphere({ name = 'Browser Test Sphere', sealed = true } = {}) {
    const port = await freePort();
    this.sphere = { name, url: `http://127.0.0.1:${port}`, key: 'join-key-browser-tests-0123456789', admin: 'admin-key-browser-tests-0123456789' };
    const env = { ...process.env, HOME: this.userHome, SPHERE_KEY: this.sphere.key, SPHERE_ADMIN_KEY: this.sphere.admin, SPHERE_SEALED: sealed ? '1' : '0', SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' };
    this.relay = this.start('relay', 'server.mjs', ['--port', String(port), '--host', '127.0.0.1', '--data', path.join(this.tmp, 'relay'), '--name', name], env);
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(this.sphere.url + '/healthz')).ok) return this.sphere;
      } catch {}
      await sleep(100);
    }
    throw new Error(`the relay didn't start:\n${this.relay.out}`);
  }

  // `rep.mjs <args>` to the end (env: more of the environment, such as a key it reads from there)
  async rep(args, { env = {}, timeoutMs = 60000 } = {}) {
    const p = this.start(`rep.mjs ${args[0]}`, 'rep.mjs', args, { ...this.env(), ...env });
    const t = setTimeout(() => p.proc.kill(), timeoutMs);
    const r = await p.exited;
    clearTimeout(t);
    this.procs.splice(this.procs.indexOf(p), 1);
    return r;
  }

  // `rep.mjs <args>` in the background, such as an ask that waits for its answer
  repInBackground(args) {
    return this.start(`rep.mjs ${args.join(' ').slice(0, 60)}`, 'rep.mjs', args, this.env());
  }

  async join(name, owner, about) {
    const cwd = path.join(this.tmp, 'work', name);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'README.md'), `# ${owner}'s notes\n`);
    const r = await this.rep(['join', `${this.sphere.url}/#key=${this.sphere.key}`, '--name', name, '--owner', owner, '--about', about, '--cwd', cwd]);
    assert.match(r.out, /joined/, r.out);
  }

  // a member's Oby made an admin, as `rep.mjs admin claim` does it: the admin key in the
  // environment for that one command, never on its command line
  async claimAdmin(name) {
    const r = await this.rep(['admin', 'claim', '--profile', name], { env: { OBYSPHERE_ADMIN_KEY: this.sphere.admin } });
    assert.equal(r.code, 0, r.out);
  }

  settingsPath(name) {
    return path.join(this.home, name, 'settings.json');
  }
  settings(name) {
    return JSON.parse(fs.readFileSync(this.settingsPath(name), 'utf8'));
  }
  editSettings(name, fn) {
    const s = this.settings(name);
    fn(s);
    fs.writeFileSync(this.settingsPath(name), JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  // the Sphere's policy, as the relay has it (asked with the join key, as its own page asks)
  async policy() {
    const r = await fetch(`${this.sphere.url}/api/info`, { headers: { 'x-sphere-key': this.sphere.key } });
    return (await r.json()).sphere.policy;
  }

  // a member's representative, online and answering
  async serve(name) {
    const p = this.start(`${name}: rep.mjs serve`, 'rep.mjs', ['serve', '--profile', name], this.env());
    await this.waitFor(p, /is online/);
    return p;
  }

  // a member's console (rep.mjs ui), at its own origin: http://<handle>.localhost:<port>/
  async console(name, { serve = false } = {}) {
    const port = await freePort();
    const p = this.start(`${name}: rep.mjs ui`, 'rep.mjs', ['ui', '--profile', name, '--port', String(port), ...(serve ? ['--serve'] : [])], this.env());
    await this.waitFor(p, /your console for/);
    if (serve) await this.waitFor(p, /is online/);
    return { url: `http://${name}.localhost:${port}/`, proc: p };
  }

  // The answering session's own MCP server (`rep.mjs mcp --as-session`), started as Claude Code
  // starts it, from the config a fake runtime was given (run.mcp). call(tool, args) gives the
  // tool's words; what it would do on GitHub goes through the fake gh.
  session(run) {
    const { command, args, env } = run.mcp.mcpServers.obysphere;
    const proc = spawn(command, args, { env: { ...this.env(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.keep('the answering session (rep.mjs mcp)', proc);
    const waiting = new Map();
    let buf = '';
    let n = 0;
    proc.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          waiting.get(m.id)?.(m);
        } catch {}
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve) => {
        waiting.set(++n, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      });
    return {
      call: async (name, input) => {
        const r = await rpc('tools/call', { name, arguments: input });
        return r.result?.content?.[0]?.text ?? r.error?.message ?? '';
      },
      close: () => proc.kill(),
    };
  }

  async stop() {
    for (const p of this.procs) p.proc.kill('SIGTERM');
    await Promise.race([Promise.all(this.procs.map((p) => p.exited)), sleep(5000)]);
    for (const p of this.procs) if (p.proc.exitCode === null) p.proc.kill('SIGKILL');
    if (!process.env.OBYSPHERE_BROWSER_KEEP) fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ---- the browser: one context per test, at one width

const ARTIFACTS = path.resolve(process.env.OBYSPHERE_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'obysphere-browser-artifacts'));

// Opens url at vp's width in a fresh context and runs fn(page, { open }); open(url) opens another
// page in the same context, such as another member's console. Then it checks that no page logged
// an error. On a failure it keeps a screenshot of each page and a Playwright trace
// (npx playwright show-trace).
export async function withPage(browser, t, url, vp, fn) {
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  context.setDefaultTimeout(15000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const problems = [];
  const pages = [];
  const open = async (to) => {
    const page = await context.newPage();
    const where = new URL(to).host;
    page.on('pageerror', (e) => problems.push(`page error at ${where}: ${firstLine(e.stack || e.message)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error at ${where}: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`);
    });
    pages.push(page);
    await page.goto(to);
    return page;
  };
  let failed = null;
  try {
    await fn(await open(url), { open });
    assert.deepEqual(problems, [], 'no page errors or console errors');
  } catch (e) {
    failed = e;
  }
  try {
    if (failed) {
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      const base = path.join(ARTIFACTS, `${vp.name}-${t.name}`.replace(/[^\w-]+/g, '-').slice(0, 90));
      const shots = pages.map((p, i) => `${base}${i ? `-${i + 1}` : ''}.png`);
      for (const [i, p] of pages.entries()) await p.screenshot({ path: shots[i], fullPage: true }).catch(() => {});
      await context.tracing.stop({ path: `${base}-trace.zip` });
      failed.message += `\n  screenshots and trace: ${[...shots, `${base}-trace.zip`].join(', ')}${problems.length ? `\n  the pages also logged:\n    ${problems.join('\n    ')}` : ''}`;
    } else await context.tracing.stop();
  } finally {
    await context.close();
  }
  if (failed) throw failed;
}

// the page's title (its one h1)
export const title = (page, name) => page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' });

// The side panel: always there at desktop width; at phone width it slides in with "Side panel"
// and out again after a choice. settled() waits for it to stop moving (to be in view, or out of
// it, when `inView` says which), then says if it's in view. A slide that has only just been asked
// for may not have moved yet, so it waits for the panel's own transitions to end too.
async function settled(locator, inView) {
  return locator.evaluate(
    (el, want) =>
      new Promise((resolve) => {
        const end = performance.now() + 3000;
        const seen = (r) => r.width > 0 && r.right > 0 && r.left < window.innerWidth;
        let last = null;
        let same = 0;
        const tick = () => {
          const r = el.getBoundingClientRect();
          same = r.left === last ? same + 1 : 0;
          last = r.left;
          const moving = el.getAnimations().some((a) => a.playState === 'running');
          if ((same >= 3 && !moving && (want === null || seen(r) === want)) || performance.now() > end) return resolve(seen(r));
          requestAnimationFrame(tick);
        };
        tick();
      }),
    inView ?? null,
  );
}
export async function sidePanel(page) {
  const side = page.getByRole('complementary');
  await side.waitFor();
  if (!(await settled(side))) {
    await page.getByRole('button', { name: 'Side panel' }).click();
    assert.ok(await settled(side, true), 'the side panel slides in');
  }
  return side;
}

// What the side panel offers: a page of the console ("Traffic", "Your Oby", …), or in the
// Conversation view a channel or a person ("general", "Bob Test"). A count may follow the name.
const inSide = (page, name) => page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${reEscape(name)}(\\s\\d+\\+?( new| waiting for you)?)?$`) });
export async function goTo(page, name) {
  const side = await sidePanel(page);
  const narrow = await page.getByRole('button', { name: 'Side panel' }).isVisible();
  await inSide(page, name).click();
  await settled(side, narrow ? false : undefined); // on a phone, it slides away
}
export async function hasPage(page, name) {
  return (await inSide(page, name).count()) > 0;
}

// Console or Conversation: the view switch at the side panel's left edge
export async function switchView(page, name) {
  const side = await sidePanel(page);
  await side.getByRole('tab', { name, exact: true }).click();
  if (await page.getByRole('button', { name: 'Side panel' }).isVisible()) {
    await page.keyboard.press('Escape'); // at phone width, out of the way again
    await settled(side, false);
  }
}

// Anything that scrolls sideways: the page itself, or a part of it that scrolls but shouldn't.
// Tables, code blocks and Settings' row of section buttons are made to scroll sideways inside
// their own box, so they don't count.
export async function sidewaysScroll(page) {
  return page.evaluate(() => {
    const out = [];
    // the window's width (on a phone, innerWidth grows to fit a page that's too wide)
    const w = document.documentElement.clientWidth;
    const se = document.scrollingElement;
    if (se.scrollWidth > w + 1) out.push(`the page is ${se.scrollWidth}px wide in a ${w}px window`);
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      const ox = getComputedStyle(el).overflowX;
      if (ox !== 'auto' && ox !== 'scroll') continue;
      if (el.closest('.table-wrap, pre, .set-nav-in')) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map((c) => '.' + c).join('')} scrolls sideways (${el.scrollWidth}px in ${el.clientWidth}px)`);
    }
    return out;
  });
}
export async function noSidewaysScroll(page, vp, where) {
  assert.deepEqual(await sidewaysScroll(page), [], `${where}, ${vp.viewport.width}px wide: nothing scrolls sideways`);
}

// What axe-core finds against WCAG 2.2 AA on the page as it is now: one line per element it
// flags, with the rule's id, its impact and the element (its CSS path), and what the rule asks.
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export async function axeViolations(page, source) {
  // evaluated, not added as a script tag, so the page's Content-Security-Policy doesn't stop it
  if (!(await page.evaluate(() => typeof window.axe === 'object'))) await page.evaluate(source);
  // what is still fading in (a dialog, a menu, a new message) is checked once it has: halfway
  // through, its colours are a mix and their contrast says nothing. Endless ones (a pulsing dot) go
  // on, and no wait is longer than 3 seconds.
  await page.evaluate(() => {
    const ending = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    return Promise.race([Promise.all(ending.map((a) => a.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 3000))]);
  });
  const violations = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }))), AXE_TAGS);
  return violations.flatMap((v) => v.targets.map((target) => `${v.id} (${v.impact}): ${target} — ${v.help}`));
}

// A POST to a member's console (rep.mjs ui) from outside the page, as a script on that machine
// could send it; the console sends it on with the member's token. { status, body }
export function consolePost(consoleUrl, apiPath, body) {
  const u = new URL(consoleUrl);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // to 127.0.0.1 with the console's own Host, so no lookup of <handle>.localhost is needed
    const req = http.request({ host: '127.0.0.1', port: u.port, path: apiPath, method: 'POST', headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-obysphere-console': '1' } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => {
        let parsed = out;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// A phone's ntfy server and a Slack incoming webhook, on 127.0.0.1: every request it gets is kept
// in hits ({ path, headers, body }), and it answers 200
export async function startFakeHooks() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  // never on the demo's ports (4848 to 4850)
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    if (port < 4848 || port > 4850) break;
    await new Promise((resolve) => server.close(resolve));
  }
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

// polls until fn() is truthy
export async function until(fn, what, timeoutMs = 15000) {
  let last;
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(150)) {
    try {
      if ((last = await fn())) return last;
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last: ${String(last).slice(0, 300)})` : ''}`);
}
