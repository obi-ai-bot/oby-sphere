// Fake `claude`, `codex` and `cursor-agent` binaries for the settings tests: no model, no
// network. Each answer run records what it was given (argv, folder, environment names,
// the prompt on stdin, and the --settings / --mcp-config / system prompt files' contents,
// read while they exist) to calls.jsonl beside it, then answers like the real one. The
// route classifier (Claude Code on Haiku) records to classify.jsonl instead.
// control.json beside it sets:
//   text, sleepMs            Claude Code's answer, and a wait before it (after a partial one)
//   classify                 'auto' (the first kind whose words the message has), a rule number, 'none' or 'fail'
//   claudeAuth               'claude.ai' (default, a Team plan), 'console' (an API key) or 'none'; claudeMissing
//   claudeHelp               'old': an older Claude Code, whose --help has no --restricted
//   cursorSignedIn, cursorSleepMs; cursorModels 'current': the model in use isn't Cursor's default
//   codexLogin               'chatgpt' (default), 'apikey' or 'none'; codexModels 'ok', 'bundled', 'flagged' (the
//                            catalog flags its second model as the default) or 'fail'; codexSleepMs; codexMissing
//   fail, failNext           an answer run fails as the real runtime does, instead of answering: fail
//                            { claude: 'limit' } every run, failNext { claude: ['rate', 'rate'] } the next runs, one
//                            each. limit (resetInSec from now, an hour by default), limit-noreset, rate, overloaded,
//                            credit, auth, other (its words hold a path)
import fs from 'node:fs';
import path from 'node:path';

const COMMON = `
const fs = require('fs'), path = require('path');
const here = __dirname, argv = process.argv.slice(2);
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8')); } catch { return {}; } })();
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const read = (f) => { try { return f ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
const record = (file, o) => fs.appendFileSync(path.join(here, file), JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), ...o }) + '\\n');
const stdin = (fn) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => fn(s)); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// how this run fails, if it does (failNext is used up one run at a time)
const failure = (bin) => {
  const next = control.failNext && Array.isArray(control.failNext[bin]) ? control.failNext[bin] : [];
  if (next.length) {
    const f = next.shift();
    fs.writeFileSync(path.join(here, 'control.json'), JSON.stringify(control));
    return f;
  }
  return (control.fail && control.fail[bin]) || null;
};
const resetAt = () => Date.now() + (control.resetInSec ?? 3600) * 1000;
const clock = (ms) => { const d = new Date(ms); return (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? ' AM' : ' PM'); };
`;

