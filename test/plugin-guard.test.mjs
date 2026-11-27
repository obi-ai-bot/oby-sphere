// The plugin's defences for the owner's own Claude Code session, where other members' words land:
// the PreToolUse guard (scripts/guard.mjs) keeps Claude from the console's local API, the Oby's own
// files and the obysphere commands that are the person's to run, however a steered session spells
// them (dot segments, escapes, 127.1, letter case, globs, split quotes, braces, variables, links),
// in time on a command made to be slow, and lets a call through on an error of its own; find-cli never runs a CLI from the project that's open (a PATH entry
// that isn't a full path, or one inside the open folder); the join skill and the setup tool put an
// invite link in single quotes, checked first, and only one the person gave; and find-cli's slug
// can't be stalled. No network: every home, install and profile folder is a temp folder. `npm test`.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCli, trustedPlace, profileMissing } from '../plugins/obysphere/scripts/find-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'obysphere');
const GUARD = path.join(PLUGIN, 'scripts', 'guard.mjs');
const MCP = path.join(PLUGIN, 'scripts', 'mcp.mjs');
const POSIX = process.platform !== 'win32';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const temps = [];
const tmpDir = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  temps.push(d);
  return d;
};
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

// the guard, run as Claude Code runs a hook: the call as JSON on stdin
function guard(call, vars = {}) {
  const home = vars.HOME || os.tmpdir();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GUARD], { input: typeof call === 'string' ? call : JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: os.tmpdir(), ...call }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...vars }, timeout: 10000 });
  const out = r.stdout.trim();
  return { code: r.status, out, ms: Date.now() - t0, decision: out ? JSON.parse(out).hookSpecificOutput : null };
}
const bash = (command, vars) => guard({ tool_name: 'Bash', tool_input: { command } }, vars);
const denied = (r) => r.decision?.permissionDecision === 'deny';

