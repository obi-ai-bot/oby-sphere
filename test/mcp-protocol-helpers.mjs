// Helpers for test/mcp-protocol.test.mjs: an MCP client over stdio (what an app does with
// `rep.mjs mcp`), and a strict check of tool definitions and their input schemas. No dependencies.
import { spawn } from 'node:child_process';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---- an MCP client over stdio: one message per line each way. argv: what node runs.
export function mcpSession(argv, env) {
  const p = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.on('error', () => {}); // it may have exited already
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

// ---- tool definitions, checked the strict way MCP apps do. The MCP specification wants an
// object at the root of an input schema; VS Code validates each input schema against the JSON
// Schema draft-07 meta-schema and drops a tool that fails, and allows names of [a-z0-9_-];
// Gemini CLI names a tool mcp_<server>_<tool> (63 characters at most) and sends its schema to
// the Gemini API; models behind Copilot refuse an array without items. Anything past a plain,
// typed schema ($ref, $schema, anyOf, oneOf, allOf, type lists) is refused here, since some
// apps trip on it.
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
  if (tool.title !== undefined && typeof tool.title !== 'string') out.push(`${tool.name}: title is a string`);
  if (tool.annotations !== undefined && !isObj(tool.annotations)) out.push(`${tool.name}: annotations is an object`);
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
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) bad('enum is a list, not empty');
    else if (['string', 'number', 'integer', 'boolean'].includes(t) && schema.enum.some((v) => (t === 'integer' ? !Number.isInteger(v) : typeof v !== t))) bad(`enum values are each a ${t}`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isObj(schema.additionalProperties)) bad('additionalProperties is true, false or a schema');
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[k] !== undefined && typeof schema[k] !== 'number') bad(`${k} is a number`);
  return out;
}