const CLAUDE = `${COMMON}
if (argv[0] === '--help') { console.log(('Usage: claude [options]\\n  -p --print --model --effort <level> --max-budget-usd <amount> --chrome --no-chrome --restricted --tools <tools...> --settings <file-or-json> --permission-mode --append-system-prompt-file --strict-mcp-config --mcp-config --allowedTools --disallowedTools --add-dir --resume --output-format --input-format --verbose --no-session-persistence --disable-slash-commands --setting-sources').replace(control.claudeHelp === 'old' ? ' --restricted' : '\\0', '')); process.exit(0); }
if (argv[0] === '--version') { if (control.claudeMissing) process.exit(127); console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') {
  const a = control.claudeAuth || 'claude.ai';
  if (a === 'none') console.log(JSON.stringify({ loggedIn: false }));
  else console.log(JSON.stringify({ loggedIn: true, authMethod: a, apiProvider: 'firstParty', email: 'never-shown@example.com', orgId: 'org-never-shown', orgName: 'Never Shown Org', ...(a === 'claude.ai' ? { subscriptionType: 'team' } : {}) }));
  process.exit(0);
}
// the model list: one initialize control request on stdin, answered, then it waits to be stopped
if (flag('--input-format') === 'stream-json') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    if (!buf.includes('\\n')) return;
    const req = JSON.parse(buf.split('\\n')[0]);
    if (control.modelsFail) process.exit(1);
    out({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { account: { email: 'never-shown@example.com' }, models: [
      { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', description: 'Fable 5.2', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
      { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
    ] } } });
    setTimeout(() => process.exit(0), 10000);
  });
  return;
}
// the route classifier: the prompt on stdin, the answer a rule number or none
if (argv.includes('--no-session-persistence') && flag('--tools') === '') {
  stdin((prompt) => {
    record('classify.jsonl', { bin: 'claude', prompt });
    const c = String(control.classify ?? 'auto');
    if (c === 'fail') { out({ type: 'result', is_error: true, result: 'fake failure' }); process.exit(1); }
    let answer = c;
    if (c === 'auto') {
      const fence = (/QUOTED-[0-9A-F]{12}/.exec(prompt) || [''])[0];
      const msg = (prompt.split(fence)[2] || '').toLowerCase();
      answer = 'none';
      for (const m of prompt.matchAll(/^(\\d+)\\. (.*)$/gm)) if (m[2].split(',').some((w) => w.trim() && msg.includes(w.trim().toLowerCase()))) { answer = m[1]; break; }
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: answer });
  });
  return;
}
stdin((prompt) => {
  const model = flag('--model') || 'fake-default';
  record('calls.jsonl', { bin: 'claude', prompt, settings: JSON.parse(read(flag('--settings')) || 'null'), mcp: JSON.parse(read(flag('--mcp-config')) || 'null'), system: read(flag('--append-system-prompt-file')) });
  out({ type: 'system', subtype: 'init', model, tools: ['Read'], apiKeySource: 'none', session_id: 'fake-init' });
  const failed = failure('claude');
  if (failed) {
    const words = {
      limit: () => 'Claude AI usage limit reached|' + Math.floor(resetAt() / 1000),
      'limit-noreset': () => 'Claude AI usage limit reached',
      rate: () => 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}',
      overloaded: () => 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      credit: () => 'Credit balance is too low',
      auth: () => 'Invalid API key · Please run /login',
      other: () => "Error: EACCES: permission denied, open '" + process.cwd() + "/secret-plan.md'",
    }[failed]();
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: words }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: words, session_id: 'fake-session-' + Date.now(), num_turns: 1 });
    process.exit(1);
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
  const finish = () => out({ type: 'result', subtype: 'success', is_error: false, result: control.text || ('fake answer from ' + model), session_id: 'fake-session-' + Date.now(), total_cost_usd: 0.01, num_turns: 1, modelUsage: { [model]: {} } });
  if (control.sleepMs) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer so far' }] } });
    setTimeout(finish, control.sleepMs);
  } else finish();
});
`;

const CURSOR = `${COMMON}
if (argv[0] === '--version') { console.log('2026.05.15-fake'); process.exit(0); }
if (argv[0] === 'status') {
  if (flag('--format') === 'json') console.log(JSON.stringify({ status: control.cursorSignedIn ? 'authenticated' : 'unauthenticated', isAuthenticated: !!control.cursorSignedIn, email: 'never-shown@example.com' }));
  else console.log(control.cursorSignedIn ? '✓ Logged in as never-shown@example.com' : 'Not logged in');
  process.exit(0);
}
if (argv[0] === '--list-models') {
  const list = control.cursorModels === 'current' ? 'gpt-5 - GPT-5 (default)\\nsonnet-4 - Claude Sonnet 4 (current)' : 'gpt-5 - GPT-5 (current, default)\\nsonnet-4 - Claude Sonnet 4';
  console.log(control.cursorSignedIn ? 'Available models\\n\\n' + list + '\\nsonnet-4-thinking - Claude Sonnet 4 (Thinking)\\n\\nTip: use --model <id> to switch.' : 'No models available for this account.');
  process.exit(0);
}
stdin((prompt) => {
  record('calls.jsonl', { bin: 'cursor', prompt });
  const failed = failure('cursor');
  if (failed === 'auth') {
    process.stderr.write("Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.\\n");
    process.exit(1);
  }
  if (failed) {
    const words = { limit: () => "You've hit your usage limit. Your limit resets at " + clock(resetAt()) + '.', 'limit-noreset': () => "You've hit your usage limit for fast requests.", rate: () => 'Rate limit exceeded. Please try again in a few moments.', overloaded: () => 'The model is overloaded. Please try again.', credit: () => 'Payment required: check your billing details.', other: () => 'Error: something broke in ' + process.cwd() }[failed]();
    out({ type: 'result', subtype: 'error', is_error: true, result: words, session_id: 'cursor-session-' + Date.now() });
    process.exit(1);
  }
  const i = argv.indexOf('--model');
  const answer = () => out({ type: 'result', subtype: 'success', is_error: false, result: 'cursor answer from ' + (i >= 0 ? argv[i + 1] : 'default'), session_id: flag('--resume') || 'cursor-session-' + Date.now(), duration_ms: 5 });
  if (control.cursorSleepMs) setTimeout(answer, control.cursorSleepMs);
  else answer();
});
`;

