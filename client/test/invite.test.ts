// Invite links as sphere-api.md section 4 writes them, and as Oby writes and reads them.

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InviteLinkError, formatInviteLink, openedInviteLink, parseInviteLink, sphereBase } from "../src/index.ts";

const ID = "9187a87a-3126-424c-8861-8811bba1a5ec";
const SECRET = "A".repeat(43);
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "conformance", "invite-link-vectors.json");

test("the spec's invite-link vectors: every valid link reads as it says, every invalid one is refused", { skip: !existsSync(VECTORS) && "the vectors are not in this spec checkout yet" }, () => {
  const v = JSON.parse(readFileSync(VECTORS, "utf8"));
  for (const c of v.valid) {
    const l = parseInviteLink(c.link);
    const { for: owner, ...rest } = c.fields;
    assert.deepEqual(l, { ...rest, ...(owner !== undefined ? { owner } : {}) }, c.name);
    assert.deepEqual(parseInviteLink(formatInviteLink(l)), l, `${c.name}, written and read again`);
  }
  for (const c of v.invalid) assert.throws(() => parseInviteLink(c.link), InviteLinkError, c.name);
  for (const c of v.opened ?? []) assert.equal(openedInviteLink(c.opened, v.scheme), c.link ?? null, c.name);
});

test("an open invitation's link", () => {
  const l = parseInviteLink(`https://sphere.example.com/join#sphere=acme&name=Acme%20Team&by=ada&id=${ID}&secret=${SECRET}`);
  assert.deepEqual(l, { base: "https://sphere.example.com", sphere: "acme", id: ID, secret: SECRET, name: "Acme Team", by: "ada" });
});

test("`+` is a plus, the first occurrence wins, unknown keys are ignored", () => {
  const secret = "a+b".padEnd(43, "c").replace("+", "_");
  const l = parseInviteLink(`http://127.0.0.1:8792/join#sphere=a&id=${ID}&secret=${secret}&secret=other&extra=1&name=x+y`);
  assert.equal(l.secret, secret);
  assert.equal(l.name, "x+y");
  assert.equal(l.base, "http://127.0.0.1:8792");
});

test("a named invitation has both `for` and `obi`", () => {
  const l = parseInviteLink(`https://s.example.com/join#sphere=acme&name=Acme&by=ada&for=bea&obi=bea-agent&id=${ID}&secret=${SECRET}`);
  assert.equal(l.owner, "bea");
  assert.equal(l.obi, "bea-agent");
  assert.throws(() => parseInviteLink(`https://s.example.com/join#sphere=d&for=bea&id=${ID}&secret=${SECRET}`), InviteLinkError);
  assert.throws(() => parseInviteLink(`https://s.example.com/join#sphere=d&obi=bea-agent&id=${ID}&secret=${SECRET}`), InviteLinkError);
});

test("links this client refuses", () => {
  const ok = `id=${ID}&secret=${SECRET}`;
  for (const bad of [
    "https://s.example.com/join",
    `https://s.example.com/join#sphere=d&id=${ID}`,
    `https://s.example.com/join#sphere=&${ok}`,
    `http://s.example.com/join#sphere=d&${ok}`,
    `https://s.example.com/x/join#sphere=d&${ok}`,
    `https://s.example.com/join?a=b#sphere=d&${ok}`,
    `https://me@s.example.com/join#sphere=d&${ok}`,
    `https://s.example.com/join#sphere=d&name=%E0%A4%A&${ok}`,
    `https://s.example.com/join#sphere=..%2Fx&${ok}`,
    `https://s.example.com/join#sphere=d&id=inv-1&secret=${SECRET}`,
    `oby://join/s.example.com#sphere=d&${ok}`,
  ]) assert.throws(() => parseInviteLink(bad), InviteLinkError, bad);
  assert.equal(sphereBase("http://[::1]:8792"), "http://[::1]:8792");
  assert.equal(sphereBase("http://localhost:8792/"), "http://localhost:8792");
});

test("a link written and read again is the same", () => {
  const link = { base: "https://s.example.com", sphere: "acme", name: "A & B = C+", by: "ada", owner: "bea", obi: "obi-bea", id: ID, secret: "x".repeat(43) };
  const text = formatInviteLink(link);
  assert.ok(text.startsWith(`https://s.example.com/join#sphere=acme&name=A%20%26%20B%20%3D%20C%2B&by=ada&for=bea&obi=obi-bea&id=${ID}&secret=`));
  assert.deepEqual(parseInviteLink(text), link);
});
