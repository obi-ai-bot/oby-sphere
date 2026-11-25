// Helpers for test/mcp-hosts.test.mjs: an MCP client over stdio (what an app does with
// `rep.mjs mcp`), a strict reader for the YAML goose's entry uses, a shell-words splitter
// for the printed commands, and a strict check of tool input schemas. No dependencies.
import { spawn } from 'node:child_process';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---- an MCP client over stdio: one message per line each way
export function mcpSession(rep, args, env) {
  const p = spawn(process.execPath, [rep, 'mcp', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const msgs = []; // everything the server wrote, in order, with when it arrived
  const waiters = new Set();
  let buf = '';
  let err = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        m = { notJson: line };
      }
      msgs.push({ at: Date.now(), m });
      for (const w of [...waiters]) w();
    }
  });
  p.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const send = (o) => p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  const waitFor = (pred, ms = 20000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const hit = msgs.find((x) => pred(x.m));
        if (!hit) return;
        done();
        resolve(hit.m);
      };
      const t = setTimeout(() => {
        done();
        reject(new Error(`no such message in ${ms} ms. Got: ${JSON.stringify(msgs.map((x) => x.m)).slice(0, 2000)}\nstderr: ${err.slice(-2000)}`));
      }, ms);
      const done = () => {
        clearTimeout(t);
        waiters.delete(check);
      };
      waiters.add(check);
      check();
    });
  const answerTo = (id) => (m) => isObj(m) && m.id === id && !m.method;
  const request = (id, method, params, ms) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return waitFor(answerTo(id), ms);
  };
  const notify = (method, params) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  return { p, msgs, send, request, notify, waitFor, answerTo, exited, end: () => p.stdin.end(), kill: () => p.kill(), stderr: () => err };
}

// ---- the YAML in goose's entry: block mappings indented by two spaces, plain keys, and
// values written as JSON (strings, numbers, booleans, [lists], {}). Anything else throws,
// so an entry that strays from what goose's own docs show fails the test.
export function parseYamlSubset(text) {
  const lines = text.split('\n');
  let i = 0;
  const skip = () => {
    while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith('#'))) i++;
  };
  const block = (indent) => {
    const obj = {};
    for (skip(); i < lines.length; skip()) {
      const l = lines[i];
      if (/\t/.test(l)) throw new Error(`line ${i + 1}: a tab`);
      if (/\s$/.test(l)) throw new Error(`line ${i + 1}: trailing space`);
      const ind = l.length - l.trimStart().length;
      if (ind < indent) break;
      if (ind !== indent) throw new Error(`line ${i + 1}: indented ${ind}, expected ${indent}`);
      const m = /^([A-Za-z0-9_-]+):(?: (.+))?$/.exec(l.slice(indent));
      if (!m) throw new Error(`line ${i + 1}: not "key: value": ${l}`);
      if (Object.hasOwn(obj, m[1])) throw new Error(`line ${i + 1}: ${m[1]} twice`);
      i++;
      if (m[2] !== undefined) {
        try {
          obj[m[1]] = JSON.parse(m[2]);
        } catch {
          throw new Error(`line ${i}: the value of ${m[1]} isn't JSON: ${m[2]}`);
        }
      } else {
        skip();
        const next = i < lines.length ? lines[i].length - lines[i].trimStart().length : -1;
        if (next !== indent + 2) throw new Error(`line ${i}: ${m[1]} has nothing under it`);
        obj[m[1]] = block(indent + 2);
      }
    }
    return obj;
  };
  const out = block(0);
  skip();
  if (i < lines.length) throw new Error(`line ${i + 1}: left over: ${lines[i]}`);
  return out;
}

// ---- a POSIX shell's words: '…' literally, "…" with \ escapes, \ outside quotes
export function shellWords(line) {
  const words = [];
  let w = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error('an open single quote');
      w = (w ?? '') + line.slice(i + 1, j);
      i = j;
    } else if (c === '"') {
      w ??= '';
      for (i++; i < line.length && line[i] !== '"'; i++) w += line[i] === '\\' && /["\\$`]/.test(line[i + 1] || '') ? line[++i] : line[i];
      if (i >= line.length) throw new Error('an open double quote');
    } else if (c === '\\') w = (w ?? '') + (line[++i] ?? '');
    else if (/\s/.test(c)) {
      if (w !== null) words.push(w);
      w = null;
    } else w = (w ?? '') + c;
  }
  if (w !== null) words.push(w);
  return words;
}

