// Fakes for the obysphere CLI's tests: no network beyond this machine, no real Vercel.
//   startFakeGitHub()   the releases API and the downloads, on 127.0.0.1: set `release` to
//                       { tag, assets: { name: bytes } } (or null for "no release yet"), `main` to
//                       a tarball; `requests` lists every path asked for; `hook(url, req, res)`,
//                       when set, answers first (a redirect, an endless body) and returns true
//   buildApp(dir, v)    a tarball of this app (the files an install needs), with package.json at
//                       version v, made with the system's tar
//   makeFakeVercel(dir) a `vercel` on PATH that records each call (argv, folder, the files in it,
//                       stdin) to calls.jsonl and keeps its project's variables in state.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function startFakeGitHub() {
  const gh = { release: null, main: null, requests: [], hook: null };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    gh.requests.push(u.pathname);
    if (gh.hook?.(u, req, res)) return;
    const send = (status, body, type = 'application/octet-stream') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (u.pathname === '/api/releases/latest') return gh.release ? send(200, JSON.stringify({ tag_name: gh.release.tag, name: gh.release.tag }), 'application/json') : send(404, '{"message":"Not Found"}', 'application/json');
    const m = /^\/dl\/releases\/download\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m && gh.release?.tag === m[1] && gh.release.assets[m[2]]) return send(200, gh.release.assets[m[2]]);
    if (u.pathname === '/dl/archive/refs/heads/main.tar.gz' && gh.main) return send(200, gh.main);
    send(404, 'not found', 'text/plain');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve(Object.assign(gh, { api: `${base}/api`, download: `${base}/dl`, close: () => server.close() }));
    }),
  );
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// a release as GitHub serves it: the tarball and its SHA256SUMS (or a wrong one)
export function release(version, bytes, { badSum = false, noLine = false } = {}) {
  const file = `obysphere-${version}.tar.gz`;
  const sum = badSum ? sha256(Buffer.from('something else')) : sha256(bytes);
  return { tag: `v${version}`, assets: { [file]: bytes, SHA256SUMS: Buffer.from(noLine ? `${sum}  other.tar.gz\n` : `${sum}  ${file}\n`) } };
}

export function buildApp(work, version, { prefix = `obysphere-${version}` } = {}) {
  const top = path.join(work, prefix);
  fs.rmSync(top, { recursive: true, force: true });
  for (const f of ['obysphere.mjs', 'rep.mjs', 'server.mjs', 'public/index.html', 'public/favicon.svg', 'vercel.json', '.vercelignore', 'api/sphere.mjs', 'install.sh']) {
    fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(top, f));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n');
  fs.chmodSync(path.join(top, 'obysphere.mjs'), 0o755);
  const out = path.join(work, `${prefix}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', work, prefix]);
  if (r.status !== 0) throw new Error('tar failed: ' + r.stderr);
  return fs.readFileSync(out);
}

const FAKE_VERCEL = `
const fs = require('fs'), path = require('path');
const here = __dirname, argv = process.argv.slice(2);
const stateFile = path.join(here, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const files = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(dir, path.join(rel, d.name)) : [path.join(rel, d.name)]));
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), files: files(process.cwd()).sort(), stdin }) + '\\n');
  if (argv[0] === 'link') {
    fs.mkdirSync('.vercel', { recursive: true });
    fs.writeFileSync('.vercel/project.json', JSON.stringify({ projectId: 'prj_fake', orgId: 'team_fake', projectName: argv[argv.indexOf('--project') + 1] }));
    process.stderr.write('Linked to fake/project\\n');
  } else if (argv[0] === 'env' && argv[1] === 'ls') {
    const names = [...Object.keys(state.env), ...(state.redis ? ['KV_REST_API_URL', 'KV_REST_API_TOKEN'] : [])];
    process.stdout.write(' name               value               environments        created\\n' + names.map((n) => ' ' + n + '               Encrypted           Production          1d ago').join('\\n') + '\\n');
  } else if (argv[0] === 'env' && argv[1] === 'add') {
    state.env[argv[2]] = stdin;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    process.stderr.write('Added Environment Variable ' + argv[2] + '\\n');
  } else if (argv[0] === 'deploy') {
    process.stderr.write('Production: ' + state.deployment + ' [2s]\\nAliased: ' + state.url + ' [2s]\\n');
    process.stdout.write(state.deployment + '\\n');
  } else process.exit(2);
});
`;

export function makeFakeVercel(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vercel.cjs'), FAKE_VERCEL);
  fs.writeFileSync(path.join(dir, 'vercel'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'vercel.cjs')}' "$@"\n`, { mode: 0o755 });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ env: {}, redis: false, ...state }));
  return {
    dir,
    state: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set: (patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch })),
    calls: () => {
      try {
        return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
