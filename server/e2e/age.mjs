// A small age (age-encryption.org/v1) for the end-to-end scripts: X25519 recipients only, written
// from the specification with node:crypto, so the Sphere's artifacts are checked with real
// ciphertext and opened by an implementation that isn't the one that made it (the public viewer's
// typage, in a browser). Never used by the server: it never encrypts or decrypts anything.
//
//   const { secret, recipient } = newIdentity();          // AGE-SECRET-KEY-1…, age1…
//   const file = encrypt(plaintext, [recipientRaw, …]);   // an age file for each 32-byte X25519 key
//   const plain = decrypt(file, secretRaw);
//   x25519Raw(secretRaw)                                  // the public key of a secret

import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "age-encryption.org/v1";
const CHUNK = 65536;

// --- Bech32 (BIP 173), for the identity and recipient strings ------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (values) => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
};
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
const toWords = (bytes) => {
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) out.push((acc >> (bits -= 5)) & 31);
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
};
export function bech32(hrp, bytes) {
  const data = toWords(bytes);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

// --- X25519 ---------------------------------------------------------------------------------------

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
export const x25519Raw = (secretRaw) => Buffer.from(createPublicKey(privateKey(secretRaw)).export({ format: "der", type: "spki" })).subarray(SPKI.length);
const shared = (secretRaw, publicRaw) => diffieHellman({ privateKey: privateKey(secretRaw), publicKey: publicKey(publicRaw) });

/** A fresh identity: its 32 raw bytes, and the strings age writes for it and its recipient. */
export function newIdentity() {
  const raw = randomBytes(32);
  return { raw, secret: bech32("age-secret-key-", raw).toUpperCase(), recipient: bech32("age", x25519Raw(raw)), publicRaw: x25519Raw(raw) };
}

// --- The format -------------------------------------------------------------------------------------

const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");
const unb64 = (text) => Buffer.from(text, "base64");
const hkdf = (ikm, salt, info, n = 32) => Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), n));
const seal = (key, nonce, plain) => {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
};
const open = (key, nonce, sealed) => {
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
};
// A stanza's body, wrapped at 64 columns, every line ending in a newline; its last line is always
// shorter than 64, so a body of a multiple of 64 ends with an empty line.
const wrap64 = (text) => (text.match(/.{1,64}/g) ?? []).map((l) => l + "\n").join("") + (text.length % 64 === 0 ? "\n" : "");
const streamNonce = (i, last) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 3);
  n[11] = last ? 1 : 0;
  return n;
};

/** An age file of `plain`, its file key wrapped to each 32-byte X25519 public key in `recipients`. */
export function encrypt(plain, recipients) {
  const fileKey = randomBytes(16);
  let header = `${VERSION}\n`;
  for (const r of recipients) {
    const e = randomBytes(32);
    const share = x25519Raw(e);
    const wrapKey = hkdf(shared(e, r), Buffer.concat([share, r]), "age-encryption.org/v1/X25519");
    header += `-> X25519 ${b64(share)}\n${wrap64(b64(seal(wrapKey, Buffer.alloc(12), fileKey)))}`;
  }
  header += "---";
  const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header")).update(header).digest();
  header += ` ${b64(mac)}\n`;
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, "payload");
  const chunks = [];
  const n = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let i = 0; i < n; i++) chunks.push(seal(payloadKey, streamNonce(i, i === n - 1), plain.subarray(i * CHUNK, (i + 1) * CHUNK)));
  return Buffer.concat([Buffer.from(header), nonce, ...chunks]);
}

/** The plaintext of an age file, for the X25519 secret `secretRaw`; throws when it doesn't open. */
export function decrypt(file, secretRaw) {
  const buf = Buffer.from(file);
  const end = buf.indexOf("\n---");
  const macLine = buf.indexOf("\n", end + 1);
  const text = buf.subarray(0, end + 4).toString("latin1");
  const lines = text.split("\n");
  if (lines[0] !== VERSION) throw new Error("not an age file");
  const own = x25519Raw(secretRaw);
  let fileKey = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].startsWith("-> X25519 ")) continue;
    const share = unb64(lines[i].slice(10));
    let body = "";
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("->") && !lines[j].startsWith("---"); j++) body += lines[j];
    try {
      fileKey = open(hkdf(shared(secretRaw, share), Buffer.concat([share, own]), "age-encryption.org/v1/X25519"), Buffer.alloc(12), unb64(body));
      break;
    } catch {}
  }
  if (!fileKey) throw new Error("no key wrapped for this identity");
  const mac = unb64(buf.subarray(end + 5, macLine).toString("latin1"));
  if (!createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header")).update(text).digest().equals(mac)) throw new Error("the header's MAC doesn't verify");
  const nonce = buf.subarray(macLine + 1, macLine + 17);
  const payloadKey = hkdf(fileKey, nonce, "payload");
  const payload = buf.subarray(macLine + 17);
  const out = [];
  const n = Math.max(1, Math.ceil(payload.length / (CHUNK + 16)));
  for (let i = 0; i < n; i++) out.push(open(payloadKey, streamNonce(i, i === n - 1), payload.subarray(i * (CHUNK + 16), (i + 1) * (CHUNK + 16))));
  return Buffer.concat(out);
}

/** A ustar archive of `files` ({path: bytes}): names sorted, mode 0644, owner and time 0, as obid packs one. */
export function tar(files) {
  const blocks = [];
  for (const name of Object.keys(files).sort()) {
    const body = Buffer.from(files[name]);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
