// The console (public/index.html) in a real browser: Chromium through Playwright, at desktop and
// phone width. A sealed Sphere and three members run on this machine: alice, whose console most
// flows drive; bob, an admin; and carol, who is in none of their conversations and whose Oby is
// offline. Their Obys answer with fake runtimes (test/fake-runtimes.mjs), gh is a fake
// (test/fake-gh.mjs), and so are the phone's ntfy server and Slack: no model and no network. Each
// flow also checks that no page logged an error and that nothing scrolls sideways.
//
// Playwright is installed only for these tests, never as a dependency (CONTRIBUTING.md):
//   npm install --no-save playwright@<version in test/browser-helpers.mjs>
//   npx playwright install chromium
//   OBYSPHERE_BROWSER_TESTS=1 node --test test/browser-tests.test.mjs
// Without Playwright the file skips, saying why; with OBYSPHERE_BROWSER_TESTS=1 it fails instead,
// so CI can't skip it by accident.
//
// A new flow is a few lines on the helpers: World (the machine, and an answering session's own
// tools with world.session), withPage (a page, and more pages with open), goTo (the side panel),
// switchView, noSidewaysScroll and until. Find things by role, label or text.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_VERSION, VIEWPORTS, World, loadChromium, withPage, title, goTo, hasPage, switchView, noSidewaysScroll, startFakeHooks, until, consolePost } from './browser-helpers.mjs';

const REQUIRED = process.env.OBYSPHERE_BROWSER_TESTS === '1';
const ANSWER = 'Here is my answer, from a fake runtime on this machine.';
const EACH = { timeout: 90000 }; // each flow; every wait inside it gives up sooner
const VERSION_TEST = 'CI and CONTRIBUTING.md install the Playwright version these tests name';
const { chromium, reason } = await loadChromium();
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test(VERSION_TEST, () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.equal(/PLAYWRIGHT_VERSION: '([^']+)'/.exec(read('.github/workflows/ci.yml'))?.[1], PLAYWRIGHT_VERSION);
  assert.deepEqual([...read('CONTRIBUTING.md').matchAll(/playwright@(\S+)/g)].map((m) => m[1]), [PLAYWRIGHT_VERSION]);
});

