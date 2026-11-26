// The Docker image (#133). The release workflow builds and pushes ghcr.io/obi-ai-bot/oby-sphere
// for linux/amd64 and linux/arm64 on a v* tag only, with OCI labels, and no :latest for a
// pre-release; CI still only builds and checks it. `obysphere server update` updates a Sphere
// that runs in Docker here: with a fake docker first on PATH that records its arguments, it pulls
// the right tag and runs the container again with the same name, ports, volume, variables and
// the rest; no key reaches an argument, docker's environment or what it prints; the old
// container comes back when the new one fails; and what it can't carry over is refused before
// anything changes. No Docker and no network beyond this machine: every folder is a temp
// folder. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeDocker, settingsOf, parseYaml } from './docker-image-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.join(HERE, '..'));
const CLI = path.join(ROOT, 'obysphere.mjs');
const IMAGE = 'ghcr.io/obi-ai-bot/oby-sphere';
const KEY = 'join-key-docker-tests-0123456789';
const ADMIN = 'admin-key-docker-tests-0123456789';
const POSIX = process.platform !== 'win32';
const roots = [];
let health;
let healthPort;

const tmp = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-docker-test-${name}-`)));
  roots.push(d);
  return d;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const secretsIn = (s) => String(s).includes(KEY) || String(s).includes(ADMIN);

// ---------------------------------------------------------------- images and containers

const HEALTHCHECK = { Test: ['CMD-SHELL', 'wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1'], Interval: 30e9, Timeout: 3e9 };
const baseEnv = (node) => ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `NODE_VERSION=${node}`, 'YARN_VERSION=1.22.22', 'NODE_ENV=production', 'HOST=0.0.0.0', 'PORT=8080', 'SPHERE_DATA=/data', 'SPHERE_SEALED=1'];
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
// built from this repository's Dockerfile, as the old steps said: no labels
const LOCAL = { Id: sha('local'), RepoTags: ['obysphere:latest'], Config: { Env: baseEnv('22.11.0'), Cmd: null, Entrypoint: ['./docker-entrypoint.sh'], WorkingDir: '/app', User: '', Healthcheck: HEALTHCHECK, Labels: null } };
// published by the release workflow, with its OCI labels
const published = (version) => ({
  Id: sha(version),
  RepoTags: [`${IMAGE}:${version}`],
  Config: {
    Env: baseEnv('22.12.0'),
    Cmd: null,
    Entrypoint: ['./docker-entrypoint.sh'],
    WorkingDir: '/app',
    User: '',
    Healthcheck: HEALTHCHECK,
    Labels: { 'org.opencontainers.image.source': 'https://github.com/obi-ai-bot/oby-sphere', 'org.opencontainers.image.version': version, 'org.opencontainers.image.revision': 'f'.repeat(40), 'org.opencontainers.image.licenses': 'Apache-2.0' },
  },
});
const REGISTRY = { [`${IMAGE}:0.4.0`]: published('0.4.0'), [`${IMAGE}:0.4.1`]: published('0.4.1') };

// a Sphere run by hand, as the docs say, with a few hardening flags and limits on top
function sphereContainer({ image = LOCAL, ref = 'obysphere', env = [], labels = {}, host = {}, config = {}, mounts, running = true } = {}) {
  const id = createHash('sha256').update(`container-${ref}`).digest('hex');
  return {
    Id: id,
    Name: '/obysphere',
    Image: image.Id,
    Config: {
      Image: ref,
      Hostname: id.slice(0, 12),
      User: '',
      Env: [...image.Config.Env, `SPHERE_KEY=${KEY}`, `SPHERE_ADMIN_KEY=${ADMIN}`, 'SPHERE_NAME=Our Sphere', 'SPHERE_TRUST_PROXY=1', ...env],
      Cmd: image.Config.Cmd,
      Entrypoint: image.Config.Entrypoint,
      WorkingDir: image.Config.WorkingDir,
      Healthcheck: image.Config.Healthcheck,
      Labels: { ...(image.Config.Labels || {}), 'traefik.enable': 'true', 'traefik.http.routers.sphere.rule': 'Host(`sphere.example.com`)', ...labels },
      ...config,
    },
    HostConfig: {
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(healthPort) }] },
      PublishAllPorts: false,
      NetworkMode: 'bridge',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Init: null,
      CapAdd: ['CHOWN', 'SETUID', 'SETGID'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ExtraHosts: [],
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 8192 }],
      Memory: 268435456,
      MemorySwap: 536870912,
      NanoCpus: 500000000,
      Runtime: 'runc',
      LogConfig: { Type: 'json-file', Config: { 'max-file': '3', 'max-size': '10m' } },
      IpcMode: 'private',
      ...host,
    },
    Mounts: mounts ?? [{ Type: 'volume', Name: 'obysphere-data', Source: '/var/lib/docker/volumes/obysphere-data/_data', Destination: '/data', RW: true }],
    NetworkSettings: { Networks: { bridge: {} } },
    State: running ? { Status: 'running', Running: true, Restarting: false, ExitCode: 0 } : { Status: 'exited', Running: false, Restarting: false, ExitCode: 0 },
  };
}

// ---------------------------------------------------------------- a machine, in temp folders

// the installed app: <app>/<version>/ with `current` pointing at it, as `obysphere update` leaves it
function appAt(app, version) {
  const dir = path.join(app, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'obysphere', version }));
  fs.writeFileSync(path.join(dir, 'server.mjs'), '// a stand-in\n');
  fs.rmSync(path.join(app, 'current'), { force: true });
  fs.symlinkSync(version, path.join(app, 'current'));
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => p.kill(), 60000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, out: stdout + stderr });
    });
  });
}

// its own home, app and temp folders, a fake docker first on PATH, and the Sphere's keys in the
// environment, where docker must never get them
function machine(name, { installed = '0.4.0', containers, images = { 'obysphere:latest': LOCAL }, registry = REGISTRY } = {}) {
  const home = tmp(name);
  const app = path.join(home, 'app');
  appAt(app, installed);
  const temp = path.join(home, 'tmp');
  fs.mkdirSync(temp);
  const docker = makeFakeDocker(path.join(home, 'fakebin'), { containers: containers ?? { obysphere: sphereContainer() }, images, registry });
  const env = {
    PATH: `${docker.dir}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    TMPDIR: temp,
    LANG: 'C',
    OBYSPHERE_HOME: path.join(home, 'profiles'),
    OBYSPHERE_APP_HOME: app,
    OBYSPHERE_BIN_DIR: path.join(home, 'bin'),
    OBYSPHERE_SERVICE_DIR: path.join(home, 'services'),
    OBYSPHERE_SERVICE_DRYRUN: '1',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
    OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl',
    SPHERE_KEY: KEY,
    SPHERE_ADMIN_KEY: ADMIN,
    OBYSPHERE_ADMIN_KEY: ADMIN,
  };
  return {
    home,
    app,
    temp,
    docker,
    env,
    cli: (args) => run(args, env),
    recordFile: (n) => path.join(app, 'servers', `${n}.json`),
    leftovers: () => fs.readdirSync(temp).filter((f) => f.startsWith('obysphere-docker-')),
  };
}

