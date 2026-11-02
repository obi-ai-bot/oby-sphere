// The scripted adversarial peers and the record they are judged from.
//
// A peer is a member the harness plays in full: its owner's key, its own key and seal key, the
// requests it sends. What the implementation under test sends is read from the Sphere's audit chain,
// which holds every message the Sphere relayed to a peer in relay order: each is verified as its
// addressee would (protocol.md section 10, with the addressee's seal keys) and its words opened, so
// sealed words are judged like any others.

import { randomUUID } from "node:crypto";
import { Owner, cardSealKey, directoryKeys, newKey, newSealKey, nowSeconds, sleep, spec, timestamp } from "./sphere.mjs";

export const PEER_SCOPES = "send:review_request send:question send:handoff reply receive directory:read audit:read";

export class Peer {
  constructor(client, id, ownerId, { owner } = {}) {
    this.client = client;
    this.id = id;
    this.owner = owner ?? new Owner(client, ownerId);
    this.key = newKey();
    this.seal = newSealKey();
    this.token = null;
    this.draining = false;
  }

  /** Joins through a named invitation the admin makes, and gets its token. */
  async join(adminToken, name) {
    const c = this.client;
    const inv = await c.must("POST", c.path("/invitations"), { token: adminToken, body: { owner: this.owner.id, obi: this.id, expires_in: 3600 } }, 201);
    const card = this.owner.card(this, { name, accepts: ["question"] });
    await c.must("POST", c.path(`/invitations/${inv.invitation_id}/redeem`), { body: { secret: inv.secret, owner_key: this.owner.key.publicKey, card } }, 201);
    await this.exchange();
  }

  async exchange() {
    const delegation = this.owner.assertion(PEER_SCOPES, { lifetime: 3600, mayAct: this.id });
    const iat = nowSeconds();
    const actor = spec.signJwt({ iss: this.id, sub: this.id, aud: `obi-sphere:${this.client.sphere}`, iat, exp: iat + 300, jti: randomUUID() }, this.key.privateKey, this.key.keyId);
    const r = await this.client.call("POST", "/v0.1/oauth/token", {
      form: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: delegation, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", actor_token: actor, actor_token_type: "urn:ietf:params:oauth:token-type:jwt" },
    });
    if (r.status !== 200) throw new Error(`token for ${this.id}: ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.access_token;
  }

  /** A signed request of `type` to `to`, sealed when `toSeal` (the receiver's seal key) is given. */
  request(to, type, body, { expiresIn = 3600, toSeal = null } = {}) {
    const id = randomUUID();
    const created = nowSeconds();
    const unsigned = { protocol: "obi/0.1", id, type, from: this.id, to, sphere: this.client.sphere, correlation_id: id, created_at: timestamp(created), expires_at: timestamp(created + expiresIn), key_id: this.key.keyId, body };
    return spec.signEnvelope(toSeal ? spec.sealEnvelope(unsigned, toSeal) : unsigned, this.key.privateKey);
  }

  async send(envelope) {
    const r = await this.client.call("POST", this.client.path("/messages"), { token: this.token, body: envelope });
    if (r.status !== 202) throw new Error(`${this.id}'s ${envelope.type}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }

  /**
   * Fetches and acknowledges its deliveries in the background until stopDraining(): a peer reads its
   * mail. It keeps every envelope it was delivered (by id) so a case can watch, live, what has
   * reached it; final judging reads the authoritative, verified record from the chain (readRecord).
   */
  startDraining() {
    this.draining = true;
    this.received = new Map();
    this.drained = (async () => {
      while (this.draining) {
        try {
          const r = await this.client.call("GET", this.client.path("/deliveries?wait=2"), { token: this.token });
          if (r.status === 401) await this.exchange();
          const ds = r.status === 200 ? r.body.deliveries : [];
          for (const d of ds) if (!this.received.has(d.envelope.id)) this.received.set(d.envelope.id, { env: d.envelope, seq: d.seq });
          if (ds.length) await this.client.call("POST", this.client.path("/deliveries/ack"), { token: this.token, body: { delivery_ids: ds.map((d) => d.delivery_id) } });
          else await sleep(200);
        } catch {
          await sleep(500);
        }
      }
    })();
  }

  /** The envelopes this peer has been delivered whose `correlation_id` is `cid`, oldest first. */
  repliesTo(cid) {
    return [...this.received.values()].filter((r) => r.env.correlation_id === cid).sort((a, b) => a.seq - b.seq);
  }

  async stopDraining() {
    this.draining = false;
    await this.drained;
  }
}

/**
 * Everything in the chain, read with an admin token: each entry's envelope, and for what reached a
 * peer, the addressee's verdict and the opened body. `peers` maps an obi_id to its Peer.
 */
export async function readRecord(client, adminToken, peers) {
  const entries = [];
  for (let from = 1; ; ) {
    const page = await client.must("GET", client.path(`/audit?from_seq=${from}&limit=1000`), { token: adminToken }, 200);
    entries.push(...page.entries);
    if (!page.entries.length || page.entries.at(-1).seq >= page.head.seq) break;
    from = page.entries.at(-1).seq + 1;
  }
  const members = (await client.must("GET", client.path("/members"), { token: adminToken }, 200)).members;
  const keys = directoryKeys(members);
  const cards = Object.fromEntries(members.map((m) => [m.obi, m.card]));
  const seen = {};
  const record = entries.map((entry) => {
    const env = entry.envelope;
    const peer = peers[env.to];
    const out = { seq: entry.seq, recorded_at: entry.recorded_at, env, opened: env.body, verdict: null };
    if (!peer) return out;
    seen[peer.id] ??= [];
    out.verdict = spec.verifyEnvelope(env, {
      now: entry.recorded_at, sphere: client.sphere, receiver: peer.id, keys, seq: entry.seq, seen_ids: seen[peer.id],
      seal_keys: { [peer.seal.keyId]: spec.b64url(peer.seal.raw) }, sender_seals: cardSealKey(cards[env.from]) !== null,
    });
    seen[peer.id].push(env.id);
    if (env.seal && env.seal.key_id === peer.seal.keyId) {
      try {
        out.opened = spec.openBody(env, peer.seal.raw);
      } catch {
        out.opened = null;
      }
    }
    return out;
  });
  const chain = spec.verifyChain({ sphere: client.sphere, entries }, { keys });
  return { entries, record, members, chain };
}
