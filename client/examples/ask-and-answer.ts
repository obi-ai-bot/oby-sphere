// #55's "done when", with nothing but the library: two members join a Sphere with an invite link,
// one asks the other a question, the other receives it and answers, the first receives the answer,
// and the chain verifies.
//
//   OBYSPHERE_URL=http://127.0.0.1:8792 SPHERE_OPERATOR_TOKEN=… node examples/ask-and-answer.ts [--chain-out <file>]
//
// The operator token only makes a fresh Sphere for the run (its admin plays the inviting owner);
// on a Sphere someone else runs, a member starts at step 2 with the link they were sent.
// --chain-out writes the chain and every member's keys, for checking with another verifier.

import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DataText, Member, Owner, SealKey, SigningKey, SphereApi, formatInviteLink, type Received } from "../src/index.ts";

const base = process.env.OBYSPHERE_URL ?? "http://127.0.0.1:8792";
const operatorToken = process.env.SPHERE_OPERATOR_TOKEN;
if (!operatorToken) throw new Error("SPHERE_OPERATOR_TOKEN is needed to make the Sphere for this run");
const chainOut = process.argv.includes("--chain-out") ? process.argv[process.argv.indexOf("--chain-out") + 1] : undefined;
const step = (n: number, what: string) => console.log(`\n${n}. ${what}`);

const api = new SphereApi(base);
const health = await api.health();
const sphere = `lib-${randomBytes(3).toString("hex")}`;
const features = await api.features();
console.log(`The Obysphere at ${base} takes: ${features.join(", ") || "no additions"}${features.includes("dpop") ? " (so tokens are bound to a key of this process)" : ""}${features.includes("sphere_url_aud") ? " (and assertions name the server)" : ""}`);

step(1, `An admin makes the Sphere ${sphere}, a policy that lets members ask each other, and an invite link for two`);
const ada = await Owner.generate("ada");
await api.createSphere(operatorToken, { sphere, name: "Library example", admin: { owner: ada.id, owner_key: ada.key.publicKey } });
const adminToken = (await ada.token(api, sphere)).access_token;
await api.putPolicy(adminToken, sphere, { expected_version: 0, rules: [{ id: "questions", from_owner: "*", to_owner: "*", actions: ["question"], repos: ["*"] }] });
const invitation = await api.createInvitation(adminToken, sphere, { expires_in: 3600, max_uses: 2 });
const link = formatInviteLink({ base, sphere, name: "Library example", by: ada.id, id: invitation.invitation_id, secret: invitation.secret });
console.log(`   link: ${link.replace(/secret=[^&]+/, "secret=…")}`);

step(2, `Two members join with the link, each card and delegation signed by its own owner${health.seal ? ", each with a seal key" : ""}`);
const join = async (owner: Owner, obi: string) =>
  Member.join({
    link, owner, obi, key: await SigningKey.generate(), ...(health.seal ? { sealKey: await SealKey.generate() } : {}),
    accepts: ["question"], name: `${owner.id}'s agent`, description: "An example member made with the client library.", version: "0.1.0",
  });
const asker = await join(ada, "ada-agent");
const answerer = await join(await Owner.generate("bea"), "bea-agent");
for (const p of await asker.directory()) console.log(`   ${p.obi} (owner ${p.owner}): fingerprint ${p.fingerprint}, ${p.trusted ? "trusted" : `not trusted: ${p.problem}`}${p.sealPublicKey ? ", seals" : ""}`);

step(3, "ada-agent asks bea-agent a question");
const asked = await asker.ask("bea-agent", { text: "Is the release branch ready to cut?", choices: ["yes", "not yet"] });
console.log(`   sent ${asked.id}: recorded at seq ${asked.receipt.seq}${asked.envelope.seal ? ", its words sealed" : ""}`);

async function next(member: Member, type: string): Promise<Received> {
  for (let i = 0; i < 10; i++) {
    for (const r of await member.receive({ wait: 5 })) {
      if (r.problem) throw new Error(`${member.id} refused a delivery: ${r.problem.code} ${r.problem.message}`);
      if (r.message?.type === type) return r;
    }
  }
  throw new Error(`${member.id}: no ${type} arrived`);
}

step(4, "bea-agent receives it, checked and opened, its words as data, and answers");
const q = await next(answerer, "question");
const words = q.message!.body.text as DataText;
console.log(`   from ${q.message!.from} (owner ${q.message!.owner}) at seq ${q.seq}; a bare string? ${typeof words === "string"}`);
console.log(words.quote().split("\n").map((l) => `   | ${l}`).join("\n"));
const answered = await answerer.answer(q.message!.id, { text: "Not yet: two checks are still running.", choice: 1 });
await answerer.ack([q.delivery_id]);
console.log(`   answered ${answered.id}: recorded at seq ${answered.receipt.seq}`);

step(5, "ada-agent receives the answer");
const a = await next(asker, "answer");
console.log(`   ${a.message!.type} to ${a.message!.request?.id} from ${a.message!.from}, choice ${a.message!.body.choice}, by ${a.message!.body.by}`);
console.log(`   ${(a.message!.body.text as DataText).quote().split("\n").join("\n   | ")}`);
await asker.ack([a.delivery_id]);

step(6, "ada-agent verifies the whole chain: hashes, links, every signature with the key valid at its seq, the exchange rules, and its own sends");
const verdict = await asker.verifyChain();
if (!verdict.ok) throw new Error(`the chain does not verify: ${verdict.code} ${verdict.message}`);
console.log(`   ok: ${verdict.entries.length} entries, head seq ${verdict.head.seq} ${verdict.head.hash}; signed with keys no trusted card named: ${verdict.unvouched.length ? verdict.unvouched.join(", ") : "none"}`);
for (const e of verdict.entries) console.log(`   seq ${e.seq}  ${e.type.padEnd(8)} ${e.from} -> ${e.to}  ${e.sealed ? "sealed" : "in the clear"}  ${e.hash.slice(0, 16)}…`);

if (chainOut) {
  // The member's own API: its token may be bound to a key of its own (DPoP), which only it sends proofs for.
  const members = await asker.api.members(await asker.accessToken(), sphere);
  const keys: Record<string, unknown> = {};
  for (const m of members) for (const k of m.keys) keys[k.key_id] = { obi: m.obi, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq };
  writeFileSync(chainOut, JSON.stringify({ chain: { sphere, entries: verdict.raw() }, keys }, null, 2));
}
console.log("\nDone: joined, asked, received, answered, received, and the chain verifies.");
