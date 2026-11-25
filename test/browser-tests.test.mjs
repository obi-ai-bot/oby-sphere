// The console (public/index.html) in a real browser: Chromium through Playwright, at desktop and
// phone width. A sealed Sphere and two members run on this machine; their Obys answer with fake
// runtimes (test/fake-runtimes.mjs), so no model and no network. Each flow also checks that the
// page logged no errors and that nothing scrolls sideways.
//
// Playwright is installed only for these tests, never as a dependency (CONTRIBUTING.md):
//   npm install --no-save playwright@<version in test/browser-helpers.mjs>
//   npx playwright install chromium
//   OBYSPHERE_BROWSER_TESTS=1 node --test test/browser-tests.test.mjs
// Without Playwright the file skips, saying why; with OBYSPHERE_BROWSER_TESTS=1 it fails instead,
// so CI can't skip it by accident.
//
// Next, with 0.3.0, each a few lines on these helpers (World, withPage, goTo, switchView):
// - direct messages: a member in the side panel opens your conversation with them;
// - channels: a new channel, and Obys invited to it;
// - admins: Policy only for admins, and the Admin access dialog;
// - Settings › Notifications, and the console's own notifications;
// - Settings › GitHub, and GitHub items in Waiting for you;
// - Invite member: the one text to copy.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PLAYWRIGHT_VERSION, VIEWPORTS, World, loadChromium, withPage, title, goTo, hasPage, switchView, noSidewaysScroll, until } from './browser-helpers.mjs';

const REQUIRED = process.env.OBYSPHERE_BROWSER_TESTS === '1';
const ANSWER = 'Here is my answer, from a fake runtime on this machine.';
const EACH = { timeout: 90000 }; // each flow; every wait inside it gives up sooner
const { browser, reason } = await loadChromium();

test('CI and CONTRIBUTING.md install the Playwright version these tests name', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.equal(/PLAYWRIGHT_VERSION: '([^']+)'/.exec(read('.github/workflows/ci.yml'))?.[1], PLAYWRIGHT_VERSION);
  assert.deepEqual([...read('CONTRIBUTING.md').matchAll(/playwright@(\S+)/g)].map((m) => m[1]), [PLAYWRIGHT_VERSION]);
});