if (!chromium) {
  if (REQUIRED) test('the browser tests can run (OBYSPHERE_BROWSER_TESTS=1)', () => assert.fail(reason));
  else test('the console in a real browser', { skip: reason }, () => {});
} else {
  // A filter that leaves the browser tests out skips their before() and after(); the file must
  // still end on its own, with no Chromium or temp folder left behind.
  test('a run that filters out the browser tests ends on its own', { timeout: 60000 }, async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a run of its own, not a child of this one
    // the file itself, not under `node --test`, so the kill below reaches it (and its Chromium)
    const child = spawn(process.execPath, ['--test-name-pattern', `^${VERSION_TEST}$`, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const [code, signal] = await new Promise((resolve) => child.on('close', (c, s) => resolve([c, s])));
    clearTimeout(timer);
    assert.equal(signal, null, `the filtered run was still going after 30 s:\n${out.slice(-2000)}`);
    assert.equal(code, 0, out.slice(-2000));
    assert.match(out, /# pass 1\b/, out.slice(-2000));
  });

  describe('the console in a real browser', () => {
    let browser, world, sphere, hooks, alice, bob, carol;
    const run = (t, url, vp, fn) => withPage(browser, t, url, vp, fn).catch((e) => {
      e.message += `\n${world.logs()}`;
      throw e;
    });

    before(async () => {
      browser = await chromium.launch();
      world = new World();
      world.fake.control({ text: ANSWER });
      hooks = await startFakeHooks();
      sphere = await world.startSphere();
      await world.join('alice', 'Alice Test', 'Knows the release notes');
      await world.join('bob', 'Bob Test', 'Knows the payments service');
      await world.join('carol', 'Carol Test', 'Knows the design system');
      // Bob's Oby is an admin of the Sphere; Alice's and Carol's are members
      await world.claimAdmin('bob');
      // Obys you haven't listed wait for you by default: here Bob's and Alice's Obys answer them,
      // and Alice's waits for her on asks from Bob (Waiting for you)
      world.editSettings('bob', (s) => (s.access.default = 'answer'));
      world.editSettings('alice', (s) => Object.assign(s.access, { default: 'answer', agents: { bob: 'approve' } }));
      await world.serve('bob');
      alice = await world.console('alice', { serve: true });
      bob = await world.console('bob');
      // Carol's console runs, but her Oby doesn't: it's offline, as a member often is
      carol = await world.console('carol');
    });
    after(async () => {
      try {
        await browser?.close();
      } finally {
        await hooks?.close();
        await world?.stop();
      }
    });

    for (const vp of VIEWPORTS) {
      describe(`at ${vp.name} width (${vp.viewport.width}×${vp.viewport.height})`, () => {
        test("the Sphere's own page, opened with the join key, shows the Overview and reaches each page", EACH, async (t) => {
          await run(t, `${sphere.url}/#key=${encodeURIComponent(sphere.key)}`, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            // Carol's Oby is offline: Overview counts it, and the map has it (on a phone, without its state)
            await page.getByRole('button', { name: /^Obys online 2\/ 3 1 offline$/ }).waitFor();
            await page.getByRole('group', { name: 'Map' }).getByRole('listitem', { name: 'Carol Test’s Oby' }).waitFor();
            await page.getByRole('log', { name: 'Live log' }).waitFor();
            await noSidewaysScroll(page, vp, 'Overview');
            // someone holding only the join key watches: no member's pages, and no admin's
            for (const name of ['Your Oby', 'Settings', 'Policy', 'Admins']) assert.equal(await hasPage(page, name), false, `no ${name}`);
            assert.equal(await hasPage(page, 'Admin sign-in'), true);
            const pages = [
              ['Traffic', 'Traffic', () => page.getByText(/^\d+ exchanges?\b/)],
              ['Members', 'Members', () => page.getByRole('row').filter({ hasText: '@carol' }).getByText('Offline')],
              ['Instruments', 'Instruments', () => page.getByRole('button', { name: /^sphere_ask\b/ })],
              ['Files', 'Files', () => page.getByText(/No files yet|^\d+ files? · /)],
              ['Audit log', 'Audit log', () => page.getByText(/^Chain verified · \d+ events$/)],
              ['Overview', sphere.name, () => page.getByRole('group', { name: 'Map' })],
            ];
            for (const [nav, heading, shows] of pages) {
              await goTo(page, nav);
              await title(page, heading).waitFor();
              await shows().first().waitFor();
              await noSidewaysScroll(page, vp, nav);
            }

            // the audit log's search and its dropdowns: each row's event and its detail
            await goTo(page, 'Audit log');
            const events = page.getByRole('region', { name: 'Events' });
            const shown = () => events.getByRole('row').evaluateAll((rows) => rows.slice(1).map((r) => ({ type: r.cells[2].innerText, detail: r.cells[3].innerText })));
            await page.getByRole('textbox', { name: 'Search events' }).fill('joined');
            await until(async () => { const d = await shown(); return d.every((e) => e.detail.includes('joined')) && ['alice', 'bob', 'carol'].every((n) => d.some((e) => e.detail.startsWith(`${n} joined`))); }, 'only the joins');
            await page.getByRole('button', { name: 'Member: Everyone' }).click();
            await page.getByRole('listbox', { name: 'Member' }).getByRole('option', { name: /@carol/ }).click();
            await until(async () => { const d = await shown(); return d.length === 1 && d[0].detail.startsWith('carol joined'); }, "carol's join alone");
            await page.getByRole('button', { name: /^Member: / }).click();
            await page.getByRole('listbox', { name: 'Member' }).getByRole('option', { name: 'Everyone' }).click();
            await page.getByRole('textbox', { name: 'Search events' }).fill('');
            await page.getByRole('button', { name: 'Event type: All events' }).click();
            await page.getByRole('listbox', { name: 'Event type' }).getByRole('option', { name: /^Members\b/ }).click();
            await page.getByRole('button', { name: 'Event type: Members' }).waitFor();
            await until(async () => { const d = await shown(); return d.length >= 3 && d.every((e) => ['join', 'online', 'offline', 'session', 'keys', 'channel'].includes(e.type)); }, 'only members’ events');
            await noSidewaysScroll(page, vp, 'the audit log, filtered');
            await page.getByRole('button', { name: 'Clear filters' }).click();
            await page.getByRole('button', { name: 'Event type: All events' }).waitFor();
          });
        });

        test("a member's console (rep.mjs ui) is signed in as them and shows Your Oby", EACH, async (t) => {
          await run(t, alice.url, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            await page.getByRole('button', { name: 'New exchange' }).waitFor();
            assert.equal(await hasPage(page, 'Settings'), true);
            // the side panel's edge names the Sphere and you, on a touch screen too
            const side = page.getByRole('complementary');
            await side.getByRole('img', { name: sphere.name, exact: true }).waitFor({ state: 'attached' });
            await side.getByRole('img', { name: 'You: Alice Test (alice)', exact: true }).waitFor({ state: 'attached' });
            await goTo(page, 'Your Oby');
            await title(page, 'Your Oby').waitFor();
            await page.getByText('answers with Claude Code').waitFor();
            await page.getByRole('heading', { name: 'Asked of your Oby', level: 2 }).waitFor();
            await page.getByRole('heading', { name: 'Your asks', level: 2 }).waitFor();
            await noSidewaysScroll(page, vp, 'Your Oby');
          });
        });

        test('New exchange asks another Oby, and Traffic shows its answer', EACH, async (t) => {
          const question = `What is two plus two? (asked at ${vp.name} width)`;
          await run(t, alice.url, vp, async (page) => {
            await page.getByRole('button', { name: 'New exchange' }).click();
            const dialog = page.getByRole('dialog', { name: 'New exchange' });
            await dialog.waitFor();
            await dialog.getByRole('button', { name: 'Add', exact: true }).click();
            await dialog.getByRole('menuitem', { name: /Bob Test.s Oby/ }).click();
            await dialog.getByRole('textbox', { name: 'Message', exact: true }).fill(question);
            await noSidewaysScroll(page, vp, 'New exchange');
            await dialog.getByRole('button', { name: 'Send', exact: true }).click();
            // the exchange opens, then fills in when Bob's Oby answers on "his" machine
            await title(page, 'Exchange').waitFor();
            await page.getByText(question).first().waitFor();
            await page.getByText(ANSWER).first().waitFor({ timeout: 30000 });
            await noSidewaysScroll(page, vp, 'the exchange');
            assert.ok(world.fake.calls().some((c) => c.prompt.includes(question)), 'the fake runtime worked out the answer');

            await goTo(page, 'Traffic');
            await title(page, 'Traffic').waitFor();
            const row = page.getByRole('row').filter({ hasText: question });
            await row.getByText('Answered').waitFor();
            await noSidewaysScroll(page, vp, 'Traffic');
            await row.click();
            await title(page, 'Exchange').waitFor();
            await page.getByText(question).first().waitFor();
            await page.getByText(ANSWER).first().waitFor();
          });
        });

        test("Settings: a change saves, and it's still there after a reload", EACH, async (t) => {
          const topic = `${vp.name} roadmap`;
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Settings');
            await title(page, 'Settings').waitFor();
            const sendFiles = page.getByRole('switch', { name: 'Send files back' });
            const wasOn = (await sendFiles.getAttribute('aria-checked')) === 'true';
            // what saving says, by the section buttons (on a phone it isn't shown)
            const state = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('status', { includeHidden: true });
            // a list of words: each one a chip, added with Enter
            await page.getByRole('textbox', { name: 'Decline asks about: add' }).fill(`salary, hiring, ${topic}`);
            await page.keyboard.press('Enter');
            await page.getByRole('button', { name: `Remove ${topic}` }).waitFor();
            await sendFiles.click();
            await until(async () => (await state.textContent()) === 'Saved', 'Saved');
            // kept where rep.mjs keeps it
            await until(() => {
              const a = world.settings('alice').access;
              return ['salary', 'hiring', topic].every((w) => a.declineTopics.includes(w)) && a.sendFiles === !wasOn;
            }, 'settings.json to have the change');
            await noSidewaysScroll(page, vp, 'Settings');

            await page.reload();
            await title(page, 'Settings').waitFor();
            for (const w of ['salary', 'hiring', topic]) await page.getByRole('button', { name: `Remove ${w}`, exact: true }).waitFor();
            assert.equal(await sendFiles.getAttribute('aria-checked'), String(!wasOn));
          });
        });

        test('Waiting for you: an ask held for approval is let through, another declined, and one answered by you', EACH, async (t) => {
          const yes = `Could you summarise the release notes? (${vp.name}, let through)`;
          const no = `Could you share the launch date? (${vp.name}, declined)`;
          const mine = `Could you check the changelog? (${vp.name}, answered by Alice)`;
          const myAnswer = `Alice here: the changelog is fine. (${vp.name})`;
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Your Oby');
            await title(page, 'Your Oby').waitFor();
            const ask = (text) => world.repInBackground(['ask', 'alice', text, '--profile', 'bob', '--wait', '60']);
            const [askYes, askNo, askMine] = [ask(yes), ask(no), ask(mine)];
            // an item that waits for you (it has no role of its own)
            const card = (text) => page.locator('[data-pending]').filter({ hasText: text });

            await page.getByRole('heading', { name: /^Waiting for you/ }).waitFor();
            await card(yes).getByText(/Bob Test.s Oby asks/).waitFor();
            await card(mine).waitFor();
            await noSidewaysScroll(page, vp, 'Waiting for you');
            await card(yes).getByRole('button', { name: 'Let my Oby answer' }).click();
            await card(yes).waitFor({ state: 'detached' });
            const answered = await askYes.exited;
            assert.ok(answered.out.includes(ANSWER), answered.out);
            assert.ok(world.fake.calls().some((c) => c.prompt.includes(yes)), 'answered by the fake runtime');

            const runs = world.fake.calls().length;
            await card(no).getByRole('button', { name: 'Decline' }).click();
            await card(no).waitFor({ state: 'detached' });
            const declined = await askNo.exited;
            assert.match(declined.out, /Alice Test's Oby isn't taking this ask: its owner declined it/, declined.out);

            await card(mine).getByRole('button', { name: 'Answer myself' }).click();
            await card(mine).getByRole('textbox', { name: 'Your answer, sent as yours' }).fill(myAnswer);
            await noSidewaysScroll(page, vp, 'Answer myself');
            await card(mine).getByRole('button', { name: 'Send my answer' }).click();
            await card(mine).waitFor({ state: 'detached' });
            const written = await askMine.exited;
            assert.ok(written.out.includes(myAnswer), written.out);
            assert.equal(world.fake.calls().length, runs, 'no runtime ran for the declined ask, or the one Alice answered');
          });
        });

        test('Waiting for you: what your Oby would do on GitHub waits for your click', EACH, async (t) => {
          const pr = vp.name === 'desktop' ? 7 : 8;
          const question = `Could you approve acme/payments#${pr}? (${vp.name})`;
          await run(t, alice.url, vp, async (page) => {
            world.editSettings('alice', (s) => (s.github = { ...s.github, enabled: true, repos: ['acme/*'] }));
            // Carol asks; Alice's Oby answers, and its session would approve the pull request
            const asked = await world.rep(['ask', 'alice', question, '--profile', 'carol', '--wait', '60']);
            assert.ok(asked.out.includes(ANSWER), asked.out);
            const session = world.session(world.fake.calls().find((c) => c.prompt.includes(question)));
            assert.match(await session.call('github_review', { repo: 'acme/payments', number: pr, event: 'APPROVE', body: 'Looks right to me.' }), /waits for Alice Test/);
            session.close();
            const writes = world.gh.writes().length;

            await goTo(page, 'Your Oby');
            const card = page.locator('[data-pending]').filter({ hasText: `acme/payments#${pr}` });
            await card.getByText(`Your Oby would approve acme/payments#${pr} on GitHub`).waitFor();
            await card.getByText('Looks right to me.').waitFor();
            assert.equal(world.gh.writes().length, writes, 'nothing on GitHub while it waits');
            await noSidewaysScroll(page, vp, 'a GitHub item in Waiting for you');
            await card.getByRole('button', { name: 'Approve on GitHub' }).click();
            await card.waitFor({ state: 'detached' });
            const done = await until(() => world.gh.writes()[writes], 'gh pr review');
            assert.deepEqual(done.argv.slice(0, 5), ['pr', 'review', String(pr), '--repo=acme/payments', '--approve']);
            assert.match(done.argv[5], /^--body=Looks right to me\.\n\n— written by Alice Test's Oby, approved by Alice Test$/);
            // and the ask's thread says so, for Carol
            await switchView(page, 'Conversation');
            await page.getByRole('log').getByText(`Alice Test approved acme/payments#${pr} on GitHub.`).waitFor();
          });
        });

        test('Conversation: a posted message shows in the thread', EACH, async (t) => {
          const mine = `The release notes are out. (${vp.name})`;
          const his = `Thanks, reading them now. (${vp.name})`;
          await run(t, alice.url, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            await switchView(page, 'Conversation');
            const thread = page.getByRole('log', { name: 'Messages' });
            await thread.waitFor();
            await title(page, 'general').waitFor();
            // to everyone in #general, not to an Oby in particular
            await page.getByText(/^Everyone in #general sees it/).waitFor();
            await page.getByRole('textbox', { name: 'Message', exact: true }).fill(mine);
            await page.getByRole('button', { name: 'Send', exact: true }).click();
            await thread.getByText(mine).waitFor();
            // and someone else's post arrives while the page is open
            const r = await world.rep(['post', his, '--profile', 'bob']);
            assert.match(r.out, /Posted in #general/, r.out);
            await thread.getByText(his).waitFor();
            await noSidewaysScroll(page, vp, 'Conversation');
          });
        });

        test("Direct messages: a person opens your conversation with them; it's theirs and yours alone", EACH, async (t) => {
          const note = `Lunch at noon? Just between us. (${vp.name})`;
          await run(t, alice.url, vp, async (page, { open }) => {
            await switchView(page, 'Conversation');
            await goTo(page, 'Bob Test');
            await page.getByText('Your conversation with Bob Test and their Oby.').waitFor();
            // a note just for Bob: his Oby doesn't answer it
            const just = page.getByRole('switch', { name: 'Just for Bob Test' });
            await just.click();
            assert.equal(await just.getAttribute('aria-checked'), 'true');
            const runs = world.fake.calls().length;
            await page.getByRole('textbox', { name: 'Message', exact: true }).fill(note);
            // what the console sends asks no Oby (Bob's Oby may answer an ask after any wait here)
            const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/messages');
            await page.getByRole('button', { name: 'Send', exact: true }).click();
            assert.deepEqual((await sent).postDataJSON().to, [], 'a note just for Bob asks no Oby');
            await page.getByRole('log').getByText(note).waitFor();
            await noSidewaysScroll(page, vp, 'a direct conversation');

            // Bob finds it under Alice's name in his console
            const his = await open(bob.url);
            await switchView(his, 'Conversation');
            await goTo(his, 'Alice Test');
            await his.getByText('Your conversation with Alice Test and their Oby.').waitFor();
            await his.getByRole('log').getByText(note).waitFor();
            assert.equal(world.fake.calls().length, runs, "Bob's Oby didn't answer a note just for him");

            // Carol, a third member, has no way to it: not in her side panel, not by its link, not
            // from the relay (an admin would see it in the side panel as "Alice Test and Bob Test")
            const dm = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('c');
            assert.match(dm, /^dm-[0-9a-f]{24}$/);
            assert.ok((await world.rep(['read', dm, '--profile', 'bob'])).out.includes(note), 'Bob reads it from the relay');
            const hers = await open(`${carol.url}#mode=conversation&c=${dm}`);
            await hers.getByRole('log').waitFor();
            await hers.getByText(/^Everyone in #general sees it/).waitFor(); // #general instead
            for (const name of ['Alice Test and Bob Test', 'Bob Test and Alice Test']) assert.equal(await hasPage(hers, name), false, `no "${name}" in Carol's side panel`);
            assert.equal(await hers.getByText(note).count(), 0, "Carol's page doesn't have the note");
            assert.ok(!(await world.rep(['read', dm, '--profile', 'carol'])).out.includes(note), 'Carol reads nothing of it');
            await noSidewaysScroll(hers, vp, "Carol's Conversation view");
          });
        });

        test('A new channel, with the people and Obys picked for it', EACH, async (t) => {
          const name = `launch-${vp.name}`;
          const words = `Launch checklist is in the doc. (${vp.name})`;
          await run(t, alice.url, vp, async (page) => {
            await switchView(page, 'Conversation');
            await goTo(page, 'New channel');
            const dialog = page.getByRole('dialog', { name: 'New channel' });
            await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
            await dialog.getByRole('switch', { name: 'Private' }).click();
            await dialog.getByRole('button', { name: 'Bob Test', exact: true }).click();
            await noSidewaysScroll(page, vp, 'New channel');
            await dialog.getByRole('button', { name: 'Create channel' }).click();
            await dialog.waitFor({ state: 'hidden' });
            // it opens, with Alice and Bob in it
            await page.getByText('Private: only the people and Obys in it see it.', { exact: false }).waitFor();
            await page.getByRole('button', { name: /^In it: / }).click();
            const people = page.getByRole('dialog', { name: `People and Obys in #${name}` });
            await people.getByText('@alice · Alice Test').waitFor();
            await people.getByText('@bob · Bob Test').waitFor();
            assert.equal(await people.getByText('@carol').count(), 0, 'Carol isn’t in it');
            await people.getByRole('button', { name: 'Carol Test', exact: true }).waitFor(); // offered, to add
            await people.getByRole('button', { name: 'Close' }).click();
            await page.getByRole('textbox', { name: 'Message', exact: true }).fill(words);
            await page.getByRole('button', { name: 'Send', exact: true }).click();
            await page.getByRole('log').getByText(words).waitFor();
            await noSidewaysScroll(page, vp, `#${name}`);
            // Bob reads it; Carol, who isn't in it, doesn't
            assert.match((await world.rep(['read', name, '--profile', 'bob'])).out, new RegExp(reEscape(words)));
            assert.ok(!(await world.rep(['read', name, '--profile', 'carol'])).out.includes(words), 'Carol reads nothing of it');
          });
        });

        test("Admin pages: an admin member sees Policy, Admins and the invite; a member who isn't an admin never sees Policy", EACH, async (t) => {
          await run(t, bob.url, vp, async (page, { open }) => {
            // Bob's Oby is an admin
            await goTo(page, 'Policy');
            await title(page, 'Policy').waitFor();
            assert.equal(await page.getByRole('switch', { name: 'Seal message contents' }).getAttribute('aria-checked'), 'true', 'sealed');
            await page.getByRole('heading', { name: 'Invite link', level: 2 }).waitFor();
            await page.getByRole('button', { name: 'Rotate', exact: true }).waitFor();
            await noSidewaysScroll(page, vp, 'Policy');
            await goTo(page, 'Admins');
            await title(page, 'Admins').waitFor();
            await page.getByRole('row').filter({ hasText: 'Your Oby' }).getByText('Admin', { exact: true }).waitFor();
            await page.getByRole('row').filter({ hasText: '@carol' }).getByRole('button', { name: 'Make admin' }).waitFor();
            await noSidewaysScroll(page, vp, 'Admins');
            // the invite: one text for the new member's AI agent, with this Sphere's link in it
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await switchView(page, 'Conversation');
            await goTo(page, 'Invite member');
            const dialog = page.getByRole('dialog', { name: 'Invite member' });
            const join = `obysphere join "${sphere.url}/#key=${sphere.key}"`;
            assert.ok((await dialog.getByLabel('The text for their AI agent').textContent()).includes(join));
            await noSidewaysScroll(page, vp, 'Invite member');
            await dialog.getByRole('button', { name: 'Copy for your AI agent' }).click();
            await dialog.getByRole('button', { name: 'Copied' }).waitFor();
            assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(join), 'the text is on the clipboard');

            // Alice's Oby isn't an admin: no Policy anywhere, only the way to claim it
            const hers = await open(alice.url);
            await title(hers, sphere.name).waitFor();
            assert.equal(await hasPage(hers, 'Policy'), false);
            assert.equal(await hasPage(hers, 'Admins'), false);
            await hers.getByRole('button', { name: 'You: Alice Test', exact: true }).click();
            const menu = hers.getByRole('menu');
            assert.equal(await menu.getByRole('menuitem', { name: 'Policy' }).count(), 0);
            await menu.getByRole('menuitem', { name: 'Admin access…' }).click();
            const claim = hers.getByRole('dialog', { name: 'Admin access' });
            await claim.getByRole('textbox', { name: 'Admin key' }).waitFor();
            await claim.getByRole('button', { name: 'Make my Oby an admin' }).waitFor();
            await noSidewaysScroll(hers, vp, 'Admin access');
            await claim.getByRole('button', { name: 'Close' }).click();
            await claim.waitFor({ state: 'hidden' });
            // and a link straight to Policy opens the Overview
            await hers.goto(`${alice.url}#mode=console&page=policy`);
            await hers.reload();
            await title(hers, sphere.name).waitFor();
            assert.equal(await title(hers, 'Policy').count(), 0);
          });
        });

        test("Policy: an admin's change holds after a reload; a member who isn't an admin can't make it", EACH, async (t) => {
          await run(t, bob.url, vp, async (page, { open }) => {
            await goTo(page, 'Policy');
            await title(page, 'Policy').waitFor();
            const before = await world.policy();
            // a stepper: one more file per message, saved when the clicks stop
            const files = page.getByRole('spinbutton', { name: 'Files per message' });
            const was = Number(await files.getAttribute('aria-valuenow'));
            assert.equal(was, before.maxFilesPerMessage);
            await page.getByRole('button', { name: 'Files per message: more' }).click();
            assert.equal(await files.getAttribute('aria-valuenow'), String(was + 1));
            await page.locator('.set-row').filter({ has: files }).getByText('Saved', { exact: true }).waitFor();
            // a dropdown: the largest file, between 5 MB and 10 MB
            const to = before.maxFileBytes === 5 * 1048576 ? '10 MB' : '5 MB';
            const largest = page.getByRole('button', { name: /^Largest file / });
            await largest.click();
            await page.getByRole('listbox', { name: 'Largest file' }).getByRole('option', { name: to, exact: true }).click();
            await page.getByRole('button', { name: `Largest file ${to}` }).waitFor();
            await page.locator('.set-row').filter({ has: largest }).getByText('Saved', { exact: true }).waitFor();
            await noSidewaysScroll(page, vp, 'Policy, changed');
            // the relay has them, for everyone in the Sphere
            const toBytes = Number.parseInt(to, 10) * 1048576;
            await until(async () => { const p = await world.policy(); return p.maxFilesPerMessage === was + 1 && p.maxFileBytes === toBytes; }, "the relay's policy to have both changes");

            await page.reload();
            await title(page, 'Policy').waitFor();
            await until(async () => (await files.getAttribute('aria-valuenow')) === String(was + 1), 'files per message after a reload');
            await page.getByRole('button', { name: `Largest file ${to}` }).waitFor();
            // and the audit log says who changed what
            await goTo(page, 'Audit log');
            await page.getByRole('textbox', { name: 'Search events' }).fill('files per message');
            await page.getByRole('region', { name: 'Events' }).getByRole('row').filter({ hasText: `files per message ${was} → ${was + 1} · by bob` }).waitFor();

            // Alice's Oby isn't an admin: her console has no Policy page, and the relay refuses a
            // change sent through her console all the same
            const hers = await open(`${alice.url}#mode=console&page=policy`);
            await title(hers, sphere.name).waitFor();
            assert.equal(await title(hers, 'Policy').count(), 0);
            assert.equal(await hasPage(hers, 'Policy'), false);
            const refused = await consolePost(alice.url, '/api/admin/policy', { maxFilesPerMessage: 42 });
            assert.equal(refused.status, 403, JSON.stringify(refused.body));
            assert.match(refused.body.error, /needs an admin/);
            assert.equal((await world.policy()).maxFilesPerMessage, was + 1, 'unchanged');
          });
        });

        test('Settings › Notifications: Send a test reaches a phone (ntfy) or Slack', EACH, async (t) => {
          // desktop: a phone's ntfy topic; phone: a Slack incoming webhook. Both are fakes on 127.0.0.1
          const way = vp.name === 'desktop' ? { field: 'Your phone', test: 'Send a test: your phone', path: '/obysphere-browser-topic' } : { field: 'Slack', test: 'Send a test: Slack', path: '/services/T000/B000/browserTestHook0123' };
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Settings');
            await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
            const address = page.getByRole('textbox', { name: way.field, exact: true });
            await address.fill(hooks.url + way.path);
            const sent = hooks.hits.length;
            await page.getByRole('button', { name: way.test, exact: true }).click();
            // what the test did is said under the address
            await page.getByRole('region', { name: 'Notifications' }).getByRole('status').getByText('Sent (summary).').waitFor();
            const hit = hooks.hits.slice(sent).find((h) => h.path === way.path);
            assert.ok(hit, `the fake ${way.field} got the test`);
            assert.ok((hit.headers.title || hit.body).includes('A test from your Obysphere'), JSON.stringify(hit));
            // kept on this machine whole; the page shows it masked
            await until(() => JSON.stringify(world.settings('alice').notify || {}).includes(hooks.url + way.path), 'settings.json to keep the address');
            await noSidewaysScroll(page, vp, 'Settings › Notifications');
            await page.reload();
            await until(async () => (await address.inputValue()).includes('…'), 'the address masked after a reload');
            assert.ok(!(await address.inputValue()).includes(way.path), await address.inputValue());
          });
        });

        test('Settings › GitHub: gh’s sign-in (a fake gh first on PATH), and the switch saved', EACH, async (t) => {
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Settings');
            const github = page.getByRole('region', { name: 'GitHub' });
            await github.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
            await github.getByText('As octo-bob, with gh’s sign-in.').waitFor();
            assert.ok(world.gh.calls().some((c) => c.argv.join(' ').startsWith('auth status')), 'asked the fake gh');
            const on = github.getByRole('switch', { name: 'Work on GitHub' });
            const was = (await on.getAttribute('aria-checked')) === 'true';
            await on.click();
            await until(() => world.settings('alice').github?.enabled === !was, 'settings.json to have GitHub turned ' + (was ? 'off' : 'on'));
            await noSidewaysScroll(page, vp, 'Settings › GitHub');
          });
        });
      });
    }
  });
}
