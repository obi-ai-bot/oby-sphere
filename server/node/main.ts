// The Sphere as one Node process, for its container image (server/Dockerfile) or any server: the
// Worker's own code (src/) behind node:http, SQLite in place of D1 (d1.ts), and the Doorbell and
// the phone relay in memory (objects.ts). The job channel (compute sharing) is left out. Everything
// it keeps is under SPHERE_DATA: the database and, once claimed, the operator token's hash.
//
// Environment: PORT (8787), SPHERE_DATA (./data; /data in the image), SPHERE_URL (its public
// address: the claim link it prints, and its own origin, which sign-in, DPoP and an assertion's
// URL aud need; never read from a request), and the Worker's own settings: SPHERE_OPERATOR_TOKEN,
// GOOGLE_CLIENT_ID, SIGNIN_PROVIDERS, CREATOR_WORKSPACES, SPHERE_CREATE_LIMIT, PHONE_RELAY (src/env.ts).
//
// Claiming: with no SPHERE_OPERATOR_TOKEN and no claim yet, it prints a one-time claim link to its
// log and refuses everything but health, its features and the claim itself. Whoever claims it makes the operator
// token and sends it with the link's code (POST /v0.1/claim): with curl, as the link's page shows,
// or a listed client that opens claim links (src/clients.ts). The Sphere keeps only the token's
// SHA-256. The code is never the token, works once, and lives in memory: a restart before the claim
// prints a new one.
//
// HTTPS only: a request a proxy says came over plain HTTP (X-Forwarded-Proto), or one with no proxy
// header from anywhere but this machine, is refused, except health. So a Sphere left without TLS in
// front fails closed instead of taking tokens in the clear.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { d1, migrate } from "./d1.ts";
import { namespace, type PairedSocket } from "./objects.ts";
import { open } from "./sqlite.ts";

// The Durable Objects import their base class from workerd's own module: here, objects.ts.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "cloudflare:workers" ? { url: new URL("./objects.ts", import.meta.url).href, shortCircuit: true } : next(specifier, context),
});
const { handle } = await import("../src/app.ts");
const { Doorbell } = await import("../src/doorbell.ts");
const { PhoneRelay } = await import("../src/relay.ts");
const { CLIENTS } = await import("../src/clients.ts");
const { configuredOrigin } = await import("../src/auth.ts");
const { ApiError, apiError, errorResponse, json, readJson } = await import("../src/http.ts");

const DATA = process.env.SPHERE_DATA || "data";
mkdirSync(DATA, { recursive: true });
const sqlite = open(join(DATA, "sphere.db"));
for (const name of migrate(sqlite, fileURLToPath(new URL("../migrations", import.meta.url)))) console.log(`sphere: applied migration ${name}`);

const setting = (name: string) => process.env[name] || undefined;
if (!configuredOrigin(setting("SPHERE_URL") ?? "")) console.log("sphere: SPHERE_URL isn't an http or https address, so it signs nobody in and takes no DPoP proof or URL aud");
const env: Record<string, unknown> = {
  DB: d1(sqlite),
  CHANNELS: {
    idFromName: (name: string) => name,
    get: () => {
      throw apiError("not_found", "this Sphere server has no job channels");
    },
  },
  SPHERE_OPERATOR_TOKEN: setting("SPHERE_OPERATOR_TOKEN"),
  GOOGLE_CLIENT_ID: setting("GOOGLE_CLIENT_ID"),
  SIGNIN_PROVIDERS: setting("SIGNIN_PROVIDERS"),
  CREATOR_WORKSPACES: setting("CREATOR_WORKSPACES"),
  SPHERE_CREATE_LIMIT: setting("SPHERE_CREATE_LIMIT"),
  PHONE_RELAY: setting("PHONE_RELAY"),
  SIGNIN_RETURN_SCHEMES: setting("SIGNIN_RETURN_SCHEMES"),
  // Its own address, never read from a request's Host, which a client may set here. Without
  // SPHERE_URL it signs nobody in and takes no DPoP proof or URL aud, only `obi-sphere:<id>`.
  SPHERE_URL: setting("SPHERE_URL") ?? "",
};
env.DOORBELLS = namespace(Doorbell, env);
env.RELAYS = namespace(PhoneRelay, env);

