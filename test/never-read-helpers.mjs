// Helpers for test/never-read.test.mjs: rep.mjs's deny-list and never-read sections, evaluated
// from its source (it has no exports), and a proxy that sits between a representative and its
// relay and keeps every request it passes on, so a test can say what reached the relay.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// SECRET_FILES and friends, and the never-read functions, as rep.mjs writes them. HOME: the
// profiles folder SECRET_DENY names.
export function repSections(home = '/home/sam/.obysphere') {
  const src = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
  const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error(`rep.mjs has no ${what}`);
    return m[0];
  };
  const section = (name) => grab(new RegExp(`^// ===== ${name}[\\s\\S]*?^// ===== end of ${name}$`, 'm'), `${name} section`);
  const consts = ['SECRET_DENY', 'SECRETISH', 'SECRET_GLOBS'].map((n) => grab(new RegExp(`^const ${n} = [\\s\\S]*?;(?: *//.*)?$`, 'm'), n));
  return new Function(
    'path',
    'HOME',
    `${section('deny-list')}\n${consts.join('\n')}\n${section('never-read')}
return { SECRET_FILES, SECRET_DENY, SECRETISH, SECRET_GLOBS, denyListForms, neverReadForms, validateNeverRead, neverReadProblem, NEVER_READ_MAX, NEVER_READ_LEN, NEVER_READ_STARS };`,
  )(path, home);
}

// An HTTP proxy to `target` on 127.0.0.1 that keeps { method, url, body } of every request.
// Streams (server-sent events) pass through as they come.
export function recordingProxy(target) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, body: body.toString('utf8'), at: Date.now() });
      const up = http.request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => up.destroy());
      up.end(body);
    });
  });
  return {
    seen,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
