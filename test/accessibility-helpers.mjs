// Helpers for test/accessibility.test.mjs: read the console page's markup (its template and the
// markup its script builds in template literals), and work out contrast from its CSS tokens.
// No browser and no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
export const STYLE = /<style>([\s\S]*?)<\/style>/.exec(PAGE)[1];
export const TEMPLATE = /<template id="tpl-app">([\s\S]*?)<\/template>/.exec(PAGE)[1];
export const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];

// ---------------------------------------------------------------- markup

// The end of an opening tag that starts at `at` ("<button …"): the first '>' outside the markup's
// quoted attributes and outside any ${…} expression, however deep (an expression may hold
// strings, template literals and markup of its own).
export function tagEnd(src, at) {
  let i = at + 1;
  let quote = null; // the markup's own attribute quote
  while (i < src.length) {
    const c = src[i];
    if (c === '$' && src[i + 1] === '{') { i = exprEnd(src, i + 2); continue; }
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"') quote = c;
    else if (c === '>') return i;
    i++;
  }
  return -1;
}
// the index just past the '}' that closes a ${ whose body starts at i
function exprEnd(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\'' || c === '"') { i = stringEnd(src, i); continue; }
    if (c === '`') { i = templateEnd(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}
function stringEnd(src, i) {
  const q = src[i++];
  while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}
function templateEnd(src, i) {
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { i = exprEnd(src, i + 2); continue; }
    i++;
  }
  return i + 1;
}

// every opening tag of these names in src: { name, at, tag (the opening tag's text), end }
export function tags(src, names) {
  const out = [];
  const re = new RegExp(`<(${names.join('|')})\\b`, 'g');
  for (const m of src.matchAll(re)) {
    const end = tagEnd(src, m.index);
    if (end < 0) continue;
    out.push({ name: m[1], at: m.index, end, tag: src.slice(m.index, end + 1) });
  }
  return out;
}

export const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
export const hasAttr = (tag, name) => new RegExp(`\\s${name}(?=[\\s=>/]|$)`).test(tag);

// what a ${…} expression puts in the markup: a picture (an icon, an avatar), or words
const PICTURES = /^\s*(?:navIcon|obyFace|avatar|picture|clip|xIcon|plusIcon|lock|fileIcon|laptop|ico)\(|^\s*icon \? navIcon\(/;
// a button's content, read as a screen reader would: pictures and aria-hidden parts drop out
export function spokenText(content) {
  let s = content;
  // ${…} expressions, outermost first: a picture says nothing, anything else stands for words
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '$' && s[i + 1] === '{') {
      const end = exprEnd(s, i + 2);
      out += PICTURES.test(s.slice(i + 2, end - 1)) ? ' ' : ' WORDS ';
      i = end;
    } else out += s[i++];
  }
  s = out
    .replace(/<svg\b[\s\S]*?<\/svg>/g, ' ')
    .replace(/<(\w+)\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, 'x');
  return s.replace(/\s+/g, ' ').trim();
}

// a button's accessible name, or null: aria-label, aria-labelledby, or its words
export function buttonName(src, t) {
  if (attr(t.tag, 'aria-label')) return attr(t.tag, 'aria-label');
  if (attr(t.tag, 'aria-labelledby')) return `(labelled by ${attr(t.tag, 'aria-labelledby')})`;
  const close = src.indexOf(`</${t.name}>`, t.end);
  if (close < 0) return null;
  const words = spokenText(src.slice(t.end + 1, close));
  return words || null;
}

// a field's label, or null: aria-label, aria-labelledby, <label for=its id>, or a <label> around it
export function fieldLabel(src, t, whole = PAGE) {
  if (attr(t.tag, 'aria-label') || attr(t.tag, 'aria-labelledby')) return attr(t.tag, 'aria-label') || `(labelled by ${attr(t.tag, 'aria-labelledby')})`;
  const id = attr(t.tag, 'id');
  if (id && whole.includes(`for="${id}"`)) return `(label for ${id})`;
  const before = src.slice(0, t.at);
  const open = before.lastIndexOf('<label');
  if (open >= 0 && before.indexOf('</label>', open) < 0) return '(inside a label)';
  return null;
}

