// A hostile relay for tests: a small HTTP proxy in front of a real server.mjs. Members join
// through it (their invite link names it), so everything they send and read passes here, and a
// test can lie to them the way a relay turned hostile could: rewrite what the relay answers,
// answer a request itself, put events of its own in the live stream, or drop the relay's.
//
//   const h = await startHostileRelay('http://127.0.0.1:<relay port>');
//   h.json = (url, body, req) => body2 | undefined     rewrite a JSON answer (undefined: as it came)
//   h.request = async (req, url, body) => ({ status, json } | { status, raw }) | undefined     answer it here
//   h.event = (ev, data) => data2 | null | undefined   rewrite a live event (null: dropped)
//   h.inject('message', {...})                          a live event of its own, to every stream
//   h.posts                                             every POST /api/messages body that went through
//   await h.close()
import http from 'node:http';

export async function startHostileRelay(target) {
  const streams = new Set();
  const h = {
    url: '',
    json: null,
    request: null,
    event: null,
    posts: [],
    inject(ev, data) {
      for (const res of streams) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    streams: () => streams.size,
    close: () =>
      new Promise((resolve) => {
        for (const res of streams) res.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  const send = (res, status, json) => {
    const body = JSON.stringify(json);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        try {
          h.posts.push(JSON.parse(body.toString('utf8')));
        } catch {}
      }
      const mine = h.request && (await h.request(req, url, body));
      if (mine?.raw) {
        res.writeHead(mine.status ?? 200, { 'content-type': 'application/octet-stream', 'content-length': mine.raw.length });
        return res.end(mine.raw);
      }
      if (mine) return send(res, mine.status ?? 200, mine.json ?? {});
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = v;
      const r = await fetch(target + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
      const type = r.headers.get('content-type') || '';
      if (/^text\/event-stream/.test(type) && r.body) {
        res.writeHead(r.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        streams.add(res);
        res.on('close', () => streams.delete(res));
        const dec = new TextDecoder();
        let buf = '';
        try {
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: (\S+)/m.exec(block)?.[1];
              const line = block.split('\n').find((l) => l.startsWith('data: '));
              if (h.event && ev && line) {
                let data;
                try {
                  data = JSON.parse(line.slice(6));
                } catch {
                  res.write(block + '\n\n');
                  continue;
                }
                const out = h.event(ev, data);
                if (out === null) continue;
                res.write(`event: ${ev}\ndata: ${JSON.stringify(out === undefined ? data : out)}\n\n`);
              } else res.write(block + '\n\n');
            }
          }
        } catch {}
        return res.end();
      }
      if (/^application\/json/.test(type)) {
        let j = await r.json().catch(() => null);
        if (j && h.json) {
          const out = h.json(url, j, req);
          if (out !== undefined) j = out;
        }
        return send(res, r.status, j ?? {});
      }
      const out = {};
      for (const k of ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options', 'content-security-policy', 'x-content-sha256']) {
        const v = r.headers.get(k);
        if (v) out[k] = v;
      }
      const bytes = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { ...out, 'content-length': bytes.length });
      res.end(bytes);
    } catch (e) {
      if (!res.headersSent) send(res, 502, { error: `hostile relay: ${e.message}`, code: 'proxy' });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.url = `http://127.0.0.1:${server.address().port}`;
  return h;
}
