// A small stand-in for Upstash's Redis REST API, for tests: the commands the
// relay uses, single (POST /) and pipelined (POST /pipeline), with bearer auth.
// EVAL runs the relay's own scripts, recognised by their first line, in JS: each
// runs to its end before the next command, so they're atomic here as in Redis.
//   node test/fake-upstash.mjs [port] [token]     (or import { startFakeUpstash })
import http from 'node:http';

export function startFakeUpstash({ port = 0, token = 'fake-token', latencyMs = 0, down = false } = {}) {
  const kv = new Map(); // key -> { v, exp }
  let isDown = down; // while down, every connection is dropped: a network error, as on a blip
  const live = (k) => {
    const e = kv.get(k);
    if (e && e.exp && e.exp <= Date.now()) {
      kv.delete(k);
      return undefined;
    }
    return e;
  };
  const get = (k, type) => {
    const e = live(k);
    if (!e) return undefined;
    if (type && e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e;
  };
  const list = (k) => get(k, 'list')?.v ?? [];
  const zset = (k) => get(k, 'zset')?.v ?? new Map();
  const range = (len, a, b) => {
    a = Number(a);
    b = Number(b);
    if (a < 0) a = Math.max(0, len + a);
    if (b < 0) b = len + b;
    return [a, Math.min(b, len - 1)];
  };
  const score = (s) => (s === '+inf' ? Infinity : s === '-inf' ? -Infinity : Number(s));
  let commands = 0;

  const run = (cmd, inner = false) => {
    if (!inner) commands++; // a script's own calls are part of the one EVAL
    const [name, ...a] = cmd.map(String);
    switch (name.toUpperCase()) {
      case 'PING':
        return 'PONG';
      case 'GET':
        return get(a[0], 'string')?.v ?? null;
      case 'SET': {
        const opts = a.slice(2).map((x) => x.toUpperCase());
        if (opts.includes('NX') && live(a[0])) return null;
        const ex = opts.indexOf('EX');
        kv.set(a[0], { type: 'string', v: a[1], exp: ex >= 0 ? Date.now() + Number(a[2 + ex + 1]) * 1000 : 0 });
        return 'OK';
      }
      case 'DEL':
        return a.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0);
      case 'EXISTS':
        return a.reduce((n, k) => n + (live(k) ? 1 : 0), 0);
      case 'PERSIST': {
        const e = live(a[0]);
        if (!e || !e.exp) return 0;
        e.exp = 0;
        return 1;
      }
      case 'RENAME': {
        const e = live(a[0]);
        if (!e) throw new Error('ERR no such key');
        kv.delete(a[0]);
        kv.set(a[1], e);
        return 'OK';
      }
      case 'INCR': {
        const e = get(a[0], 'string');
        const n = Number(e?.v ?? 0) + 1;
        kv.set(a[0], { type: 'string', v: String(n), exp: e?.exp ?? 0 });
        return n;
      }
      case 'EXPIRE': {
        const e = live(a[0]);
        if (!e) return 0;
        e.exp = Date.now() + Number(a[1]) * 1000;
        return 1;
      }
      case 'LLEN':
        return list(a[0]).length;
      case 'RPUSH': {
        const l = list(a[0]);
        l.push(...a.slice(1));
        kv.set(a[0], { type: 'list', v: l, exp: live(a[0])?.exp ?? 0 }); // as in Redis, a push keeps the key's expiry
        return l.length;
      }
      case 'LRANGE': {
        const l = list(a[0]);
        const [s, e] = range(l.length, a[1], a[2]);
        return s > e ? [] : l.slice(s, e + 1);
      }
      case 'LTRIM': {
        const e0 = get(a[0], 'list');
        if (!e0) return 'OK';
        const [s, e] = range(e0.v.length, a[1], a[2]);
        e0.v = s > e ? [] : e0.v.slice(s, e + 1);
        if (!e0.v.length) kv.delete(a[0]); // Redis drops an empty list
        return 'OK';
      }
      case 'ZADD': {
        const z = zset(a[0]);
        let added = 0;
        for (let i = 1; i + 1 < a.length; i += 2) {
          if (!z.has(a[i + 1])) added++;
          z.set(a[i + 1], Number(a[i]));
        }
        kv.set(a[0], { type: 'zset', v: z, exp: 0 });
        return added;
      }
      case 'ZREM': {
        const z = zset(a[0]);
        return a.slice(1).reduce((n, m) => n + (z.delete(m) ? 1 : 0), 0);
      }
      case 'ZRANGEBYSCORE': {
        const lo = score(a[1]);
        const hi = score(a[2]);
        return [...zset(a[0])].filter(([, s]) => s >= lo && s <= hi).sort((x, y) => x[1] - y[1]).map(([m]) => m);
      }
      case 'ZREMRANGEBYSCORE': {
        const z = zset(a[0]);
        const lo = score(a[1]);
        const hi = score(a[2]);
        let n = 0;
        for (const [m, s] of z) if (s >= lo && s <= hi && z.delete(m)) n++;
        return n;
      }
      case 'EVAL': {
        const [script, numkeys, ...rest] = a;
        const keys = rest.slice(0, Number(numkeys));
        const argv = rest.slice(Number(numkeys));
        // the log: KEYS log, base, tail (as 0.3 and before, KEYS log alone). Once base exists, the
        // log was compacted: it's the tail list, at positions from base, and the old key holds a string.
        const moved = keys.length >= 3 && !!live(keys[1]);
        const logKey = moved ? keys[2] : keys[0];
        const base = moved ? Number(get(keys[1], 'string').v) : 0;
        if (script.startsWith('-- obysphere:append')) {
          // compare-and-append, at base + the list's length
          const l = list(logKey);
          const n = base + l.length;
          if (n !== Number(argv[0])) return -1;
          run(['RPUSH', logKey, ...argv.slice(1)], true);
          return keys.length >= 3 ? n + argv.length - 1 : list(logKey).length;
        }
        if (script.startsWith('-- obysphere:read')) {
          const from = Number(argv[0]) - base;
          if (from < 0) return [base];
          return [base, run(['LRANGE', logKey, from, from + Number(argv[1]) - 1], true)];
        }
        if (script.startsWith('-- obysphere:compact')) {
          // KEYS log, base, tail, pointer, old snapshot list, new snapshot list;
          // ARGV pointer expected, position, new pointer, new count, what the old log key says once moved
          if ((get(keys[3], 'string')?.v ?? '') !== argv[0]) return -1;
          const pos = Number(argv[1]);
          const len = list(logKey).length;
          if (pos < base || pos > base + len) return -2;
          if (list(keys[5]).length !== Number(argv[3])) return -3;
          let at = logKey;
          if (!moved) {
            if (len > 0) run(['RENAME', keys[0], keys[2]], true);
            run(['SET', keys[0], argv[4]], true);
            at = keys[2];
          }
          run(['LTRIM', at, pos - base, -1], true);
          run(['SET', keys[1], String(pos)], true);
          run(['SET', keys[3], argv[2]], true);
          run(['PERSIST', keys[5]], true);
          if (keys[4] !== keys[5]) run(['EXPIRE', keys[4], 900], true);
          return pos;
        }
        throw new Error('ERR this fake runs only the relay\'s own scripts');
      }
      default:
        throw new Error(`ERR unknown command '${name}'`);
    }
  };

  const server = http.createServer((req, res) => {
    if (isDown) return req.socket.destroy();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (latencyMs) await new Promise((r) => setTimeout(r, Math.random() * latencyMs));
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Unauthorized' });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'ERR invalid JSON' });
      }
      const one = (cmd) => {
        try {
          return { result: run(cmd) };
        } catch (e) {
          return { error: e.message };
        }
      };
      if (req.url === '/pipeline') return reply(200, body.map(one));
      const r = one(body);
      return reply(r.error ? 400 : 200, r);
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        token,
        kv,
        commands: () => commands,
        setDown: (v) => { isDown = !!v; },
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFakeUpstash({ port: Number(process.argv[2]) || 8079, token: process.argv[3] || 'fake-token' });
  console.log(`fake Upstash at ${f.url} (token ${f.token})`);
}
