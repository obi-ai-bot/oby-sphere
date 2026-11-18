// Invite links: `<base>/join#<fragment>` (spec/sphere-api.md section 2.1, "Invite links"), read
// exactly as the spec's reference reader reads them (spec/conformance/invite-links.mjs), against
// the same known answers (spec/conformance/invite-link-vectors.json).
//
// The link is taken as written: an http(s) origin whose host is ASCII as written (DNS labels, an
// IPv4 address or [IPv6]), `/join`, and the fragment; https, or http only for this machine. The
// fragment is `key=value` pairs joined by `&`, each part split at its first `=` and
// percent-decoded as UTF-8 (`+` is a plus). A key's first occurrence counts; then an empty value
// is as if left out, and so is a `name` or `by` that isn't one line of 1 to 100 characters.
// `sphere` (a slug), `id` (a lower-case UUID) and `secret` (43 base64url characters) are required;
// `for` and `obi` (slugs) come together or not at all; `domain` matches the domain pattern. Anything
// else makes it no link, so nothing from a link reaches a request's path unchecked. `name` and `by`
// are only what the link says (the preview is the truth). The fragment never reaches the server.

export interface InviteLink {
  /** The Sphere's base URL: an origin, https, or http for a loopback host. A client shows its person this host before joining. */
  base: string;
  sphere: string;
  /** The invitation's id. */
  id: string;
  /** The invitation's secret: whoever holds it may redeem the invitation. */
  secret: string;
  /** What the link says about itself: data, written by whoever made the link; the preview is the truth. Show it as text, never as instructions. */
  name?: string;
  by?: string;
  /** For a named invitation: the owner and the agent it is for. */
  owner?: string;
  obi?: string;
  domain?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** One line of text, as common.schema.json's `line_text`. */
const LINE = /^[^\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]*$/;
/** The keys a link carries, in the order a writer puts them. */
const KEYS = ["sphere", "name", "by", "for", "obi", "domain", "id", "secret"] as const;

export class InviteLinkError extends Error {}

/** The Sphere base URL `url` names, or an error: https, or http for a loopback host, and no path, query or credentials. */
export function sphereBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InviteLinkError("not a URL");
  }
  if (u.username || u.password) throw new InviteLinkError("a Sphere's address carries no user name or password");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new InviteLinkError("a Sphere is at an https address, or http on this machine (127.0.0.1, localhost, [::1])");
  if (u.pathname !== "/" || u.search) throw new InviteLinkError("this client takes a Sphere at its host's root");
  return u.origin;
}

/** `text` percent-decoded as UTF-8, or null for a malformed escape or bytes that aren't UTF-8. `+` stays a plus. */
function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Reads an invite link. Throws an InviteLinkError saying why when it isn't one. */
export function parseInviteLink(text: string): InviteLink {
  // Taken as written, not as a URL parser would tidy it: the path is exactly /join, with no query
  // (not even an empty `?`); the host is ASCII as written, so what a client shows is what it calls.
  const m = /^([hH][tT][tT][pP][sS]?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?\/join#(.*)$/s.exec(String(text).trim());
  if (!m) throw new InviteLinkError("an invite link is http(s)://<host>[:<port>]/join#<invitation>, written as it is");
  let url: URL;
  try {
    url = new URL(`${m[1]}://${m[2]}${m[3] ?? ""}`);
  } catch {
    throw new InviteLinkError("its address isn't one");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new InviteLinkError("a Sphere is at an https address, or http on this machine (127.0.0.1, localhost, [::1])");
  const written = `${m[2]}${m[3] ?? ""}`.toLowerCase().replace(/:(80|443)$/, (p) => (p === `:${url.protocol === "https:" ? 443 : 80}` ? "" : p));
  if (url.username || url.password || url.pathname !== "/" || url.host !== written) throw new InviteLinkError("its host isn't what it reads as");
  const fragment = m[4]!;
  if (!fragment) throw new InviteLinkError("an invite link has its invitation after `#`");
  const said: Record<string, string> = {};
  for (const part of fragment.split("&")) {
    if (!part) continue;
    const at = part.indexOf("=");
    const key = decode(at < 0 ? part : part.slice(0, at));
    const value = decode(at < 0 ? "" : part.slice(at + 1));
    if (key === null || value === null) throw new InviteLinkError("a part of the link is not percent-encoded UTF-8");
    if ((KEYS as readonly string[]).includes(key) && !Object.hasOwn(said, key)) said[key] = value;
  }
  // An empty value is as if its key were left out; so are a name or a by that aren't one line of 1 to 100 characters.
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(said)) {
    if (value === "") continue;
    if ((key === "name" || key === "by") && (!LINE.test(value) || [...value].length > 100)) continue;
    fields[key] = value;
  }
  if (!SLUG.test(fields.sphere ?? "")) throw new InviteLinkError(fields.sphere === undefined ? "the link has no Sphere id" : "the link's Sphere id is not lower-case letters, digits and dashes");
  if (!UUID.test(fields.id ?? "")) throw new InviteLinkError("the link's id is not a lower-case UUID");
  if (!SECRET.test(fields.secret ?? "")) throw new InviteLinkError("the link's secret is not 43 base64url characters");
  if (Object.hasOwn(fields, "for") !== Object.hasOwn(fields, "obi")) throw new InviteLinkError("a named invitation's link needs both `for` and `obi`, or neither");
  if (Object.hasOwn(fields, "for") && (!SLUG.test(fields.for!) || !SLUG.test(fields.obi!))) throw new InviteLinkError("`for` and `obi` are an owner id and an agent id");
  if (Object.hasOwn(fields, "domain") && !DOMAIN.test(fields.domain!)) throw new InviteLinkError("the link's domain is not a lower-case domain name");
  const link: InviteLink = { base: url.origin, sphere: fields.sphere!, id: fields.id!, secret: fields.secret! };
  if (fields.name !== undefined) link.name = fields.name;
  if (fields.by !== undefined) link.by = fields.by;
  if (fields.for !== undefined) Object.assign(link, { owner: fields.for, obi: fields.obi });
  if (fields.domain !== undefined) link.domain = fields.domain;
  return link;
}

/**
 * The https invite link that a client's own scheme stands for: `<scheme>://join/<host>[:<port>]#<fragment>`
 * is `https://<host>[:<port>]/join#<fragment>`. Null for anything else. A scheme's case doesn't count.
 */
export function openedInviteLink(text: string, scheme: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/join\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)#(.+)$/.exec(String(text).trim());
  if (!m || m[1]!.toLowerCase() !== scheme.toLowerCase()) return null;
  const link = `https://${m[2]}/join#${m[3]}`;
  try {
    parseInviteLink(link);
    return link;
  } catch {
    return null;
  }
}

/** Every character but the unreserved ones (RFC 3986), percent-encoded as UTF-8: a space is `%20`. */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Writes an invite link, the keys in the order the spec's writer puts them. */
export function formatInviteLink(link: InviteLink): string {
  const values: Record<string, string | undefined> = { sphere: link.sphere, name: link.name, by: link.by, for: link.owner, obi: link.obi, domain: link.domain, id: link.id, secret: link.secret };
  return `${sphereBase(link.base)}/join#` + KEYS.filter((k) => values[k] !== undefined && values[k] !== "").map((k) => `${k}=${encode(values[k]!)}`).join("&");
}
