// Helpers for the browser tests (test/browser-tests.test.mjs): a Sphere and its members on this
// machine, each Oby answering with the fake runtimes (test/fake-runtimes.mjs, first on PATH),
// and small steps for driving the console in Chromium through Playwright. Nothing here imports
// Playwright: the test file loads it when it's installed, so `npm test` runs without it.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// the version CI installs (.github/workflows/ci.yml); keep the two the same
export const PLAYWRIGHT_VERSION = '1.64.1';

export const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Playwright and Chromium: a reason instead of an error when either is missing

export async function loadChromium() {
  let pw;
  try {
    pw = await import('playwright');
  } catch (e) {
    return { reason: `Playwright isn't installed (${e.code || firstLine(e.message)}). To run these tests: npm install --no-save playwright@${PLAYWRIGHT_VERSION} && npx playwright install chromium` };
  }
  const chromium = pw.chromium || pw.default?.chromium;
  try {
    return { browser: await chromium.launch() };
  } catch (e) {
    return { reason: `Chromium didn't start (${firstLine(e.message)}). Install it with: npx playwright install chromium` };
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

// Everything lives in one temp folder (OBYSPHERE_HOME, the relay's data, the members' folders,
// a Claude Code config folder with nothing in it), and every process started here is stopped.
export class World {
  constructor() {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-browser-')));
    this.home = path.join(this.tmp, 'reps');
    this.cfg = path.join(this.tmp, 'claude-config');
    for (const d of [this.home, this.cfg]) fs.mkdirSync(d, { recursive: true });
    this.bin = path.join(this.tmp, 'bin');
    this.fake = makeFakeRuntimes(this.bin);
    this.procs = [];
  }

  // the members' environment: the fake runtimes first on PATH, and nothing of this machine's own
  env() {
    const e = { ...process.env, PATH: `${this.bin}${path.delimiter}${process.env.PATH || ''}`, OBYSPHERE_HOME: this.home, OBYSPHERE_DOWNLOADS: path.join(this.tmp, 'downloads'), CLAUDE_CONFIG_DIR: this.cfg, OBYSPHERE_CHROME: '0' };
    for (const k of Object.keys(e)) if (/^SPHERE_/.test(k) || k === 'OBYSPHERE_ADMIN_KEY' || k === 'OBYSPHERE_PROFILE') delete e[k];
    return e;
  }

  // a process that keeps running; its output is kept for failure messages
  start(label, file, args, env) {
    const proc = spawn(process.execPath, [path.join(ROOT, file), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const env = { ...process.env, SPHERE_KEY: this.sphere.key, SPHERE_ADMIN_KEY: this.sphere.admin, SPHERE_SEALED: sealed ? '1' : '0', SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' };
    this.relay = this.start('relay', 'server.mjs', ['--port', String(port), '--host', '127.0.0.1', '--data', path.join(this.tmp, 'relay'), '--name', name], env);
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(this.sphere.url + '/healthz')).ok) return this.sphere;
      } catch {}
      await sleep(100);
    }
    throw new Error(`the relay didn't start:\n${this.relay.out}`);
  }

  // `rep.mjs <args>` to the end
  async rep(args, timeoutMs = 60000) {
    const p = this.start(`rep.mjs ${args[0]}`, 'rep.mjs', args, this.env());
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

  async stop() {
    for (const p of this.procs) p.proc.kill('SIGTERM');
    await Promise.race([Promise.all(this.procs.map((p) => p.exited)), sleep(5000)]);
    for (const p of this.procs) if (p.proc.exitCode === null) p.proc.kill('SIGKILL');
    if (!process.env.OBYSPHERE_BROWSER_KEEP) fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ---- the browser: one context per test, at one width

const ARTIFACTS = path.resolve(process.env.OBYSPHERE_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'obysphere-browser-artifacts'));

// Opens url at vp's width in a fresh context, runs fn(page), and checks that the page logged no
// errors. On a failure it keeps a screenshot and a Playwright trace (npx playwright show-trace).
export async function withPage(browser, t, url, vp, fn) {
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  context.setDefaultTimeout(15000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${firstLine(e.stack || e.message)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`);
  });
  let failed = null;
  try {
    await page.goto(url);
    await fn(page);
    assert.deepEqual(problems, [], 'no page errors or console errors');
  } catch (e) {
    failed = e;
  }
  try {
    if (failed) {
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      const base = path.join(ARTIFACTS, `${vp.name}-${t.name}`.replace(/[^\w-]+/g, '-').slice(0, 90));
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
      await context.tracing.stop({ path: `${base}-trace.zip` });
      failed.message += `\n  screenshot and trace: ${base}.png, ${base}-trace.zip${problems.length ? `\n  the page also logged:\n    ${problems.join('\n    ')}` : ''}`;
    } else await context.tracing.stop();
  } finally {
    await context.close();
  }
  if (failed) throw failed;
}

// the page's title (its one h1)
export const title = (page, name) => page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' });

// The side panel: always there at desktop width; at phone width it slides in with "Side panel"
// and out again after a choice. settled() waits for it to stop moving, then says if it's in view.
async function settled(locator) {
  return locator.evaluate(
    (el) =>
      new Promise((resolve) => {
        const end = performance.now() + 3000;
        let last = null;
        let same = 0;
        const tick = () => {
          const r = el.getBoundingClientRect();
          same = r.left === last ? same + 1 : 0;
          last = r.left;
          if (same >= 3 || performance.now() > end) return resolve(r.width > 0 && r.right > 0 && r.left < window.innerWidth);
          requestAnimationFrame(tick);
        };
        tick();
      }),
  );
}
export async function sidePanel(page) {
  const side = page.getByRole('complementary');
  await side.waitFor();
  if (!(await settled(side))) {
    await page.getByRole('button', { name: 'Side panel' }).click();
    assert.ok(await settled(side), 'the side panel slides in');
  }
  return side;
}

// a page of the console, from the side panel ("Traffic", "Your Oby", …; a count may follow the name)
export async function goTo(page, name) {
  const side = await sidePanel(page);
  await side.getByRole('button', { name: new RegExp(`^${reEscape(name)}(\\s\\d+)?$`) }).click();
  await settled(side);
}
export async function hasPage(page, name) {
  return (await page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${reEscape(name)}(\\s\\d+)?$`) }).count()) > 0;
}

// Console or Conversation: the switch in the title bar (0.3.0 moves it to the side panel)
export async function switchView(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  if (await tab.count()) return tab.click();
  const side = await sidePanel(page);
  await side.getByRole('button', { name, exact: true }).click();
  if (await page.getByRole('button', { name: 'Side panel' }).isVisible()) {
    await page.keyboard.press('Escape'); // at phone width, out of the way again
    await settled(side);
  }
}

// Anything that scrolls sideways: the page itself, or a part of it that scrolls but shouldn't.
// Tables and code blocks are made to scroll sideways inside their own box, so they don't count.
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
      if (el.closest('.table-wrap, pre')) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map((c) => '.' + c).join('')} scrolls sideways (${el.scrollWidth}px in ${el.clientWidth}px)`);
    }
    return out;
  });
}
export async function noSidewaysScroll(page, vp, where) {
  assert.deepEqual(await sidewaysScroll(page), [], `${where}, ${vp.viewport.width}px wide: nothing scrolls sideways`);
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