const verb = (c) => (c.argv[0] === 'container' || c.argv[0] === 'image' ? c.argv.slice(0, 2).join(' ') : c.argv[0]);
const CHANGES = new Set(['pull', 'rename', 'stop', 'start', 'run', 'rm']);

// no key in any argument, in docker's environment, in what the command printed, or left on disk
function assertNoKeys(m, r) {
  for (const c of m.docker.calls()) {
    assert.ok(!secretsIn(JSON.stringify(c.argv)), `no key in: docker ${c.argv.join(' ')}`);
    assert.deepEqual(c.envKeys, [], `docker ${c.argv[0]} got none of the Sphere's variables`);
  }
  assert.ok(!secretsIn(r.out), `no key printed:\n${r.out}`);
  assert.deepEqual(m.leftovers(), [], 'the env file is gone');
}

before(async () => {
  // the Sphere's /healthz, at the port the containers publish
  health = http.createServer((q, s) => {
    if (q.url !== '/healthz') return s.writeHead(404).end();
    s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: '0.4.0', store: 'fs', sealed: true }));
  });
  await new Promise((r) => health.listen(0, '127.0.0.1', r));
  healthPort = health.address().port;
});

after(async () => {
  await new Promise((r) => (health ? health.close(r) : r()));
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- obysphere server update, in Docker

describe('obysphere server update for a Sphere in Docker', { skip: !POSIX && 'the fake docker is a shell script' }, () => {
  test('it pulls the release, runs the container again the same way, and records it without secrets', async () => {
    const m = machine('update');
    const before = m.docker.state().containers.obysphere;
    const r = await m.cli(['server', 'update', '--docker', 'obysphere']);
    assert.equal(r.code, 0, r.out);

    const calls = m.docker.calls();
    assert.deepEqual(calls.filter((c) => c.argv[0] === 'pull').map((c) => c.argv.at(-1)), [`${IMAGE}:0.4.0`], 'the installed version, from GitHub Container Registry');
    assert.deepEqual(calls.map(verb), ['container inspect', 'image inspect', 'container inspect', 'pull', 'image inspect', 'rename', 'stop', 'run', 'container inspect', 'rm']);
    assert.deepEqual(calls.find((c) => c.argv[0] === 'rename').argv, ['rename', 'obysphere', 'obysphere-previous']);
    assert.deepEqual(calls.find((c) => c.argv[0] === 'rm').argv, ['rm', 'obysphere-previous'], 'the old one goes once the new one answers');

    const runCall = calls.find((c) => c.argv[0] === 'run');
    assert.ok(runCall.argv.includes(`${IMAGE}:0.4.0`));
    assert.equal(runCall.argv[runCall.argv.indexOf('--name') + 1], 'obysphere', 'the same name');
    assert.equal(runCall.envFile.mode, 0o600, 'the variables are in a file only you can read');
    assert.ok(runCall.envFile.path.startsWith(m.temp + path.sep));
    assert.deepEqual([...runCall.envFile.lines].sort(), [`SPHERE_ADMIN_KEY=${ADMIN}`, `SPHERE_KEY=${KEY}`, 'SPHERE_NAME=Our Sphere', 'SPHERE_TRUST_PROXY=1'], "its own variables, not the old image's");
    assert.equal(runCall.labelFile.mode, 0o600);
    assert.ok(!fs.existsSync(runCall.envFile.path) && !fs.existsSync(runCall.labelFile.path), 'both files are removed');
    assertNoKeys(m, r);

    const s = m.docker.state();
    assert.deepEqual(Object.keys(s.containers), ['obysphere']);
    const now = s.containers.obysphere;
    assert.equal(now.Image, published('0.4.0').Id);
    assert.equal(now.State.Running, true);
    assert.deepEqual(settingsOf(now, published('0.4.0')), settingsOf(before, LOCAL), 'the same ports, volume, variables, labels, restart policy, limits and logs');
    assert.ok(now.Config.Env.includes('NODE_VERSION=22.12.0'), "the new image's own variables, not the old one's");

    const rec = readJson(m.recordFile('obysphere'));
    assert.deepEqual({ ...rec, deployedAt: 0, firstDeployedAt: 0 }, { name: 'obysphere', provider: 'docker', container: 'obysphere', image: IMAGE, url: `http://127.0.0.1:${healthPort}`, version: '0.4.0', deployedAt: 0, firstDeployedAt: 0 });
    assert.equal(fs.statSync(m.recordFile('obysphere')).mode & 0o777, 0o600);
    assert.ok(!secretsIn(fs.readFileSync(m.recordFile('obysphere'), 'utf8')), 'no secrets in the record');

    assert.match(r.stdout, /pulling ghcr\.io\/obi-ai-bot\/oby-sphere:0\.4\.0/);
    assert.match(r.stdout, new RegExp(`it keeps port 127\\.0\\.0\\.1:${healthPort}:8080/tcp, volume obysphere-data at /data, 4 variables \\(not shown\\), 2 labels, restart unless-stopped`));
    assert.match(r.stdout, /runs ghcr\.io\/obi-ai-bot\/oby-sphere:0\.4\.0/);
    assert.match(r.stdout, /It answers: relay 0\.4\.0, fs store, sealed/);
    assert.match(r.stdout, /Recorded as obysphere/);

    // server status finds it
    const st = await m.cli(['server', 'status']);
    assert.equal(st.code, 0, st.out);
    assert.match(st.stdout, new RegExp(`obysphere  http://127\\.0\\.0\\.1:${healthPort}`));
    assert.match(st.stdout, /up · relay 0\.4\.0 · fs store · sealed/);

    // again, with nothing new: nothing changes
    const n = m.docker.calls().length;
    const again = await m.cli(['server', 'update']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.stdout, /already runs ghcr\.io\/obi-ai-bot\/oby-sphere:0\.4\.0: nothing to do/);
    assert.ok(!m.docker.calls().slice(n).some((c) => ['rename', 'stop', 'run', 'rm'].includes(c.argv[0])));

    // after obysphere update: the recorded Sphere, by its name, to the new version
    appAt(m.app, '0.4.1');
    const next = await m.cli(['server', 'update', 'obysphere']);
    assert.equal(next.code, 0, next.out);
    assert.equal(m.docker.calls().filter((c) => c.argv[0] === 'pull').at(-1).argv.at(-1), `${IMAGE}:0.4.1`);
    const later = m.docker.state().containers.obysphere;
    assert.equal(later.Image, published('0.4.1').Id);
    assert.deepEqual(settingsOf(later, published('0.4.1')), settingsOf(before, LOCAL), 'still the same settings');
    assert.match(next.stdout, /it keeps .*read-only, cap-add CHOWN/);
    const rec2 = readJson(m.recordFile('obysphere'));
    assert.equal(rec2.version, '0.4.1');
    assert.equal(rec2.firstDeployedAt, rec.firstDeployedAt);
    assertNoKeys(m, next);
  });

  test('when the new container stops, the old one comes back, and its log is shown without the keys', async () => {
    const m = machine('rollback');
    m.docker.set({ runExits: true });
    const before = m.docker.state().containers.obysphere;
    const r = await m.cli(['server', 'update', '--docker', 'obysphere']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /The new container stopped \(exit code 1\)/);
    assert.match(r.stderr, /Its log:[\s\S]*fatal: something went wrong/);
    assert.match(r.stderr, /<hidden>/, 'the variables the log printed are hidden');
    assert.match(r.stderr, /obysphere is back on the image it had, as before/);
    assertNoKeys(m, r);
    const s = m.docker.state();
    assert.deepEqual(Object.keys(s.containers), ['obysphere']);
    assert.equal(s.containers.obysphere.Image, LOCAL.Id);
    assert.equal(s.containers.obysphere.State.Running, true);
    assert.deepEqual(settingsOf(s.containers.obysphere, LOCAL), settingsOf(before, LOCAL));
    assert.ok(!fs.existsSync(m.recordFile('obysphere')), 'nothing recorded');
  });

  test('when docker run fails and prints the variables, they are hidden and the old one comes back', async () => {
    const m = machine('echo');
    m.docker.set({ runEchoes: true });
    const r = await m.cli(['server', 'update', '--docker', 'obysphere']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /docker run failed:[\s\S]*invalid env file: .*<hidden>/);
    assertNoKeys(m, r);
    assert.equal(m.docker.state().containers.obysphere.Image, LOCAL.Id);
    assert.equal(m.docker.state().containers.obysphere.State.Running, true);
  });

  test('--tag picks a version; a stopped container is updated and started', async () => {
    const m = machine('tag', { containers: { obysphere: sphereContainer({ running: false }) } });
    const r = await m.cli(['server', 'update', '--docker', 'obysphere', '--tag', 'v0.4.1']);
    assert.equal(r.code, 0, r.out);
    const calls = m.docker.calls();
    assert.equal(calls.find((c) => c.argv[0] === 'pull').argv.at(-1), `${IMAGE}:0.4.1`);
    assert.ok(!calls.some((c) => c.argv[0] === 'stop'), 'nothing to stop');
    assert.match(r.stdout, /it was stopped; now it runs/);
    assert.equal(readJson(m.recordFile('obysphere')).version, '0.4.1');
    assertNoKeys(m, r);
  });

  test('server status names a recorded container that has no address', async () => {
    const m = machine('status');
    fs.mkdirSync(path.join(m.app, 'servers'), { recursive: true });
    fs.writeFileSync(m.recordFile('behind-proxy'), JSON.stringify({ name: 'behind-proxy', provider: 'docker', container: 'behind-proxy', image: IMAGE, url: '', version: '0.4.0' }));
    const r = await m.cli(['server', 'status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /behind-proxy {2}the container behind-proxy/);
    assert.match(r.stdout, /no address recorded: obysphere server update behind-proxy --url https:\/\/<its address>/);
  });

  // each refused before anything changes
  const refusals = [
    {
      name: "a container that isn't a Sphere",
      setup: () => {
        const pg = { Id: sha('postgres'), Config: { Env: ['PATH=/usr/bin', 'PG_VERSION=16.4'], Cmd: ['postgres'], Entrypoint: ['docker-entrypoint.sh'], WorkingDir: '', User: '', Labels: {} } };
        return { images: { 'postgres:16': pg }, containers: { obysphere: sphereContainer({ image: pg, ref: 'postgres:16' }) } };
      },
      error: /obysphere doesn't run a Sphere \(its image: postgres:16\)/,
    },
    { name: 'one Docker Compose runs', setup: () => ({ containers: { obysphere: sphereContainer({ labels: { 'com.docker.compose.project': 'sphere' } }) } }), error: /Docker Compose runs obysphere: update it there/ },
    { name: 'one that keeps its data inside', setup: () => ({ containers: { obysphere: sphereContainer({ mounts: [] }) } }), error: /keeps its data inside the container \(no volume at \/data\)/ },
    // stopping it would remove it, and an anonymous volume with its data, before the new one runs
    {
      name: 'one run with --rm',
      setup: () => ({ containers: { obysphere: sphereContainer({ host: { AutoRemove: true, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } }, mounts: [{ Type: 'volume', Name: 'a'.repeat(64), Source: `/var/lib/docker/volumes/${'a'.repeat(64)}/_data`, Destination: '/data', RW: true }] }) } }),
      error: /obysphere runs with --rm: stopping it would remove it, and any volume Docker made for it[\s\S]*Nothing changed\. Copy its data out first \(docker cp obysphere:\/data/,
    },
    { name: 'a key in its arguments', setup: () => ({ containers: { obysphere: sphereContainer({ config: { Cmd: ['--admin-key', ADMIN] } }) } }), error: /has a key in its arguments/ },
    { name: 'a privileged one', setup: () => ({ containers: { obysphere: sphereContainer({ host: { Privileged: true } }) } }), error: /settings this can't carry over: privileged/ },
    { name: 'a seccomp profile', setup: () => ({ containers: { obysphere: sphereContainer({ host: { SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'] } }) } }), error: /a seccomp profile/ },
    { name: 'another log driver', setup: () => ({ containers: { obysphere: sphereContainer({ host: { LogConfig: { Type: 'splunk', Config: { 'splunk-token': 'x' } } } }) } }), error: /the splunk log driver/ },
    { name: 'a line break in a variable', setup: () => ({ containers: { obysphere: sphereContainer({ env: ['NOTE=one\ntwo'] }) } }), error: /can't be passed on safely/ },
    {
      name: 'an old container left from an earlier update',
      setup: () => ({ containers: { obysphere: sphereContainer(), 'obysphere-previous': { ...sphereContainer({ running: false }), Name: '/obysphere-previous' } } }),
      error: /obysphere-previous is still there from an earlier update\. Nothing changed/,
    },
    {
      name: 'a newer Sphere than this CLI',
      setup: () => ({ images: { [`${IMAGE}:0.5.0`]: published('0.5.0') }, containers: { obysphere: sphereContainer({ image: published('0.5.0'), ref: `${IMAGE}:0.5.0` }) } }),
      error: /obysphere runs 0\.5\.0, newer than your 0\.4\.0\. Update the CLI first \(obysphere update\), or go back to 0\.4\.0 on purpose: --tag 0\.4\.0/,
    },
    { name: 'a version with no image', setup: () => ({ registry: {} }), error: /Couldn't pull ghcr\.io\/obi-ai-bot\/oby-sphere:0\.4\.0\. Each release publishes its image/, pulls: true },
  ];
  for (const t of refusals)
    test(`refused, with nothing changed: ${t.name}`, async () => {
      const m = machine('refuse', t.setup());
      const before = m.docker.state().containers;
      const r = await m.cli(['server', 'update', '--docker', 'obysphere']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.stderr, t.error);
      assert.deepEqual(m.docker.calls().filter((c) => CHANGES.has(c.argv[0])).map((c) => c.argv[0]), t.pulls ? ['pull'] : [], 'no change');
      assert.deepEqual(m.docker.state().containers, before);
      assert.ok(!fs.existsSync(m.recordFile('obysphere')));
      assertNoKeys(m, r);
    });

  // docker finds a container by its ID too; run under that ID, the new one would lose its name
  test("a container's ID is refused, with its name to use instead, and nothing changes", async () => {
    const m = machine('by-id');
    const before = m.docker.state().containers;
    const id = before.obysphere.Id.slice(0, 12);
    const r = await m.cli(['server', 'update', '--docker', id]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, new RegExp(`${id} is the ID of the container obysphere\\. Name it, so it keeps its name: obysphere server update --docker obysphere\\. Nothing changed`));
    assert.deepEqual(m.docker.calls().map(verb), ['container inspect'], 'nothing pulled, renamed or run');
    assert.deepEqual(m.docker.state().containers, before);
    assert.deepEqual(fs.readdirSync(m.app).filter((f) => f === 'servers'), [], 'nothing recorded');
    assertNoKeys(m, r);
  });

  test('bad arguments are refused before docker runs; a name taken by another Sphere too', async () => {
    const m = machine('usage');
    for (const args of [['--docker'], ['--docker', '-x'], ['--docker', 'obysphere', '--tag', 'latest'], ['--docker', 'obysphere', '--url', 'https://alice:pw@sphere.example.com'], ['--docker', 'obysphere', '--url', 'ftp://x']]) {
      const r = await m.cli(['server', 'update', ...args]);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.stderr, /usage: obysphere server update --docker <container>/);
    }
    fs.mkdirSync(path.join(m.app, 'servers'), { recursive: true });
    fs.writeFileSync(m.recordFile('obysphere'), JSON.stringify({ name: 'obysphere', provider: 'vercel', project: 'obysphere', url: 'https://obysphere.example.com' }));
    const r = await m.cli(['server', 'update', '--docker', 'obysphere']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /obysphere is already recorded here for vercel/);
    assert.deepEqual(m.docker.calls(), [], 'docker never ran');
  });

  test('help, the printed Docker steps and the hint name the published image and the update', async () => {
    const m = machine('steps');
    const help = await m.cli(['help']);
    assert.ok(help.stdout.includes('obysphere server update --docker <container> [--url <address>] [--tag <version>]'));
    const steps = await m.cli(['server', 'deploy', 'docker']);
    assert.equal(steps.code, 0);
    assert.ok(steps.stdout.includes(`${IMAGE}:0.4.0`), 'the image for the installed version');
    assert.match(steps.stdout, /--env-file ~\/obysphere\.env/);
    assert.doesNotMatch(steps.stdout, /-e SPHERE_(ADMIN_)?KEY=/, 'no key on a command line');
    assert.match(steps.stdout, /obysphere server update --docker obysphere/);
    const none = await m.cli(['server', 'update']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /obysphere server update --docker <container>/);
  });
});

// ---------------------------------------------------------------- the release workflow

describe('the release workflow publishes the image', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const wf = parseYaml(read('.github/workflows/release.yml'));
  const job = wf.jobs.image;
  const steps = job.steps;
  const at = (pred) => steps.findIndex(pred);

  test('only on a v* tag, after the tests and the release, with packages: write for that job alone', () => {
    assert.deepEqual(wf.on, { push: { tags: ['v*'] } }, 'never on a pull request or a push to a branch');
    assert.deepEqual(wf.permissions, { contents: 'write' }, "the release job's permissions are as they were");
    assert.equal(wf.jobs.release.permissions, undefined);
    assert.equal(read('.github/workflows/release.yml').match(/packages: write/g).length, 1, 'no other job writes packages');
    assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
    assert.equal(job.needs, 'release', 'after the tests and the release');
    const releaseRuns = wf.jobs.release.steps.map((s) => s.run || '').join('\n');
    assert.match(releaseRuns, /npm test/);
    assert.doesNotMatch(releaseRuns, /docker/);
  });

  test('QEMU, Buildx, a login with GITHUB_TOKEN, and one push for linux/amd64 and linux/arm64', () => {
    const uses = steps.map((s) => s.uses).filter(Boolean);
    for (const a of ['actions/checkout@v7', 'docker/setup-qemu-action@v4', 'docker/setup-buildx-action@v4', 'docker/login-action@v4', 'docker/build-push-action@v7']) assert.ok(uses.includes(a), a);
    const login = steps.find((s) => s.uses === 'docker/login-action@v4');
    assert.equal(login.with.registry, 'ghcr.io');
    assert.equal(login.with.password, '${{ secrets.GITHUB_TOKEN }}');
    const pushes = steps.filter((s) => s.with?.push === true);
    assert.equal(pushes.length, 1, 'one push');
    const push = pushes[0];
    assert.equal(push.uses, 'docker/build-push-action@v7');
    assert.deepEqual(push.with.platforms.split(',').sort(), ['linux/amd64', 'linux/arm64']);
    assert.equal(push.with.tags, '${{ steps.meta.outputs.tags }}');
    const labels = push.with.labels.trim().split('\n');
    for (const l of [
      'org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}',
      'org.opencontainers.image.version=${{ steps.meta.outputs.version }}',
      'org.opencontainers.image.revision=${{ github.sha }}',
      'org.opencontainers.image.licenses=Apache-2.0',
    ])
      assert.ok(labels.includes(l), l);
    assert.match(push.with.annotations, /^index:org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}$/m, 'the index links the package too');
    // checked before it's pushed: built for this runner, then started and asked /healthz
    const check = at((s) => /\/healthz/.test(s.run || ''));
    assert.ok(check > 0 && check < at((s) => s === push) && at((s) => s.uses === 'docker/login-action@v4') < at((s) => s === push));
    assert.equal(steps[check - 1].with.load, true);
    assert.match(steps[check].run, /--env-file/, 'its test keys are not on a command line');
    assert.equal(JSON.parse(read('package.json')).license, 'Apache-2.0', 'the license the labels name is the repository\'s');
  });

  test('the tags: <version> and latest for a release, <version> only for a pre-release', { skip: !POSIX && 'needs bash' }, () => {
    const meta = steps.find((s) => s.id === 'meta');
    const runMeta = (tag, repo = 'obi-ai-bot/oby-sphere') => {
      const out = path.join(tmp('meta'), 'out');
      fs.writeFileSync(out, '');
      // as GitHub runs a step's script
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', meta.run], { env: { PATH: process.env.PATH, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repo, GITHUB_OUTPUT: out }, encoding: 'utf8' });
      return { code: r.status, stderr: r.stderr, out: Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
    };
    const rel = runMeta('v0.4.0');
    assert.equal(rel.code, 0, rel.stderr);
    assert.deepEqual(rel.out, { version: '0.4.0', image: IMAGE, tags: `${IMAGE}:0.4.0,${IMAGE}:latest` });
    const rc = runMeta('v0.4.0-rc.1');
    assert.equal(rc.out.tags, `${IMAGE}:0.4.0-rc.1`, 'latest stays on the last release');
    assert.equal(runMeta('v1.0.0', 'Obi-AI-Bot/Oby-Sphere').out.image, IMAGE, 'image names are lowercase');
    const bad = runMeta('v1.0.0+build.5');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /can't be a Docker tag/);
  });

  test('CI builds and checks the image on every pull request, and publishes nothing', () => {
    const ci = parseYaml(read('.github/workflows/ci.yml'));
    assert.ok('pull_request' in ci.on);
    const runs = ci.jobs.docker.steps.map((s) => s.run || '').join('\n');
    assert.match(runs, /docker build/);
    assert.match(runs, /\/healthz/);
    for (const f of fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => f !== 'release.yml')) {
      const text = read(path.join('.github', 'workflows', f));
      assert.doesNotMatch(text, /packages: write|docker\/login-action|docker push|push: true/, `${f} publishes nothing`);
    }
  });

  test('the docs say how to run, pin and update the published image', () => {
    const readme = read('README.md');
    const deploy = read('docs/DEPLOY.md');
    assert.ok(readme.includes(`${IMAGE}:latest`));
    for (const w of [`docker run`, `${IMAGE}:latest`, `${IMAGE}:0.`, 'obysphere server update --docker', 'linux/amd64', 'linux/arm64']) assert.ok(deploy.includes(w), `DEPLOY.md: ${w}`);
    assert.match(read('SECURITY.md'), /ghcr\.io\/obi-ai-bot\/oby-sphere/);
  });
});

