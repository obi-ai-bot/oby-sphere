// The owner's key under a passphrase, and what the owner signs with it.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SigningKey } from "@obysphere/client";
import { allows, signStatement, verifyStatement, type Decision, type Rules } from "../src/signed.ts";
import { openOwnerKey, sealOwnerKey } from "../src/vault.ts";

test("the owner's key opens with its passphrase only", async () => {
  const key = await SigningKey.generate();
  const sealed = sealOwnerKey(key, "correct horse battery");
  assert.ok(!JSON.stringify(sealed).includes(key.seed));
  assert.equal((await openOwnerKey(sealed, "correct horse battery")).publicKey, key.publicKey);
  await assert.rejects(openOwnerKey(sealed, "wrong horse battery"), /passphrase/);
  await assert.rejects(openOwnerKey({ ...sealed, public_key: (await SigningKey.generate()).publicKey }, "correct horse battery"), /passphrase/);
  assert.throws(() => sealOwnerKey(key, "short"), /at least/);
});

test("a decision verifies with the owner's key only, and not once changed", async () => {
  const owner = await SigningKey.generate();
  const other = await SigningKey.generate();
  const d: Decision = { kind: "decision", sphere: "acme", obi: "dee-agent", item: `in-${crypto.randomUUID()}`, decision: "approve", digest: "0".repeat(64), at: "2026-10-27T12:00:00Z" };
  const signed = await signStatement(d, owner);
  assert.ok(await verifyStatement(signed, owner.publicKey));
  assert.equal(await verifyStatement(signed, other.publicKey), false);
  assert.equal(await verifyStatement({ ...signed, decision: "decline" }, owner.publicKey), false);
  assert.equal(await verifyStatement({ ...signed, kind: "rules" }, owner.publicKey), false);
  assert.equal(await verifyStatement({ ...d }, owner.publicKey), false);
});

test("the rules let through only what they name", async () => {
  const rules: Rules = { kind: "rules", sphere: "acme", obi: "dee-agent", version: 1, at: "2026-10-27T12:00:00Z", send: [{ to: "*", actions: ["question"] }, { to: "oby-ada", actions: ["handoff"] }] };
  assert.ok(allows(rules, "anyone", "question"));
  assert.ok(allows(rules, "oby-ada", "handoff"));
  assert.equal(allows(rules, "someone", "handoff"), false);
  assert.equal(allows(rules, "oby-ada", "review_request"), false);
  assert.equal(allows(null, "oby-ada", "question"), false);
});