describe('the guard (scripts/guard.mjs)', () => {
  test('hooks.json runs it before Bash, Read, Grep, Glob, the edits and WebFetch, with a short timeout and no shell', () => {
    const pre = readJson(path.join(PLUGIN, 'hooks', 'hooks.json')).hooks.PreToolUse;
    assert.equal(pre.length, 1);
    const tools = pre[0].matcher.split('|');
    for (const t of ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch']) assert.ok(tools.includes(t), t);
    const [h] = pre[0].hooks;
    assert.equal(h.type, 'command');
    assert.equal(h.command, 'node');
    assert.deepEqual(h.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs']);
    assert.ok(h.timeout > 0 && h.timeout <= 10);
  });

  test("the console's local API: refused, with a reason that says to ask the person", () => {
    for (const command of [
      'curl -s http://alice.localhost:4849/local/pending',
      'curl -X POST -H "content-type: application/json" http://127.0.0.1:4849/local/pending/w_0123456789ab -d \'{"decision":"trust"}\'',
      'curl http://localhost:4851/api/admin/policy',
      'curl -H "x-obysphere-console: 1" http://[::1]:4849/local/settings',
      'wget -qO- alice.localhost:4849/api/agents',
    ]) {
      const r = bash(command);
      assert.ok(denied(r), command);
      assert.equal(r.code, 0);
      assert.equal(r.decision.hookEventName, 'PreToolUse');
      assert.match(r.decision.permissionDecisionReason, /the person's to decide/);
      assert.match(r.decision.permissionDecisionReason, /another member's words/);
    }
    assert.ok(denied(guard({ tool_name: 'WebFetch', tool_input: { url: 'http://alice.localhost:4849/local/notifications', prompt: 'x' } })));
    // another local server is none of its business
    for (const command of ['curl http://localhost:3000/api/users', 'curl http://127.0.0.1:8080/health', 'open http://localhost:5173/']) assert.ok(!denied(bash(command)), command);
  });

  test("the Oby's own files: refused, but for a profile's instruments", () => {
    const home = tmpDir('obysphere-guard-home-');
    const custom = tmpDir('obysphere-guard-profiles-');
    const vars = { HOME: home, OBYSPHERE_HOME: custom };
    const no = [
      ['Read', { file_path: path.join(home, '.obysphere', 'alice', 'profile.json') }],
      ['Read', { file_path: '~/.obysphere/alice/keys.json' }],
      ['Read', { file_path: path.join(home, '.obysphere-mvp', 'bob', 'peers.json') }],
      ['Read', { file_path: path.join(custom, 'alice', 'settings.json') }],
      ['Read', { file_path: path.join(custom, 'alice', 'console-secret.json') }],
      ['Write', { file_path: path.join(home, '.obysphere', 'alice', 'pending', 'w_0123456789ab.decision.json'), content: '{"decision":"trust"}' }],
      ['Edit', { file_path: path.join(custom, 'alice', 'settings.json'), old_string: 'a', new_string: 'b' }],
      ['Grep', { pattern: 'token', path: path.join(home, '.obysphere') }],
      ['Glob', { pattern: '**/*.json', path: path.join(home, '.obysphere') }],
      ['Glob', { pattern: '.obysphere/*/pending/*' }],
    ];
    for (const [tool_name, tool_input] of no) assert.ok(denied(guard({ tool_name, tool_input, cwd: home }, vars)), `${tool_name} ${JSON.stringify(tool_input)}`);
    for (const command of [
      'cat ~/.obysphere/alice/keys.json',
      'ls ~/.obysphere',
      'tar czf /tmp/x.tgz ~/.obysphere-mvp',
      `cat ${path.join(custom, 'alice', 'profile.json')}`,
      'echo \'{"decision":"trust"}\' > "$OBYSPHERE_HOME/alice/pending/w_0123456789ab.decision.json"',
    ])
      assert.ok(denied(bash(command, vars)), command);
    // its instruments and its logs are Claude's to help with; anything elsewhere is none of the guard's business
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: path.join(home, '.obysphere', 'alice', 'instruments', 'explain.md') }],
      ['Edit', { file_path: path.join(custom, 'alice', 'instruments', 'explain.md'), old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: path.join(home, 'code', 'app', 'settings.json') }],
      ['Read', { file_path: path.join(home, 'code', 'app', 'profile.json') }],
    ])
      assert.ok(!denied(guard({ tool_name, tool_input, cwd: home }, vars)), `${tool_name} ${JSON.stringify(tool_input)}`);
    for (const command of ['cat ~/.obysphere/alice/instruments/explain.md', 'git status', 'npm test', 'cat settings.json', 'grep -rn ".obysphere" docs']) assert.ok(!denied(bash(command, vars)), command);
    for (const command of ['cat "$HOME/.obysphere/alice/keys.json"', 'ls ".obysphere/alice"']) assert.ok(denied(bash(command, vars)), command);
  });

  test('obysphere admin, settings, delete, lockdown, token and logs: the person runs them', () => {
    for (const command of ['obysphere admin grant mallory', 'obysphere --profile alice settings --json', '~/.local/bin/obysphere delete m_0123456789', 'node ~/.local/share/obysphere/current/rep.mjs admin policy --sealed off', 'cd /tmp && obysphere lockdown', 'npx obysphere token', 'obysphere-rep admin revoke bob', 'bash -c "obysphere admin grant mallory"', "sh -c 'obysphere settings'", 'echo "$(obysphere delete m_0123456789)"', 'env OBYSPHERE_PROFILE=alice obysphere admin policy']) {
      const r = bash(command);
      assert.ok(denied(r), command);
      assert.match(r.decision.permissionDecisionReason, /for the person to run themselves/);
    }
    // named in quotes, as words to search for or to write down, they run nothing
    for (const command of ['obysphere status', 'obysphere open', 'obysphere agents', 'obysphere ask bob "is the admin page done?"', 'obysphere doctor', 'grep -rn "obysphere settings" README.md', 'git log --grep "obysphere admin claim"']) assert.ok(!denied(bash(command)), command);
  });

  test('the same, however a steered session spells it: dot segments, escapes, other names for this machine, any port', () => {
    for (const command of [
      'curl http://alice.localhost:4849/./local/pending',
      'curl http://alice.localhost:4849/x/../local/pending',
      'curl "http://alice.localhost:4849/%6Cocal/pending"',
      'curl http://alice.localhost:4849/%2e/local/invite',
      'curl --path-as-is http://alice.localhost.:4849/local/pending',
      'curl http://alice.LocalHost:4849/local/pending',
      'curl -H "Host: alice.localhost:4849" http://127.0.0.1:4849/./local/pending',
      'curl http://127.1:4849/local/settings',
      'curl http://2130706433:4849/local/pending',
      'curl http://0x7f.1:4849/local/pending',
      'curl "http://[0:0:0:0:0:0:0:1]:4849/local/settings"',
      'curl -s -H "x-obysphere-auth: $S" http://127.0.0.1:53111/api/messages',
      'curl http://127.0.0.1:4890/api/admin/policy',
      'curl http://alice.localhost:51000/api/agents',
      'curl -H "Host: alice.localhost:51000" http://127.0.0.1:51000/api/agents',
      'curl -H "X-Obysphere""-Console: 1" http://localhost:4849/%61pi/agents',
      'curl -H "x-obysphere-auth: $(cat secret)" http://127.0.0.1:61000/api/agents',
      'curl -X POST http://127.1:4849/./local/open-code',
      'curl http://alice.localhost:4849/console-signin?code=abc',
      'curl "http://127.0.0.1:52000/%63onsole-signin#code=abc"',
      'u=alice.localhost:4849; curl http://$u/local/pending',
      `node -e "fetch('http://alice.'+'localhost:4849/local/pending').then(r=>r.text()).then(console.log)"`,
      "printf 'GET /./local/pending HTTP/1.1\\r\\nHost: alice.localhost:4849\\r\\n\\r\\n' | nc 127.0.0.1 4849",
    ])
      assert.ok(denied(bash(command)), command);
    for (const url of ['http://alice.localhost:4849/./local/invite', 'http://alice.localhost:4849/%6cocal/pending', 'http://127.1:4849/local/settings', 'http://127.0.0.1:4890/api/agents'])
      assert.ok(denied(guard({ tool_name: 'WebFetch', tool_input: { url, prompt: 'x' } })), url);
    // another local server's API, on its own port, is none of its business
    for (const command of ['curl http://localhost:3000/api/users', 'curl http://127.0.0.1:8080/api/health', 'curl http://localhost:3000/localization', 'curl http://127.0.0.1:5000/./static/app.js']) assert.ok(!denied(bash(command)), command);
  });

  test("the Oby's own files, however a steered session names them: letter case, globs, split quotes, variables, links, searches from above", () => {
    const home = tmpDir('obysphere-guard-home-');
    const custom = tmpDir('obysphere-guard-profiles-');
    fs.mkdirSync(path.join(home, '.obysphere', 'alice', 'instruments'), { recursive: true });
    fs.writeFileSync(path.join(home, '.obysphere', 'alice', 'profile.json'), '{}');
    fs.writeFileSync(path.join(home, '.obysphere', 'alice', 'instruments', 'explain.md'), '# x');
    fs.symlinkSync(path.join(home, '.obysphere', 'alice', 'profile.json'), path.join(home, 'link-to-profile.json'));
    fs.symlinkSync(path.join('..', 'profile.json'), path.join(home, '.obysphere', 'alice', 'instruments', 'k'));
    const vars = { HOME: home, OBYSPHERE_HOME: custom };
    const caseBlind = process.platform === 'darwin' || process.platform === 'win32';
    const no = [
      ['Read', { file_path: path.join(home, 'link-to-profile.json') }],
      ['Read', { file_path: `${home}/.obysphere/alice/instruments/../console-auth.json` }],
      ['Read', { file_path: path.join(home, '.obysphere', 'alice', 'instruments', 'k') }],
      ['Read', { file_path: path.join(home, '.obysphere', 'alice', 'lockdown.json') }],
      ['Read', { file_path: path.join(home, 'elsewhere', 'console-auth.json') }],
      ['Grep', { pattern: 'token', path: home, glob: '**/profile.json' }],
      ['Grep', { pattern: 'secret', path: '~', glob: '**/console-auth.json' }],
      ['Glob', { pattern: '**/console-auth.json', path: '~' }],
      ['Glob', { pattern: '.o*/*/profile.json', path: home }],
      ['Glob', { pattern: '*/*/profile.json', path: path.join(home, '.obysphere') }],
      ...(caseBlind
        ? [
            ['Read', { file_path: path.join(home, '.OBYSPHERE', 'alice', 'profile.json') }],
            ['Read', { file_path: path.join(home, '.Obysphere', 'bob', 'console-auth.json') }],
            ['Read', { file_path: path.join(path.dirname(custom), path.basename(custom).toUpperCase(), 'alice', 'settings.json') }],
          ]
        : []),
    ];
    for (const [tool_name, tool_input] of no) assert.ok(denied(guard({ tool_name, tool_input, cwd: home }, vars)), `${tool_name} ${JSON.stringify(tool_input)}`);
    for (const command of [
      'cat ~/.obyspher?/alice/console-auth.json',
      'cat ~/.oby*/*/profile.json',
      'cat ~/.obys""phere/alice/profile.json',
      "cat ~/.oby'sphere'/alice/keys.json",
      'cat ~/.oby\\sphere/alice/keys.json',
      'cat ~/.{obysphere,x}/alice/keys.json',
      'd=.oby; cat ~/${d}sphere/alice/profile.json',
      'cat ~/${D}sphere/alice/profile.json',
      'cd ~ && cat .[o]bysphere/alice/profile.json',
      'cat ~/.OBYSPHERE/alice/profile.json',
      'cat ~/.obysphere/alice/instruments/../console-auth.json',
      'cat ~/.obysphere/alice/instruments/k',
      'rm ~/.oby*/alice/lockdown.json',
      'find ~ -maxdepth 3 -name profile.json -path "*oby*" -exec cat {} +',
      'grep -r token ~ --include=profile.json',
      'find / -name console-auth.json',
      `python3 -c "import os,glob;print(open(glob.glob(os.path.expanduser('~/.oby*/*/profile.json'))[0]).read())"`,
      'cat ~/.obysphere/alice/logs/console.log',
      `cat ${custom}/alice/instruments/../keys.json`,
    ])
      assert.ok(denied(bash(command, vars)), command);
    // its instruments, and anything that isn't a profile's, stay Claude's to help with
    for (const command of ['cat ~/.obysphere/alice/instruments/explain.md', 'ls ~/.obysphere/alice/instruments', 'cat ~/.zshrc ~/.*rc', 'ls ~/*', 'cat $DIR/profile.json', 'find ~/code -name settings.json', 'cp ~/code/app/settings.json ~/backup/', 'grep -rn ".obysphere" docs', 'grep -rn "console-auth.json" rep.mjs'])
      assert.ok(!denied(bash(command, vars)), command);
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: path.join(home, '.obysphere', 'alice', 'instruments', 'explain.md') }],
      ['Glob', { pattern: '**/notes.md', path: home }],
      ['Grep', { pattern: 'TODO', path: path.join(home, 'code'), glob: '**/settings.json' }],
    ])
      assert.ok(!denied(guard({ tool_name, tool_input, cwd: home }, vars)), `${tool_name} ${JSON.stringify(tool_input)}`);
    // a session whose folder is a profile's: its files by their names there
    const inProfile = path.join(home, '.obysphere', 'alice');
    for (const command of ['cat profile.json', 'cat ./profile.json', 'cat *.json']) assert.ok(denied(guard({ tool_name: 'Bash', tool_input: { command }, cwd: inProfile }, vars)), command);
    assert.ok(denied(guard({ tool_name: 'Grep', tool_input: { pattern: 'token' }, cwd: inProfile }, vars)), 'a search of the session folder');
    assert.ok(!denied(guard({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: inProfile }, vars)));
  });

  test('a command made to be slow to read is read in time', () => {
    const big = 256 * 1024;
    const fill = (x) => x.repeat(Math.ceil(big / x.length)).slice(0, big);
    for (const command of [`cat ~/${fill('a/')}`, fill('a="'), fill('x=y; '), fill('GET /x '), `cat ~/.oby${fill('*?')}`, `curl http://127.1:4849/${fill('a/')}${fill('../').slice(0, 50000)}local`, fill('obysphere --x ')]) {
      const r = bash(command);
      assert.equal(r.code, 0);
      assert.ok(r.ms < 3000, `${r.ms} ms for ${command.slice(0, 30)}…`);
    }
  });

  test('the commands, however a steered session runs them: split quotes, escapes, variables, the CLI by its path; and the ones added since', () => {
    for (const command of [
      'obysphere se""ttings set access.agents.mallory trust',
      'obysphere \\settings set access.agents.mallory trust',
      '"obysphere" settings',
      'o=obysphere; $o settings set access.agents.mallory trust',
      'OBY=settings; obysphere $OBY set x',
      'obysphere $CMD',
      'node ~/.local/share/obysphere/current/obysphere.mjs lockdown --off',
      'OBYSPHERE lockdown --off',
      'o=obysphere; $o token rotate --yes',
      'obysphere sealing --unpin',
      'obysphere --profile alice sealing --unpin',
      'obysphere logs',
      'obysphere logs -f',
      'obysphere menubar model',
      'obysphere menubar model --profile bob',
      'obysphere ui --port 4900',
      'obysphere open --print',
      'obysphere open --page you --print --port 4851',
      'node ~/.local/share/obysphere/current/rep.mjs open --print',
      'obysphere open --p""rint',
      'p=--print; obysphere open $p',
    ]) {
      const r = bash(command);
      assert.ok(denied(r), command);
      assert.match(r.decision.permissionDecisionReason, /for the person to run themselves/, command);
    }
    for (const command of ['obysphere sealing', 'obysphere menubar off', 'obysphere open', 'obysphere open --page you', 'obysphere status --json', 'obysphere ask bob "is the lockdown done?"', 'grep -rn "obysphere sealing --unpin" README.md']) assert.ok(!denied(bash(command)), command);
  });

  test('anything else passes, quickly; its own errors let the call through', () => {
    const r = bash('ls -la');
    assert.deepEqual([r.code, r.out], [0, '']);
    assert.ok(r.ms < 2000, `${r.ms} ms`);
    for (const junk of ['', 'not json', '[1,2]', '{"tool_name":"Bash","tool_input":null}', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 42 } })]) {
      const j = guard(junk);
      assert.deepEqual([j.code, j.out], [0, ''], junk);
    }
  });

  test('it passes the plugin checks: no web address, no whole environment, no `env` name', () => {
    const src = fs.readFileSync(GUARD, 'utf8');
    assert.doesNotMatch(src, /https?:\/\//i);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /process\.env(?!\.[A-Za-z_])/);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\b(?:const|let|var)\s+env\b|\benv\s*[,)=]/);
  });
});

