// The owner's key, kept on the member's machine encrypted with a passphrase only the owner knows:
// scrypt makes a key from the passphrase, AES-256-GCM seals the key's seed with it. Every decision
// the owner makes (approve, decline, the rules) is signed with this key, so the host's agent, which
// runs as the same user but doesn't know the passphrase, can't make one. The passphrase is read
// from the terminal with echo off, or from standard input with --passphrase-stdin.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { ReadStream } from "node:tty";
import { SigningKey, b64url, fromB64url } from "@obysphere/client";

export interface SealedOwnerKey {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  /** The seed, encrypted. */
  ciphertext: string;
  tag: string;
  public_key: string;
  key_id: string;
}

const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

const derive = (passphrase: string, salt: Uint8Array, k: { N: number; r: number; p: number }) =>
  scryptSync(passphrase.normalize("NFC"), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 128 * k.N * k.r * 2 });

export function sealOwnerKey(key: SigningKey, passphrase: string): SealedOwnerKey {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase has at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(Buffer.from(key.publicKey, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(fromB64url(key.seed)), cipher.final()]);
  return {
    v: 1, kdf: "scrypt", ...SCRYPT, salt: b64url(salt), iv: b64url(iv), ciphertext: b64url(ciphertext), tag: b64url(cipher.getAuthTag()),
    public_key: key.publicKey, key_id: key.keyId,
  };
}

/** The owner's key, or an error saying the passphrase is wrong. */
export async function openOwnerKey(sealed: SealedOwnerKey, passphrase: string): Promise<SigningKey> {
  let seed: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derive(passphrase, fromB64url(sealed.salt), sealed), fromB64url(sealed.iv));
    decipher.setAAD(Buffer.from(sealed.public_key, "utf8"));
    decipher.setAuthTag(fromB64url(sealed.tag));
    seed = Buffer.concat([decipher.update(fromB64url(sealed.ciphertext)), decipher.final()]);
  } catch {
    throw new Error("that passphrase doesn't open the owner's key");
  }
  const key = await SigningKey.fromSeed(seed);
  if (key.publicKey !== sealed.public_key) throw new Error("the owner's key file is damaged");
  return key;
}

/** One line from standard input (for --passphrase-stdin): the owner's own scripts. */
export async function passphraseFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const line = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  if (!line) throw new Error("no passphrase on standard input");
  return line;
}

/** Asks on the terminal itself (/dev/tty), echo off: what a person types, not what a pipe holds. */
export async function passphraseFromTerminal(prompt: string): Promise<string> {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("no terminal to ask the owner's passphrase on: run this in a terminal, or pass --passphrase-stdin");
  }
  const input = new ReadStream(fd);
  const out = (s: string) => process.stderr.write(s);
  out(prompt);
  input.setRawMode(true);
  try {
    return await new Promise<string>((done, failed) => {
      let text = "";
      input.on("data", (data: Buffer) => {
        for (const ch of data.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            out("\n");
            return done(text);
          }
          if (ch === "\u0003") return failed(new Error("cancelled"));
          if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
          else text += ch;
        }
      });
    });
  } finally {
    input.setRawMode(false);
    input.destroy();
    try {
      closeSync(fd);
    } catch {}
  }
}
