#!/usr/bin/env node
// Invite links (spec/sphere-api.md section 2.1): the reference reader and writer, and the check of
// their known answers in invite-link-vectors.json.
//
//   node conformance/invite-links.mjs     every vector read as it says, and every valid link
//                                         written back to one that reads the same
//
// A client checks its own reader against the same file: each `valid` link reads to its `fields`,
// each `invalid` one to nothing, and each `opened` link stands for its `link`, or for nothing.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** One line of text, as common.schema.json's `line_text`: no control, bidirectional override or isolate characters. */
const LINE = /^[^\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]*$/;
/** Hosts a link may name over plain http: this machine only. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The keys a link carries, in the order a writer puts them. */
export const KEYS = ["sphere", "name", "by", "for", "obi", "domain", "id", "secret"];

/** `text` percent-decoded as UTF-8, or null for a malformed escape or bytes that aren't UTF-8. `+` stays a plus. */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * An invite link read: `{base, sphere, id, secret}` and whichever of `name`, `by`, `for`, `obi` and
 * `domain` it carries, or null when `text` isn't one. `base` is the Sphere server's address, whose
 * API is at `<base>/v0.1`. Everything but `sphere`, `id` and `secret` is only what the link says.
 */
export function readInviteLink(text) {
  // Taken as written, not as a URL parser would tidy it: the path is exactly /join, with no query
  // (not even an empty `?`), no dot segments and no backslashes.
  // The host is ASCII as written (DNS labels, an IPv4 address or [IPv6]): what a client shows its
  // person is what it calls, with no escapes, dots of other scripts or white space tidied away.
  const m = /^([hH][tT][tT][pP][sS]?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?\/join#(.*)$/s.exec(String(text).trim());
  if (!m) return null;
  let url;
  try {
    url = new URL(`${m[1]}://${m[2]}${m[3] ?? ""}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  if (url.username || url.password || url.pathname !== "/" || url.host !== `${m[2]}${m[3] ?? ""}`.toLowerCase().replace(/:(80|443)$/, (p) => (p === `:${url.protocol === "https:" ? 443 : 80}` ? "" : p))) return null;
  const fragment = m[4];
  if (!fragment) return null;
  const said = {};
  for (const part of fragment.split("&")) {
    if (!part) continue;
    const at = part.indexOf("=");
    const key = decode(at < 0 ? part : part.slice(0, at));
    const value = decode(at < 0 ? "" : part.slice(at + 1));
    if (key === null || value === null) return null;
    if (KEYS.includes(key) && !(key in said)) said[key] = value;
  }
  // An empty value is as if its key were left out; so are a name or a by that aren't one line of 1 to 100 characters.
  const fields = { base: url.origin };
  for (const [key, value] of Object.entries(said)) {
    if (value === "") continue;
    if ((key === "name" || key === "by") && (!LINE.test(value) || [...value].length > 100)) continue;
    fields[key] = value;
  }
  if (!SLUG.test(fields.sphere ?? "") || !UUID.test(fields.id ?? "") || !SECRET.test(fields.secret ?? "")) return null;
  if (("for" in fields) !== ("obi" in fields)) return null;
  if ("for" in fields && (!SLUG.test(fields.for) || !SLUG.test(fields.obi))) return null;
  if ("domain" in fields && !DOMAIN.test(fields.domain)) return null;
  return fields;
}

/**
 * The link a client's own scheme opened, `<scheme>://join/<host>[:<port>]#<fragment>`, as the
 * https invite link it stands for, `https://<host>[:<port>]/join#<fragment>`; or null.
 */
export function openedInviteLink(text, scheme) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/join\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)#(.+)$/.exec(String(text).trim());
  // A scheme's case doesn't count (RFC 3986 section 3.1).
  if (!m || m[1].toLowerCase() !== scheme.toLowerCase()) return null;
  const link = `https://${m[2]}/join#${m[3]}`;
  return readInviteLink(link) ? link : null;
}

/** Every character but the unreserved ones (RFC 3986), percent-encoded as UTF-8: a space is `%20`. */
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The invite link for `fields` (as readInviteLink answers them). */
export function writeInviteLink(fields) {
  const parts = KEYS.filter((k) => fields[k] !== undefined && fields[k] !== "").map((k) => `${k}=${encode(fields[k])}`);
  return `${fields.base}/join#${parts.join("&")}`;
}

// ---------------------------------------------------------------------------------------------
// The check.

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const vectors = JSON.parse(readFileSync(join(here, "invite-link-vectors.json"), "utf8"));
  const same = (a, b) => JSON.stringify(a, Object.keys(a ?? {}).sort()) === JSON.stringify(b, Object.keys(b ?? {}).sort());
  let failures = 0, passed = 0;
  const fail = (message) => {
    failures++;
    console.log(`FAIL invite links: ${message}`);
  };
  console.log("\n== Invite links (sphere-api.md section 2.1)");
  for (const v of vectors.valid) {
    const read = readInviteLink(v.link);
    if (!same(read, v.fields)) fail(`${v.name}: reads as ${JSON.stringify(read)}`);
    else if (!same(readInviteLink(writeInviteLink(read)), v.fields)) fail(`${v.name}: written back, it reads differently`);
    else passed++;
  }
  for (const v of vectors.invalid) {
    const read = readInviteLink(v.link);
    if (read !== null) fail(`${v.name}: reads as a link (${JSON.stringify(read)})`);
    else passed++;
  }
  for (const v of vectors.opened) {
    const link = openedInviteLink(v.opened, vectors.scheme);
    if (link !== v.link) fail(`${v.name}: stands for ${JSON.stringify(link)}`);
    else passed++;
  }
  const total = vectors.valid.length + vectors.invalid.length + vectors.opened.length;
  console.log(`${passed} of ${total} invite-link answers as expected.`);
  if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
}