// ---- tool definitions, checked the strict way the apps do (MCP-HOSTS.md, "Tool schemas"):
// VS Code validates each inputSchema against the JSON Schema draft-07 meta-schema and drops
// tools that fail, and allows names of [a-z0-9_-]; Gemini CLI sends the schema to the Gemini
// API as parametersJsonSchema, calls a tool mcp_<server>_<tool> (63 characters at most), and
// strips $schema and additionalProperties; Copilot's models refuse arrays without items; the
// MCP spec wants an object at the root. Anything past a plain, typed schema is refused here.
const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
const KEYWORDS = new Set(['type', 'description', 'title', 'properties', 'required', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'additionalProperties']);
const TOOL_FIELDS = new Set(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'icons', '_meta']);

export function toolProblems(tool, server = 'obysphere') {
  const out = [];
  if (!isObj(tool)) return ['a tool is an object'];
  for (const k of Object.keys(tool)) if (!TOOL_FIELDS.has(k)) out.push(`${tool.name}: unknown field ${k}`);
  if (typeof tool.name !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(tool.name)) out.push(`name ${JSON.stringify(tool.name)}: [a-z0-9_-], 64 at most`);
  else if (`mcp_${server}_${tool.name}`.length > 63) out.push(`${tool.name}: Gemini CLI's name for it is longer than 63`);
  if (typeof tool.description !== 'string' || !tool.description.trim()) out.push(`${tool.name}: no description`);
  out.push(...schemaProblems(tool.inputSchema, `${tool.name}.inputSchema`, true));
  return out;
}

export function schemaProblems(schema, where, root = false) {
  const out = [];
  const bad = (m) => out.push(`${where}: ${m}`);
  if (!isObj(schema)) return [`${where}: a schema is an object`];
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) bad(`${k} is past a plain schema ($ref, $schema, anyOf, oneOf, allOf and the like trip some apps)`);
  const t = schema.type;
  if (t === undefined) bad('no type (Gemini and stricter validators need one)');
  else if (typeof t !== 'string' || !TYPES.includes(t)) bad(`type ${JSON.stringify(t)} is not one JSON Schema type`);
  for (const k of ['description', 'title', 'pattern']) if (schema[k] !== undefined && typeof schema[k] !== 'string') bad(`${k} is a string`);
  if (root) {
    if (t !== 'object') bad('an input schema is an object');
    if (!isObj(schema.properties)) bad('properties is there, even when empty');
  }
  if (schema.properties !== undefined) {
    if (t !== 'object') bad('properties belongs to an object');
    if (!isObj(schema.properties)) bad('properties is an object');
    else
      for (const [k, v] of Object.entries(schema.properties)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) bad(`property name ${JSON.stringify(k)}`);
        if (isObj(v) && (typeof v.description !== 'string' || !v.description.trim())) bad(`property ${k} has no description`);
        out.push(...schemaProblems(v, `${where}.${k}`));
      }
  }
  if (schema.required !== undefined) {
    if (t !== 'object') bad('required belongs to an object');
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string') || new Set(schema.required).size !== schema.required.length) bad('required is a list of different names');
    else for (const r of schema.required) if (!isObj(schema.properties) || !Object.hasOwn(schema.properties, r)) bad(`required ${r} isn't one of its properties`);
  }
  if (t === 'array') {
    if (!isObj(schema.items)) bad('an array without items');
    else out.push(...schemaProblems(schema.items, `${where}[]`));
  } else if (schema.items !== undefined) bad('items belongs to an array');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) bad('enum is a list, not empty');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isObj(schema.additionalProperties)) bad('additionalProperties is true, false or a schema');
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[k] !== undefined && typeof schema[k] !== 'number') bad(`${k} is a number`);
  return out;
}
