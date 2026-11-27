// What deleting costs the store, and logs damaged at their end (second security audit, R8 and R36):
// on the fs store, deletes in a row rewrite messages.jsonl at most once every few seconds, and the
// words still leave the disk (at a restart too, after a crash in between); on Redis, deletions of
// messages already in the snapshot compact at once, then at most once a minute; and a log whose
// last line is whole but lacks its newline gets one before anything is appended. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, tempDir, members, until, sleep } from './relay-hardening-helpers.mjs';

const folderText = (dir) => {
  let all = '';
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else all += fs.readFileSync(p).toString('latin1') + '\n';
    }
  };
  walk(dir);
  return all;
};

test('on the fs store, deletes in a row rewrite messages.jsonl at most once every few seconds, and the words still leave the disk', async () => {
  const T = tempDir('hardening-store-fs');
  const procs = new Set();
  try {
    const data = path.join(T.dir, 'd');
    let R = await relay({ SPHERE_DATA: data, SPHERE_WRITES_PER_MIN: '100000' }, { tmp: T.dir, procs });
    const { alice } = await members(R.base, ['alice']);
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: `the WREN-${i}X note` } })).message.id);
    const file = path.join(data, 'messages.jsonl');
    let ino = fs.statSync(file).ino;
    let rewrites = 0;
    for (let i = 0; i < 10; i++) {
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${ids[i]}`, { token: alice.token })).status, 200);
      const now = fs.statSync(file).ino;
      if (now !== ino) rewrites++;
      ino = now;
    }
    assert.ok(rewrites <= 2, `${rewrites} rewrites of messages.jsonl for 10 deletes`);
    const gone = (text) => ![...Array(10).keys()].some((i) => text.includes(`WREN-${i}X`));
    assert.ok(await until(() => gone(folderText(data)), 10000), 'the words leave the disk within a few seconds');
    assert.ok(folderText(data).includes('WREN-15X'), 'the others stay');

    // a crash before the rewrite: the next start rewrites it
    for (let i = 10; i < 14; i++) assert.equal((await call(R.base, 'DELETE', `/api/messages/${ids[i]}`, { token: alice.token })).status, 200);
    process.kill(R.pid, 'SIGKILL');
    await R.exited;
    R = await relay({ SPHERE_DATA: data }, { tmp: T.dir, procs });
    const text = fs.readFileSync(file, 'latin1');
    for (let i = 10; i < 14; i++) assert.ok(!text.includes(`WREN-${i}X`), `WREN-${i}X left messages.jsonl at start`);
    const held = (await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
    assert.ok(held.find((x) => x.id === ids[12])?.deleted, 'a tombstone in its place');
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
    await R.stop();
  } finally {
    [...procs].forEach((p) => p.kill());
    T.remove();
  }
});

test('on Redis, deletions of messages in the snapshot compact at once, then at most once a minute', async () => {
  const T = tempDir('hardening-store-redis');
  const procs = new Set();
  const fake = await startFakeUpstash();
  const prefix = 'deletes:';
  const env = { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_COMPACT_WAIT_MS: '0', SPHERE_WRITES_PER_MIN: '100000' };
  const snapId = () => {
    try {
      return JSON.parse(fake.kv.get(prefix + 'snap')?.v).id;
    } catch {
      return null;
    }
  };
  const snapText = () => fake.kv.get(prefix + 'snap:' + snapId())?.v.join('\n') || '';
  try {
    // a compaction folds the messages into the snapshot
    const A = await relay({ ...env, SPHERE_COMPACT_EVERY: '5' }, { tmp: T.dir, procs });
    const { alice } = await members(A.base, ['alice']);
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await call(A.base, 'POST', '/api/messages', { token: alice.token, body: { text: `the LARK-${i}X note` } })).message.id);
    for (let i = 0; i < 80 && !snapText().includes('LARK-11X'); i++) {
      await call(A.base, 'POST', '/api/messages', { token: alice.token, body: { text: `more ${i}` } });
      await sleep(30);
    }
    assert.ok(await until(() => snapText().includes('LARK-11X')), 'in the snapshot');
    await A.stop();
    // another instance, compacting only when it must, deletes them one by one
    const B = await relay({ ...env, SPHERE_COMPACT_EVERY: '100000' }, { tmp: T.dir, procs });
    const seen = new Set([snapId()]);
    assert.equal((await call(B.base, 'DELETE', `/api/messages/${ids[0]}`, { token: alice.token })).status, 200);
    assert.ok(await until(async () => (await call(B.base, 'GET', '/api/info', { token: alice.token }), !snapText().includes('LARK-0X'))), 'the first leaves the snapshot at once');
    seen.add(snapId());
    for (let i = 1; i < 8; i++) {
      assert.equal((await call(B.base, 'DELETE', `/api/messages/${ids[i]}`, { token: alice.token })).status, 200);
      for (let k = 0; k < 4; k++) {
        await sleep(150);
        await call(B.base, 'GET', '/api/info', { token: alice.token });
      }
      seen.add(snapId());
    }
    assert.ok(seen.size <= 2, `${seen.size - 1} compactions for 8 deletions`);
    assert.equal((await call(B.base, 'GET', '/api/audit', { key: KEY })).verified, true);
    await B.stop();
  } finally {
    [...procs].forEach((p) => p.kill());
    await fake.close();
    T.remove();
  }
});

test('a log whose last line lacks its newline gets one before the next append', async () => {
  const T = tempDir('hardening-store-newline');
  const procs = new Set();
  try {
    const data = path.join(T.dir, 'd');
    let R = await relay({ SPHERE_DATA: data }, { tmp: T.dir, procs });
    const { alice } = await members(R.base, ['alice']);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'first' } })).status, 200);
    await R.stop();
    // a crash: the last "\n" never reached the disk
    for (const f of ['audit.jsonl', 'messages.jsonl']) {
      const p = path.join(data, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n$/, ''));
    }
    R = await relay({ SPHERE_DATA: data }, { tmp: T.dir, procs });
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'second' } })).status, 200);
    await R.stop();
    R = await relay({ SPHERE_DATA: data }, { tmp: T.dir, procs });
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true, 'the chain still verifies');
    const texts = (await call(R.base, 'GET', '/api/messages', { key: KEY })).messages.map((x) => x.text);
    assert.ok(texts.includes('first') && texts.includes('second'), texts.join(' / '));
    await R.stop();
  } finally {
    [...procs].forEach((p) => p.kill());
    T.remove();
  }
});