// Claiming.
const CLAIMED = join(DATA, "operator-token.sha256");
const OPERATOR_TOKEN = /^[A-Za-z0-9._~-]{32,512}$/;
const digest = (s: string) => createHash("sha256").update(s).digest();
if (!env.SPHERE_OPERATOR_TOKEN && existsSync(CLAIMED)) env.SPHERE_OPERATOR_TOKEN_SHA256 = readFileSync(CLAIMED, "utf8").trim();
let claimCode = env.SPHERE_OPERATOR_TOKEN || env.SPHERE_OPERATOR_TOKEN_SHA256 ? null : randomBytes(24).toString("base64url");
if (claimCode) {
  const origin = configuredOrigin(setting("SPHERE_URL") ?? "") ?? "https://<this Sphere's address>";
  console.log(`sphere: not claimed yet. To claim it, open this link (it works once):\nsphere:   ${origin}/claim#${claimCode}`);
}

/**
 * The claim page's one script: with a code after `#` (base64url, so nothing else lands in the
 * command), it shows the curl that claims this Sphere and points each listed client's Open link at
 * `<scheme>://claim/<this host>#<the code>`.
 */
const CLAIM_SCRIPT = `const c=location.hash.slice(1);if(/^[A-Za-z0-9_-]{1,64}$/.test(c)){document.body.className="claim";document.getElementById("host").textContent=location.origin;document.getElementById("code").textContent=c;if(location.protocol==="https:")for(const a of document.querySelectorAll("a[data-scheme]"))a.href=a.dataset.scheme+"://claim/"+location.host+location.hash;}`;
const CLAIM_SCRIPT_HASH = createHash("sha256").update(CLAIM_SCRIPT).digest("base64");
const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `GET /claim`: how to claim this Sphere with its link's code, `/claim#<code>`, which never reaches
 * the server: with curl, or a listed client that opens claim links.
 */
function claimPage(): Response {
  const openers = CLIENTS.filter((c) => c.scheme && c.claims).map((c) => `<a class="open" data-scheme="${html(c.scheme!)}">Open in ${html(c.name)}</a>`);
  const body = claimCode
    ? `<h1>Claim this Obysphere</h1>
<p>Claiming sets this server's operator token, the one secret that creates Obyspheres on it. This link works once.</p>
<p class="how">With curl, on a machine you trust: make a token, send it with this link's code, and keep the token somewhere safe.</p>
<pre class="how">token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
printf '{"code":"%s","operator_token":"%s"}' '<span id="code"></span>' "$token" |
  curl -sS --fail-with-body --data @- -H 'Content-Type: application/json' <span id="host"></span>/v0.1/claim &&
  printf '%s\\n' "$token"</pre>
${openers.length ? `<p class="how">Or: ${openers.join(" · ")}</p>\n` : ""}<script>${CLAIM_SCRIPT}</script>`
    : "<h1>This Obysphere is claimed</h1>\n<p>Its operator holds the token it was claimed with.</p>";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Claim an Obysphere</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:12vh auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}a{color:#7ab0ff}}.how{display:none}.claim .how{display:block}pre{overflow-x:auto;padding:.6rem;background:#8881}a.open:not([href]){display:none}</style>
${body}`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${CLAIM_SCRIPT_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

/** `POST /v0.1/claim` with `{"code", "operator_token"}`: keeps the token's SHA-256, once. */
async function claim(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { code?: unknown; operator_token?: unknown } | null;
  if (!claimCode) throw apiError("conflict", "this Sphere is already claimed");
  if (typeof body?.code !== "string" || !timingSafeEqual(digest(body.code), digest(claimCode))) throw apiError("unauthorized", "the claim code is wrong");
  const token = body.operator_token;
  if (typeof token !== "string" || !OPERATOR_TOKEN.test(token)) throw apiError("bad_request", "operator_token is 32 to 512 characters: letters, digits, '.', '_', '~' or '-'");
  const hash = digest(token).toString("hex");
  writeFileSync(CLAIMED, `${hash}\n`, { mode: 0o600, flag: "wx" });
  env.SPHERE_OPERATOR_TOKEN_SHA256 = hash;
  claimCode = null;
  console.log("sphere: claimed");
  return json(200, { claimed: true });
}

const UNCLAIMED_PATHS = new Set(["/v0.1/health", "/v0.1/features", "/claim", "/v0.1/claim"]);

async function serve(request: Request, plain: boolean): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (plain && path !== "/v0.1/health") throw apiError("forbidden", "this Sphere answers only over HTTPS: put it behind a proxy that has TLS");
    if (claimCode && !UNCLAIMED_PATHS.has(path)) throw apiError("forbidden", "this Sphere isn't claimed yet: open the claim link in its log");
    if (path === "/claim" && request.method === "GET") return claimPage();
    if (path === "/v0.1/claim" && request.method === "POST") return await claim(request);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    throw e;
  }
  return handle(request, env as never, { now: () => Date.now() });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** The request as the Worker sees it, and whether it came over plain HTTP from somewhere else. */
function toRequest(req: IncomingMessage): { request: Request; plain: boolean } {
  const forwarded = req.headers["x-forwarded-proto"];
  const scheme = forwarded === undefined ? "http" : String(forwarded).split(",")[0]!.trim().toLowerCase();
  const plain = forwarded === undefined ? !LOOPBACK.has(req.socket.remoteAddress ?? "") : scheme !== "https";
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (!HOP_BY_HOP.has(req.rawHeaders[i]!.toLowerCase())) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(new URL(req.url ?? "/", `${scheme === "https" ? "https" : "http"}://${req.headers.host ?? "localhost"}`), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : null,
    duplex: "half",
  } as RequestInit);
  return { request, plain };
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.appendHeader(k, v);
  if (!response.body) return void res.end();
  await pipeline(Readable.fromWeb(response.body as never), res);
}