describe('finding the CLI: never from the open project', () => {
  // a project someone else wrote, with its own "obysphere" and rep.mjs in node_modules/.bin
  const project = () => {
    const dir = tmpDir('obysphere-project-');
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'rep.mjs'), "import fs from 'node:fs'; fs.writeFileSync(process.env.FAKE_PID, 'ran'); process.exit(0);\n");
    fs.writeFileSync(path.join(binDir, 'obysphere'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const home = path.join(dir, '..', path.basename(dir) + '-home');
    fs.mkdirSync(home, { recursive: true });
    temps.push(home);
    const profiles = path.join(home, 'profiles');
    fs.mkdirSync(path.join(profiles, 'alice'), { recursive: true });
    fs.writeFileSync(path.join(profiles, 'alice', 'profile.json'), '{}');
    return { dir, binDir, home, vars: { HOME: home, USERPROFILE: home, OBYSPHERE_HOME: profiles, OBYSPHERE_APP_HOME: path.join(home, 'app') } };
  };

  test('a PATH entry that is not a full path is skipped, and nothing in the open folder runs', { skip: !POSIX && 'shell scripts' }, async () => {
    const pr = project();
    assert.equal(findCli({ ...pr.vars, PATH: 'node_modules/.bin' }, pr.dir), null, 'relative: skipped');
    assert.equal(findCli({ ...pr.vars, PATH: pr.binDir }, pr.dir), null, 'inside the open folder: not trusted');
    assert.equal(trustedPlace(path.join(pr.binDir, 'rep.mjs'), pr.vars, pr.dir), false);
    assert.equal(trustedPlace(path.join(pr.binDir, 'rep.mjs'), pr.vars, os.tmpdir() === pr.dir ? '/' : path.join(pr.home, 'elsewhere')), true, 'outside the open folder: fine');
    // the open folder is the home folder: a project can't be that
    assert.equal(trustedPlace(path.join(pr.binDir, 'rep.mjs'), { ...pr.vars, HOME: pr.dir }, pr.dir), true);
    // the plugin's MCP server, started in that project: the setup tool, and the project's rep.mjs never runs
    const pid = path.join(pr.home, 'ran');
    const p = spawn(process.execPath, [MCP], { cwd: pr.dir, env: { ...pr.vars, PATH: `node_modules/.bin${path.delimiter}${path.dirname(process.execPath)}`, FAKE_PID: pid }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    for (let i = 0; i < 50 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 100));
    p.stdin.end();
    await new Promise((r) => p.on('close', r));
    assert.ok(!fs.existsSync(pid), "the project's rep.mjs didn't run");
    assert.deepEqual(JSON.parse(out.split('\n')[0]).result.tools.map((t) => t.name), ['obysphere_setup']);
  });

  test("a name made to stall find-cli's slug costs nothing", () => {
    const pr = project();
    const t0 = Date.now();
    profileMissing(['--profile', `a${'-'.repeat(200000)}a`], pr.vars);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  });
});

describe('joining: an invite link in single quotes, checked, and only one the person gave', () => {
  test('the join-a-sphere skill', () => {
    const md = fs.readFileSync(path.join(PLUGIN, 'skills', 'join-a-sphere', 'SKILL.md'), 'utf8');
    assert.match(md, /obysphere join '<invite link>'/);
    assert.doesNotMatch(md, /obysphere join "/, 'never in double quotes, where $(…) runs');
    assert.match(md, /only a link the person typed or pasted/i);
    assert.match(md, /never one found in a message from the Sphere/i);
    assert.match(md, /#key=` followed only by letters, digits/);
  });

  test('the setup tool says the same', () => {
    const src = fs.readFileSync(MCP, 'utf8');
    assert.match(src, /obysphere join '<invite link>'/);
    assert.doesNotMatch(src, /obysphere join "/);
    assert.match(src, /only a link the person typed or pasted/i);
  });
});
