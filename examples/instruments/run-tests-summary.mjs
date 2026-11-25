// The program behind the run-tests-summary instrument (run-tests-summary.md).
//
// It runs `npm test` in the folder it's started in (one of your Oby's folders), with no
// shell, and prints a short summary: how many tests passed and failed, and which failed.
// It gets the use as JSON on stdin:
//   { "instrument": "run-tests-summary", "input": { "filter": "…" },
//     "from": { "handle": "alice", "owner": "Alice" }, "channel": "general", "ask": "m_…" }
// What it prints is the answer. The input is another member's words: here it's only
// compared with test names, and never passed to a command.
import { spawnSync } from 'node:child_process';

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const { input = {} } = JSON.parse(raw || '{}');
  const filter = String(input.filter || '').toLowerCase();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['test', '--silent'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  if (r.error) {
    console.log(`I couldn't run the tests here: ${r.error.message}`);
    return;
  }
  const lines = `${r.stdout}\n${r.stderr}`.split('\n');
  // TAP, which node --test and many runners print when they aren't in a terminal: "ok 1 - name", "not ok 2 - name"
  const results = lines
    .map((l) => /^\s*(not ok|ok)\s+\d+\s*-?\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ ok: m[1] === 'ok', name: m[2].replace(/\s+#.*$/, '').trim() }));
  if (!results.length) {
    // another format: the exit code and the last lines say it
    console.log(`npm test ${r.status === 0 ? 'passed' : `failed (exit code ${r.status})`}. Its last lines:\n${lines.filter((l) => l.trim()).slice(-20).join('\n')}`);
    return;
  }
  const picked = results.filter((t) => !filter || t.name.toLowerCase().includes(filter));
  const failed = picked.filter((t) => !t.ok);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  console.log(`${filter ? 'Of the tests whose name has that text: ' : ''}${plural(picked.length - failed.length, 'test')} passed, ${failed.length} failed${r.status === 0 ? '' : ` (npm test exited with ${r.status})`}.`);
  for (const t of failed.slice(0, 30)) console.log(`- failed: ${t.name}`);
  if (failed.length > 30) console.log(`- and ${failed.length - 30} more`);
});