// Close codes a server may send (RFC 6455 7.4); the others say what happened to a connection.
const sendable = (code: number) => code === 1000 || (code >= 1001 && code <= 1011 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

/** Joins a client's WebSocket to the end of the pair its relay handed over. */
function bridge(ws: WebSocket, end: PairedSocket): void {
  end.addEventListener("message", (e) => ws.send((e as MessageEvent).data));
  end.addEventListener("close", (e) => {
    const { code, reason } = e as unknown as { code: number; reason: string };
    ws.close(sendable(code) ? code : 1000, reason);
  });
  end.accept();
  ws.on("message", (data: Buffer, binary: boolean) => end.send(binary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString()));
  ws.on("close", (code: number, reason: Buffer) => end.close(code, reason.toString()));
  ws.on("error", () => ws.terminate());
}

const server = createServer((req, res) => {
  (async () => {
    let parsed;
    try {
      parsed = toRequest(req);
    } catch {
      return void res.writeHead(400).end();
    }
    await respond(res, await serve(parsed.request, parsed.plain));
  })().catch(() => res.destroy());
});

// A frame is at most 256 KiB and a device id (src/relay.ts); the relay closes bigger ones itself.
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
  (async () => {
    const { request, plain } = toRequest(req);
    const response = await serve(request, plain);
    const end = (response as Response & { webSocket?: PairedSocket | null }).webSocket;
    if (response.status === 101 && end) return sockets.handleUpgrade(req, socket, head, (ws) => bridge(ws, end));
    // Refused: the answer over plain HTTP, then the connection closes.
    const body = Buffer.from(await response.arrayBuffer());
    const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`, ...[...response.headers].map(([k, v]) => `${k}: ${v}`)];
    socket.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
  })().catch(() => socket.destroy());
});

// Longer than the proxies' idle connections (Caddy's is 2 minutes), so a proxy never reuses one
// the Sphere has just closed.
server.keepAliveTimeout = 125_000;

const port = Number(process.env.PORT || 8787);
server.listen(port, "0.0.0.0", () => console.log(`sphere: listening on port ${port}, data in ${DATA}`));

function stop(): void {
  for (const ws of sockets.clients) ws.terminate();
  server.close();
  sqlite.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