if (!browser) {
  if (REQUIRED) test('the browser tests can run (OBYSPHERE_BROWSER_TESTS=1)', () => assert.fail(reason));
  else test('the console in a real browser', { skip: reason }, () => {});
} else {
  describe('the console in a real browser', () => {
    const world = new World();
    let sphere, alice;
    const run = (t, url, vp, fn) => withPage(browser, t, url, vp, fn).catch((e) => {
      e.message += `\n${world.logs()}`;
      throw e;
    });

    before(async () => {
      world.fake.control({ text: ANSWER });
      sphere = await world.startSphere();
      await world.join('alice', 'Alice Test', 'Knows the release notes');
      await world.join('bob', 'Bob Test', 'Knows the payments service');
      // Alice's Oby waits for her on asks from Bob (Waiting for you)
      world.editSettings('alice', (s) => (s.access.agents = { bob: 'approve' }));
      await world.serve('bob');
      alice = await world.console('alice', { serve: true });
    });
    after(async () => {
      await browser.close();
      await world.stop();
    });

    for (const vp of VIEWPORTS) {
      describe(`at ${vp.name} width (${vp.viewport.width}×${vp.viewport.height})`, () => {
        test("the Sphere's own page, opened with the join key, shows the Overview and reaches each page", EACH, async (t) => {
          await run(t, `${sphere.url}/#key=${encodeURIComponent(sphere.key)}`, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            await page.getByText('Agents run here').waitFor();
            await page.getByText('Live log').waitFor();
            await noSidewaysScroll(page, vp, 'Overview');
            // someone holding only the join key watches: no member's pages
            assert.equal(await hasPage(page, 'Your Oby'), false);
            assert.equal(await hasPage(page, 'Settings'), false);
            const pages = [
              ['Traffic', 'Traffic', /exchanges · \d+ in flight/],
              ['Members', 'Members', /Bob Test.s Oby/],
              ['Instruments', 'Instruments', 'sphere_ask'],
              ['Files', 'Files', /No files yet|files relayed/],
              ['Audit log', 'Audit log', /Chain verified/],
              ['Policy', 'Policy', 'Seal message contents'],
              ['Overview', sphere.name, 'Agents run here'],
            ];
            for (const [nav, heading, shows] of pages) {
              await goTo(page, nav);
              await title(page, heading).waitFor();
              await page.getByText(shows).first().waitFor();
              await noSidewaysScroll(page, vp, nav);
            }
          });
        });

        test("a member's console (rep.mjs ui) is signed in as them and shows Your Oby", EACH, async (t) => {
          await run(t, alice.url, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            await page.getByRole('button', { name: 'New exchange' }).waitFor();
            assert.equal(await hasPage(page, 'Settings'), true);
            await goTo(page, 'Your Oby');
            await title(page, 'Your Oby').waitFor();
            await page.getByText('@alice · represents Alice Test').waitFor();
            await page.getByText('Asked of your Oby').first().waitFor();
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
            await dialog.getByRole('textbox', { name: 'Message' }).fill(question);
            await noSidewaysScroll(page, vp, 'New exchange');
            await dialog.getByRole('button', { name: 'Send' }).click();
            // the exchange opens, then fills in when Bob's Oby answers on "his" machine
            await title(page, /^Exchange m_/).waitFor();
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
            await title(page, /^Exchange m_/).waitFor();
            await page.getByText(question).first().waitFor();
            await page.getByText(ANSWER).first().waitFor();
          });
        });

        test("Settings: a change saves, and it's still there after a reload", EACH, async (t) => {
          const topics = `salary, hiring, ${vp.name} roadmap`;
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Settings');
            await title(page, 'Settings').waitFor();
            const box = page.getByRole('textbox', { name: 'Decline asks about' });
            const sendFiles = page.getByRole('switch', { name: 'Send files back' });
            const wasOn = (await sendFiles.getAttribute('aria-checked')) === 'true';
            await box.fill(topics);
            await sendFiles.click();
            await page.getByText('Saved', { exact: true }).waitFor();
            // kept where rep.mjs keeps it
            await until(() => {
              const a = world.settings('alice').access;
              return a.declineTopics.join(', ') === topics && a.sendFiles === !wasOn;
            }, 'settings.json to have the change');
            await noSidewaysScroll(page, vp, 'Settings');

            await page.reload();
            await title(page, 'Settings').waitFor();
            await until(async () => (await box.inputValue()) === topics, 'the topics after a reload');
            assert.equal(await sendFiles.getAttribute('aria-checked'), String(!wasOn));
          });
        });

        test('Waiting for you: an ask held for approval is let through, and another declined', EACH, async (t) => {
          const yes = `Could you summarise the release notes? (${vp.name}, let through)`;
          const no = `Could you share the launch date? (${vp.name}, declined)`;
          await run(t, alice.url, vp, async (page) => {
            await goTo(page, 'Your Oby');
            await title(page, 'Your Oby').waitFor();
            const askYes = world.repInBackground(['ask', 'alice', yes, '--profile', 'bob', '--wait', '60']);
            const askNo = world.repInBackground(['ask', 'alice', no, '--profile', 'bob', '--wait', '60']);
            const card = (text) => page.locator('[data-pending]').filter({ hasText: text });

            await page.getByRole('heading', { name: /^Waiting for you/ }).waitFor();
            await card(yes).getByText(/Bob Test.s Oby asks/).waitFor();
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
            assert.equal(world.fake.calls().length, runs, 'no runtime ran for the declined ask');
          });
        });

        test('Conversation: a posted message shows in the thread', EACH, async (t) => {
          const mine = `The release notes are out. (${vp.name})`;
          const his = `Thanks, reading them now. (${vp.name})`;
          await run(t, alice.url, vp, async (page) => {
            await title(page, sphere.name).waitFor();
            await switchView(page, 'Conversation');
            const thread = page.getByRole('log');
            await thread.waitFor();
            // to everyone in #general, not to an Oby in particular
            await page.getByRole('button', { name: 'Ask no one in particular' }).click();
            await page.getByRole('textbox', { name: 'Message' }).fill(mine);
            await page.getByRole('button', { name: 'Send' }).click();
            await thread.getByText(mine).waitFor();
            // and someone else's post arrives while the page is open
            const r = await world.rep(['post', his, '--profile', 'bob']);
            assert.match(r.out, /Posted in #general/, r.out);
            await thread.getByText(his).waitFor();
            await noSidewaysScroll(page, vp, 'Conversation');
          });
        });
      });
    }
  });
}