// a function declaration out of the script, by its braces (past its parameters, which may hold some)
export function fnSource(name, src = SCRIPT) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} isn't in the page`);
  let p = src.indexOf('(', start), open = 0;
  for (; p < src.length; p++) { if (src[p] === '(') open++; else if (src[p] === ')' && --open === 0) break; }
  let depth = 0;
  for (let i = src.indexOf('{', p); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

// ---------------------------------------------------------------- colour

export function parseColor(v) {
  v = String(v).trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v))) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [m[1], m[2], m[3]].map(Number), a };
  }
  if (v === 'white') return { rgb: [255, 255, 255], a: 1 };
  if (v === 'black') return { rgb: [0, 0, 0], a: 1 };
  return null;
}
// a colour with alpha, drawn over an opaque one
export const over = (c, back) => c.rgb.map((x, i) => x * c.a + back[i] * (1 - c.a));
const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
// WCAG's contrast ratio of two opaque colours
export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------- CSS

// the stylesheet without comments, as top-level blocks: { prelude, body }; an @media block's body
// is its own list of rules (blocks)
export function cssBlocks(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    out.push(prelude.startsWith('@') ? { prelude, blocks: prelude.startsWith('@media') || prelude.startsWith('@container') ? cssBlocks(body) : [] } : { prelude, body });
    i = j;
  }
  return out;
}
export function declarations(body) {
  const out = {};
  for (const d of body.split(';')) {
    const k = d.indexOf(':');
    if (k < 0) continue;
    out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
  }
  return out;
}
// every rule, with the @media it sits in ('' at the top level)
export function cssRules(css = STYLE) {
  const out = [];
  const walk = (blocks, media) => {
    for (const b of blocks) {
      if (b.blocks) walk(b.blocks, b.prelude);
      else if (b.body !== undefined) out.push({ selector: b.prelude, media, decl: declarations(b.body) });
    }
  };
  walk(cssBlocks(css), '');
  return out;
}

// The page's themes: its :root tokens, then each other set of them (a light scheme, a data-theme,
// Increase contrast), as the base with that set's changes on top.
export function themes(css = STYLE) {
  const rules = cssRules(css);
  const base = Object.assign({}, ...rules.filter((r) => r.selector === ':root' && !r.media).map((r) => r.decl));
  const out = [{ name: 'dark (the default)', tokens: base }];
  for (const r of rules) {
    const isRoot = /^:root\b|^\[data-theme|^html\[data-theme/.test(r.selector);
    if (!isRoot || (r.selector === ':root' && !r.media)) continue;
    if (/forced-colors/.test(r.media)) continue; // system colours: the browser picks them
    const tokens = Object.fromEntries(Object.entries(r.decl).filter(([k]) => k.startsWith('--')));
    // a theme changes colours; a block of sizes (the phone layout's gutter) isn't one
    if (!Object.values(tokens).some((v) => parseColor(v))) continue;
    out.push({ name: `${r.media || ''} ${r.selector}`.trim(), tokens: { ...base, ...tokens } });
  }
  return out;
}
// a value with var(--x) resolved from tokens
export function resolve(value, tokens, seen = new Set()) {
  return String(value).replace(/var\((--[\w-]+)(?:\s*,\s*([^)]*))?\)/g, (_, name, fallback) => {
    if (seen.has(name)) throw new Error(`a loop of tokens at ${name}`);
    const v = tokens[name] ?? fallback;
    if (v == null) throw new Error(`no token ${name}`);
    return resolve(v, tokens, new Set([...seen, name]));
  });
}
export const tokenColor = (name, tokens) => {
  const c = parseColor(resolve(`var(${name})`, tokens));
  if (!c) throw new Error(`${name} isn't a colour: ${tokens[name]}`);
  return c;
};
