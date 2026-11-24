// Fake `claude` and `cursor-agent` binaries for the settings tests: no model, no
// network. Each records what it was given (argv, folder, environment names, the
// prompt, and the --settings / --mcp-config / system prompt files' contents, read
// while they exist) to calls.jsonl beside it, then answers like the real one.
// control.json beside it sets { cost, text, cursorSignedIn }.
import fs from 'node:fs';
import path from 'node:path';

const CLAUDE = `
const fs = require('fs'), path = require('path');
const here = __dirname, argv = process.argv.slice(2);
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8')); } catch { return {}; } })();
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const read = (f) => { try { return f ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
if (argv[0] === '--help') { console.log('Usage: claude [options]\\n  -p --print --model --effort <level> --max-budget-usd <amount> --chrome --no-chrome --restricted --tools <tools...> --settings <file-or-json> --permission-mode --append-system-prompt-file --strict-mcp-config --mcp-config --allowedTools --disallowedTools --add-dir --resume --output-format --verbose'); process.exit(0); }
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'never-shown@example.com' })); process.exit(0); }
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const model = flag('--model') || 'fake-default';
  const settingsFile = flag('--settings');
  fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({
    bin: 'claude', argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), prompt,
    settings: JSON.parse(read(settingsFile) || 'null'), mcp: JSON.parse(read(flag('--mcp-config')) || 'null'), system: read(flag('--append-system-prompt-file')),
  }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', model, tools: ['Read'] });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: control.text || ('fake answer from ' + model), session_id: 'fake-session-' + Date.now(), total_cost_usd: control.cost ?? 0.01, num_turns: 1, modelUsage: { [model]: {} } });
});
`;

const CURSOR = `
const fs = require('fs'), path = require('path');
const here = __dirname, argv = process.argv.slice(2);
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8')); } catch { return {}; } })();
if (argv[0] === '--version') { console.log('2026.01.01-fake'); process.exit(0); }
if (argv[0] === 'status') { console.log(control.cursorSignedIn ? 'Logged in as never-shown@example.com' : 'Not logged in'); process.exit(0); }
if (argv[0] === '--list-models') { console.log('Available models\\n\\n- gpt-5 (GPT-5)\\n- sonnet-4 (Claude Sonnet 4)\\n\\nTip: use --model'); process.exit(0); }
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ bin: 'cursor', argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() }) + '\\n');
const i = argv.indexOf('--model');
console.log(JSON.stringify({ type: 'result', result: 'cursor answer from ' + (i >= 0 ? argv[i + 1] : 'default') }));
`;

// writes ./claude and ./cursor-agent into dir; returns their paths and a log reader
export function makeFakeRuntimes(dir, node = process.execPath) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!${node}\n${body}`, { mode: 0o755 });
    return f;
  };
  const log = path.join(dir, 'calls.jsonl');
  return {
    claude: write('claude', CLAUDE),
    cursor: write('cursor-agent', CURSOR),
    control: (o) => fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(o)),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