const CODEX = `${COMMON}
if (argv[0] === '--version') { if (control.codexMissing) process.exit(127); console.log('codex-cli 0.172.0'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  const l = control.codexLogin || 'chatgpt';
  if (l === 'none') { process.stderr.write('Not logged in\\n'); process.exit(1); }
  process.stderr.write(l === 'apikey' ? 'Logged in using an API key - sk-never-shown\\n' : 'Logged in using ChatGPT\\n');
  process.exit(0);
}
if (argv[0] === 'debug' && argv[1] === 'models') {
  const m = control.codexModels || 'ok';
  if (m === 'fail' || (m === 'bundled' && !argv.includes('--bundled'))) process.exit(1);
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', description: 'the best for your plan', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }], default_reasoning_level: 'medium' },
    { slug: 'gpt-6.2-mini', display_name: 'GPT-6.2 Mini', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'low', ...(m === 'flagged' ? { is_default: true } : {}) },
    { slug: 'hidden-one', visibility: 'hide' },
  ] }));
  process.exit(0);
}
if (argv[0] === 'exec') {
  stdin((prompt) => {
    record('calls.jsonl', { bin: 'codex', prompt });
    const r = argv.indexOf('resume');
    const thread = r >= 0 ? argv[r + 1] : 'thread-' + Date.now();
    const model = flag('-m') || 'codex-default';
    out({ type: 'thread.started', thread_id: thread });
    out({ type: 'turn.started' });
    const failed = failure('codex');
    if (failed) {
      const words = {
        limit: () => "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at " + clock(resetAt()) + '.',
        'limit-noreset': () => "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later.",
        rate: () => 'exceeded retry limit, last status: 429 Too Many Requests, request id: 7f3c2a10-1b9e-4d55-a0c4-2f1e9b7d6c3a',
        overloaded: () => 'stream error: the model is overloaded, last status: 529',
        credit: () => 'Quota exceeded. You exceeded your current quota, please check your plan and billing details.',
        auth: () => 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
        other: () => 'stream disconnected before completion: error sending request for url (' + process.cwd() + ')',
      }[failed]();
      out({ type: 'error', message: words });
      out({ type: 'turn.failed', error: { message: words } });
      process.exit(1);
    }
    out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', exit_code: 0 } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'obysphere', tool: 'sphere_read' } });
    const finish = () => {
      out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'codex answer from ' + model } });
      out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    };
    if (control.codexSleepMs) {
      out({ type: 'item.completed', item: { id: 'i9', type: 'agent_message', text: 'partial codex answer' } });
      setTimeout(finish, control.codexSleepMs);
    } else finish();
  });
  return;
}
process.exit(2);
`;

// writes ./claude, ./codex and ./cursor-agent into dir; returns their paths and log readers
export function makeFakeRuntimes(dir, node = process.execPath) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const f = path.join(dir, name);
    // wrapped in a function, so the scripts may `return` early
    fs.writeFileSync(f, `#!${node}\n(() => {\n${body}\n})();\n`, { mode: 0o755 });
    return f;
  };
  const lines = (name) => {
    const f = path.join(dir, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return {
    claude: write('claude', CLAUDE),
    codex: write('codex', CODEX),
    cursor: write('cursor-agent', CURSOR),
    control: (o) => fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(o)),
    calls: () => lines('calls.jsonl'),
    classifications: () => lines('classify.jsonl'),
  };
}
