// The connector: one member of one Sphere, its keys and mailbox in its folder (home.ts), built on
// the client library. It receives and checks every delivery, puts every request in its owner's
// mailbox to wait for their decision, applies the decisions the owner signs (signed.ts), sends
// what the host's agent asks for within the owner's rules (or holds it for the owner), and scans
// everything outgoing for secrets first (scan.ts). The host's agent sees others' words only as
// quoted data (render.ts), and a request's words only once the owner has approved it.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import {
  Member, SealKey, SigningKey, SphereApi, SphereError, canonicalize, emptyMemory, fromB64url, nowSeconds, resultProblems, schemaErrors, seconds, timestamp,
  type JsonObject, type MemberMemory, type Peer, type Received, type ReceivedMessage, type SchemaName,
} from "@obysphere/client";
import { Home } from "./home.ts";
import { scanOutgoing, type ScanOptions } from "./scan.ts";
import { allows, isDecision, verifyStatement, type Decision, type Rules } from "./signed.ts";

export const VERSION = "0.1.0";
/** How many requests from one owner may wait for this member's owner at once (protocol.md section 11, "Rate limits"). */
export const INBOX_LIMIT = 5;
/** How long an owner's signed decision stays good to apply. */
export const DECISION_FRESH_SECONDS = 900;
/** After a member declines `busy` with nothing else of ours open to it, how long before the agent may ask it again (protocol.md section 11). */
export const BUSY_BACKOFF_SECONDS = 3600;
/** A finished item is forgotten this long after it expired. */
export const KEEP_FINISHED_SECONDS = 30 * 86400;

/** member.json: the membership. `key_seed` and `seal_private` are secret. */
export interface MemberFile {
  v: 1;
  base: string;
  sphere: string;
  obi: string;
  owner: string;
  /** The owner's public key: the one the Sphere bound. */
  owner_key: string;
  key_seed: string;
  seal_private?: string;
  delegation: string;
  delegation_expires_at: string;
  accepts: string[];
  name: string;
  description: string;
  joined_at: string;
  /** Options for the outgoing scan. */
  scan?: Pick<ScanOptions, "gitleaks" | "gitleaksPath">;
}

/** state.json: what the connector itself keeps besides the library's memory. */
interface ConnectorState {
  /** The highest rules version applied: an older rules file never replaces it. */
  rules_version: number;
  /** Members that declined `busy`: when, and our requests that were open to them then (protocol.md section 11, "Rate limits"). */
  busy: Record<string, { at: number; open: string[] }>;
}

export type ItemState =
  | "waiting_on_owner" // in: the owner hasn't decided; out: held until the owner approves sending it
  | "approved" // in: the owner said yes; the agent may reply
  | "declined" // in: the owner said no (a decline was sent); out: the other member declined
  | "replied" // in: an answer, a result or a decline went out
  | "not_sent" // out: the owner declined to send it
  | "sent" // out: recorded by the Sphere, no reply yet
  | "accepted" // out: the other member accepted
  | "answered" // out: an answer or a result came back
  | "expired"
  | "cancelled"; // in: its sender called it off (protocol.md 5.17)

export interface Reply {
  id: string;
  type: string;
  from: string;
  at: string;
  body: JsonObject;
}

export interface Item {
  /** `in-` and the incoming request's id, or `out-` and a local id: never one the other side chose alone. */
  id: string;
  direction: "in" | "out";
  type: string;
  peer: string;
  peer_owner?: string;
  state: ItemState;
  created_at: string;
  expires_at: string;
  /** The request's body, its words in plain text: in this member's folder only. */
  body: JsonObject;
  /** SHA-256 of what the owner decides on (type, peer, body): a decision names it. */
  digest: string;
  replies: Reply[];
  /** Ids of every reply seen on it, a status dropped since included: a redelivery adds nothing. */
  seen_replies?: string[];
  /** In: the request's id. Out: the id of the request as sent. */
  request_id?: string;
  /** Out: its lifetime in seconds, to send it with. */
  expires_in?: number;
  decided?: { decision: Decision["decision"]; at: string; reason?: string };
  /** The connector's own words about what happened: never another member's. */
  log: string[];
}

export class ConnectorError extends Error {}

export const itemDigest = (item: Pick<Item, "type" | "peer" | "body">): string =>
  createHash("sha256").update(canonicalize({ type: item.type, peer: item.peer, body: item.body }), "utf8").digest("hex");

const findingId = (file: string, line: number, title: string) =>
  "f-" + createHash("sha256").update(`${file}\n${line}\n${title}`, "utf8").digest("hex").slice(0, 16);

const ITEM_ID = /^(in|out)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN: ItemState[] = ["waiting_on_owner", "approved", "sent", "accepted"];
/** An outgoing request the other member has and hasn't finished. */
const SENT_OPEN: ItemState[] = ["sent", "accepted"];

export class Connector {
  readonly home: Home;
  file: MemberFile;
  readonly member: Member;
  readonly events = new EventEmitter();
  #boundOwnerKey: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(home: Home, file: MemberFile, member: Member) {
    this.home = home;
    this.file = file;
    this.member = member;
  }

  static async open(home: Home): Promise<Connector> {
    if (!home.exists("member.json")) throw new ConnectorError(`no membership in ${home.dir}: join first (obysphere-connector join <invite link>)`);
    const loose = home.looseModes();
    if (loose.length) throw new ConnectorError(`others can read ${loose.join(", ")}: make them this user's only (chmod go-rwx)`);
    const file = home.readJson<MemberFile>("member.json");
    const memory = home.readJsonOr<MemberMemory>("memory.json", emptyMemory());
    const member = new Member({
      api: new SphereApi(file.base), sphere: file.sphere, obi: file.obi, owner: file.owner, ownerKey: file.owner_key,
      key: await SigningKey.fromSeed(fromB64url(file.key_seed)),
      ...(file.seal_private ? { sealKey: await SealKey.fromPrivate(fromB64url(file.seal_private)) } : {}),
      delegation: file.delegation, memory,
    });
    return new Connector(home, file, member);
  }

  /** Runs `fn` after every earlier call has finished: one change to the mailbox at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  // ---------------------------------------------------------------------------------------------
  // State on disk.

  items(): Item[] {
    return this.home.list("items").map((n) => this.home.readJson<Item>(`items/${n}`));
  }

  /** An item by its id; a bare request id names the incoming item for it. */
  item(id: string): Item | undefined {
    if (!ITEM_ID.test(id) && ITEM_ID.test(`in-${id}`)) id = `in-${id}`;
    if (!ITEM_ID.test(id)) return undefined;
    return this.home.exists(`items/${id}.json`) ? this.home.readJson<Item>(`items/${id}.json`) : undefined;
  }

  #save(item: Item) {
    this.home.writeJson(`items/${item.id}.json`, item);
    this.events.emit("changed", item.id);
  }

  #saveMemory() {
    this.home.writeJson("memory.json", this.member.memory);
  }

  #state(): ConnectorState {
    return { rules_version: 0, busy: {}, ...this.home.readJsonOr<Partial<ConnectorState>>("state.json", {}) };
  }

  #saveState(s: ConnectorState) {
    this.home.writeJson("state.json", s);
  }

  #note(what: string) {
    try {
      appendFileSync(this.home.path("connector.log"), `${new Date().toISOString()} ${what}\n`, { mode: 0o600 });
    } catch {}
  }

  /** The owner key the Sphere bound for this member's owner: what owner-signed statements must verify with. */
  async boundOwnerKey(): Promise<string> {
    if (this.#boundOwnerKey) return this.#boundOwnerKey;
    const me = await this.member.api.member(await this.token(), this.file.sphere, this.file.obi);
    if (me.owner_key !== this.file.owner_key) throw new ConnectorError("the Sphere's bound owner key isn't the one this connector joined with: refusing to act on any decision");
    this.#boundOwnerKey = me.owner_key;
    return me.owner_key;
  }

  async token(): Promise<string> {
    try {
      return await this.member.accessToken();
    } catch (e) {
      if (e instanceof SphereError && e.code === "invalid_grant") {
        // The owner may have renewed the delegation since this connector started.
        const fresh = this.home.readJson<MemberFile>("member.json");
        if (fresh.delegation !== this.member.delegation) {
          this.file = fresh;
          this.member.delegation = fresh.delegation;
          return this.member.accessToken();
        }
        if (seconds(this.file.delegation_expires_at) <= nowSeconds()) throw new ConnectorError("the owner's delegation expired: the owner renews it with `obysphere-connector renew`");
      }
      throw e;
    }
  }

  /** The owner's rules, when they verify with the owner's key and aren't older than rules applied before. */
  async rules(): Promise<Rules | null> {
    const rules = this.home.readJsonOr<Rules | null>("rules.json", null);
    if (!rules || rules.kind !== "rules" || rules.sphere !== this.file.sphere || rules.obi !== this.file.obi) return null;
    if (!(await verifyStatement(rules, await this.boundOwnerKey()))) return null;
    const state = this.#state();
    if (rules.version < state.rules_version) {
      this.#note(`ignored rules version ${rules.version}: version ${state.rules_version} was applied before`);
      return null;
    }
    if (rules.version > state.rules_version) this.#saveState({ ...state, rules_version: rules.version });
    return rules;
  }

  // ---------------------------------------------------------------------------------------------
  // Receiving.

  /** One round: expired items settled, the owner's decisions applied, the deliveries waiting checked and recorded. */
  async poll(wait = 0): Promise<number> {
    await this.serial(async () => this.#expire());
    await this.serial(() => this.applyDecisions());
    const received = await this.member.receive({ wait });
    if (!received.length) return 0;
    await this.serial(async () => {
      for (const r of received) await this.#handle(r);
      this.#saveMemory();
      // Acknowledged only once what was decided is on disk (protocol.md section 11).
      await this.member.ack(received.map((r) => r.delivery_id));
    });
    return received.length;
  }

  async #handle(r: Received) {
    if (r.problem) {
      this.#note(`refused delivery ${r.delivery_id} at seq ${r.seq}: ${r.problem.code} (${r.problem.message})`);
      return;
    }
    const m = r.message!;
    if (m.in_reply_to) return this.#handleReply(m, r);
    return this.#handleRequest(m, r);
  }

  /** A request: in the mailbox to wait for the owner, or declined at once, and then kept nowhere but the log. */
  async #handleRequest(m: ReceivedMessage, r: Received) {
    const id = `in-${m.id}`;
    // A delivery seen before (its acknowledgement lost): what was decided about it stands, a decline
    // sent at once included (protocol.md section 11, step 2).
    if (this.home.exists(`items/${id}.json`)) return;
    if ((this.member.memory.exchanges[m.id]?.replies ?? []).some((e) => e.from === this.file.obi)) return;
    const body = plainBody(m.body);
    const decline = async (reason: string, why: string) => {
      this.#note(`declined ${m.type} ${m.id} from ${m.from}: ${reason} (${why})`);
      await this.#sendReply(m.id, "decline", { reason }).catch((e) => this.#note(`the decline of ${m.id} didn't go out: ${(e as Error).message}`));
    };
    if (!this.file.accepts.includes(m.type)) return decline("out_of_scope", "this member doesn't accept it");
    const waiting = this.items().filter((i) => i.direction === "in" && i.state === "waiting_on_owner" && i.peer_owner === m.owner);
    if (waiting.length >= INBOX_LIMIT) return decline("busy", `${waiting.length} requests from ${m.owner} already wait for the owner`);
    const same = (i: Item) => i.type === m.type && canonicalize(i.body.text ?? null) === canonicalize(body.text ?? null) && canonicalize(i.body.about ?? null) === canonicalize(body.about ?? null);
    if (m.type === "question" && this.items().some((i) => i.direction === "in" && OPEN.includes(i.state) && i.peer_owner === m.owner && same(i))) {
      return decline("busy", "the same question from that owner is open already");
    }
    const item: Item = {
      id, direction: "in", type: m.type, peer: m.from, peer_owner: m.owner, state: "waiting_on_owner", created_at: timestamp(nowSeconds()),
      expires_at: m.expires_at, body, digest: "", replies: [], request_id: m.id, log: [`received at seq ${r.seq}`],
    };
    item.digest = itemDigest(item);
    this.#save(item);
    await this.#sendReply(m.id, "status", { state: "waiting_on_owner" }).catch((e) => this.#note(`status for ${m.id} didn't go out: ${(e as Error).message}`));
  }

  async #handleReply(m: ReceivedMessage, r: Received) {
    // A cancel comes from a request's own sender: it calls off a request to this member.
    if (m.type === "cancel") {
      const called = this.items().find((i) => i.direction === "in" && i.request_id === m.in_reply_to);
      if (!called) return this.#note(`a cancel of ${m.in_reply_to}, which isn't in this mailbox`);
      if (called.replies.some((x) => x.id === m.id)) return;
      called.replies.push({ id: m.id, type: "cancel", from: m.from, at: timestamp(nowSeconds()), body: {} });
      called.state = "cancelled";
      called.log.push(`called off by its sender at seq ${r.seq}`);
      return this.#save(called);
    }
    const item = this.items().find((i) => i.direction === "out" && i.request_id === m.in_reply_to);
    if (!item) {
      this.#note(`a ${m.type} to ${m.in_reply_to}, which no item of this mailbox sent`);
      return;
    }
    if (item.replies.some((x) => x.id === m.id) || item.seen_replies?.includes(m.id)) return;
    item.seen_replies = [...(item.seen_replies ?? []), m.id];
    // Only the latest status is kept: a member can send any number, and each would be shown again.
    if (m.type === "status") item.replies = item.replies.filter((x) => x.type !== "status");
    item.replies.push({ id: m.id, type: m.type, from: m.from, at: timestamp(nowSeconds()), body: plainBody(m.body) });
    if (m.type === "accept") item.state = "accepted";
    else if (m.type === "answer" || m.type === "result") item.state = "answered";
    else if (m.type === "decline") {
      item.state = "declined";
      if ((m.body as JsonObject).reason === "busy") {
        const state = this.#state();
        // Only requests that reached it count: one its owner still holds was never sent.
        const open = this.items().filter((i) => i.direction === "out" && i.peer === item.peer && i.id !== item.id && SENT_OPEN.includes(i.state)).map((i) => i.id);
        this.#saveState({ ...state, busy: { ...state.busy, [item.peer]: { at: nowSeconds(), open } } });
      }
    }
    item.log.push(`${m.type} received at seq ${r.seq}`);
    this.#save(item);
  }

  #expire() {
    const now = nowSeconds();
    for (const item of this.items()) {
      if (OPEN.includes(item.state) && seconds(item.expires_at) <= now) {
        item.state = "expired";
        item.log.push("expired");
        this.#save(item);
      } else if (!OPEN.includes(item.state) && seconds(item.expires_at) + KEEP_FINISHED_SECONDS < now) {
        this.home.remove(`items/${item.id}.json`);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The owner's decisions.

  /** Applies every decision waiting in decisions/ that the owner signed, for an unexpired item that waits for one and is what the owner saw. */
  async applyDecisions(): Promise<void> {
    const names = this.home.list("decisions");
    if (!names.length) return;
    const ownerKey = await this.boundOwnerKey();
    for (const name of names) {
      const path = `decisions/${name}`;
      let d: unknown;
      try {
        d = this.home.readJson(path);
      } catch {
        this.home.remove(path);
        continue;
      }
      this.home.remove(path);
      if (!isDecision(d) || d.sphere !== this.file.sphere || d.obi !== this.file.obi) {
        this.#note(`ignored ${name}: not a decision for this member`);
        continue;
      }
      if (!(await verifyStatement(d, ownerKey))) {
        this.#note(`ignored ${name}: not signed by the owner's key`);
        continue;
      }
      const age = nowSeconds() - seconds(d.at);
      if (!(age <= DECISION_FRESH_SECONDS && age >= -300)) {
        this.#note(`ignored ${name}: signed at ${d.at}, not within ${DECISION_FRESH_SECONDS} seconds`);
        continue;
      }
      const item = this.item(d.item);
      if (!item || item.state !== "waiting_on_owner") {
        this.#note(`ignored ${name}: ${d.item} doesn't wait for a decision`);
        continue;
      }
      if (d.digest !== item.digest || itemDigest(item) !== item.digest) {
        this.#note(`ignored ${name}: ${d.item} isn't what the owner decided on`);
        continue;
      }
      if (seconds(item.expires_at) <= nowSeconds()) {
        this.#note(`ignored ${name}: ${d.item} expired`);
        continue;
      }
      await this.#apply(item, d);
    }
  }

  async #apply(item: Item, d: Decision) {
    item.decided = { decision: d.decision, at: d.at, ...(d.reason ? { reason: d.reason } : {}) };
    try {
      if (item.direction === "in" && d.decision === "approve") {
        if (item.type !== "question") await this.#sendReply(item.request_id!, "accept", {});
        item.state = "approved";
        item.log.push("approved by the owner");
      } else if (item.direction === "in" && d.decision === "answer") {
        if (item.type !== "question") throw new ConnectorError("only a question takes the owner's answer");
        await this.#sendReply(item.request_id!, "answer", { by: "owner", text: d.text ?? "", ...(d.choice !== undefined ? { choice: d.choice } : {}) });
        item.state = "replied";
        item.log.push("answered by the owner, in their own words");
      } else if (item.direction === "in") {
        await this.#sendReply(item.request_id!, "decline", { reason: d.reason ?? "owner_declined", ...(d.note ? { note: d.note } : {}) });
        item.state = "declined";
        item.log.push("declined by the owner");
      } else if (d.decision === "approve") {
        const sent = await this.#sendRequest(item);
        Object.assign(item, { request_id: sent.id, state: "sent", expires_at: sent.envelope.expires_at });
        item.log.push(`sent with the owner's approval, recorded at seq ${sent.receipt.seq}`);
      } else {
        item.state = "not_sent";
        item.log.push("the owner declined to send it");
      }
    } catch (e) {
      item.decided = undefined;
      item.log.push(`the owner's ${d.decision} couldn't be carried out, and the item still waits: ${(e as Error).message}`);
      this.#note(`decision on ${item.id} failed: ${(e as Error).message}`);
    }
    this.#save(item);
  }

  // ---------------------------------------------------------------------------------------------
  // Sending.

  /** Checks a body against its action's schema and the rules no schema says: throws saying why it can't go. */
  #checkShape(type: string, body: JsonObject) {
    const errors = schemaErrors(`actions/${type}` as SchemaName, body);
    if (errors.length) throw new ConnectorError(`that ${type} doesn't match the protocol: ${errors.join("; ")}`);
    if (type === "result") {
      const problems = resultProblems(body);
      if (problems.length) throw new ConnectorError(`that result contradicts itself: ${problems.join("; ")}`);
    }
  }

  /** The secret scan (protocol.md section 11, step 8): true when it ran and found nothing. Rules and fields go to the log, never to the agent. */
  async #scanned(type: string, body: JsonObject): Promise<boolean> {
    const scan = await scanOutgoing(body, {
      ...this.file.scan,
      never: [this.file.key_seed, this.file.seal_private ?? "", this.file.delegation].filter(Boolean),
    });
    if (scan.ok) return true;
    this.#note(`the secret scan stopped a ${type}: ${scan.error ?? scan.findings.map((f) => `${f.rule} in ${f.field}`).join(", ")}`);
    return false;
  }

  async #sendReply(requestId: string, type: string, body: JsonObject) {
    this.#checkShape(type, body);
    if (!(await this.#scanned(type, body))) throw new ConnectorError("the secret scan found what may be a secret, or couldn't run: nothing was sent");
    await this.token();
    const sent = await this.member.reply(requestId, type, body);
    this.#saveMemory();
    return sent;
  }

  async #sendRequest(item: Item) {
    this.#checkShape(item.type, item.body);
    if (!(await this.#scanned(item.type, item.body))) throw new ConnectorError("the secret scan found what may be a secret, or couldn't run: nothing was sent");
    await this.token();
    const sent = await this.member.request(item.peer, item.type as "question", item.body, item.expires_in ? { expiresIn: item.expires_in } : {});
    this.#saveMemory();
    return sent;
  }

  /**
   * A request from the host's agent: sent now when the owner's rules let it go to `to`, otherwise
   * kept in the mailbox until the owner approves sending it.
   */
  async request(type: "question" | "review_request" | "handoff", to: string, body: JsonObject, expiresIn = 86400): Promise<Item> {
    return this.serial(async () => {
      const peers = await this.member.directory();
      this.#saveMemory();
      const peer = peers.find((p) => p.obi === to);
      if (!peer) throw new ConnectorError(`${to} is not a member of this Sphere`);
      if (to === this.file.obi) throw new ConnectorError("that's this member itself");
      if (peer.status !== "active") throw new ConnectorError(`${to} was revoked`);
      if (!peer.trusted) throw new ConnectorError(`${to} isn't trusted: ${peer.problem}`);
      if (!peer.accepts.includes(type)) throw new ConnectorError(`${to} doesn't accept ${type} (it accepts ${peer.accepts.join(", ")})`);
      // After a busy: not again until one of the requests open to it then has ended, or, with none open then, for an hour.
      const busy = Object.hasOwn(this.#state().busy, to) ? this.#state().busy[to] : undefined;
      if (busy) {
        const stillOpen = (id: string) => SENT_OPEN.includes(this.item(id)?.state ?? "expired");
        const waiting = busy.open.length ? busy.open.every(stillOpen) : busy.at + BUSY_BACKOFF_SECONDS > nowSeconds();
        if (waiting) throw new ConnectorError(busy.open.length ? `${to} declined as busy: ask it again once one of your open requests to it has ended` : `${to} declined as busy: ask it again after ${timestamp(busy.at + BUSY_BACKOFF_SECONDS)}`);
      }
      const same = this.items().some((i) => i.direction === "out" && i.peer === to && i.type === type && OPEN.includes(i.state) && canonicalize(i.body) === canonicalize(body));
      if (same) throw new ConnectorError(`the same ${type} to ${to} is open already`);
      this.#checkShape(type, body);
      if (!(await this.#scanned(type, body))) throw new ConnectorError("the secret scan found what may be a secret, or couldn't run: nothing was sent");
      const item: Item = {
        id: `out-${crypto.randomUUID()}`, direction: "out", type, peer: to, peer_owner: peer.owner, state: "waiting_on_owner",
        created_at: timestamp(nowSeconds()), expires_at: timestamp(nowSeconds() + expiresIn), body, digest: "", replies: [], expires_in: expiresIn, log: [],
      };
      item.digest = itemDigest(item);
      if (allows(await this.rules(), to, type)) {
        const sent = await this.#sendRequest(item);
        Object.assign(item, { request_id: sent.id, state: "sent", expires_at: sent.envelope.expires_at });
        item.log.push(`sent under the owner's rules, recorded at seq ${sent.receipt.seq}`);
      } else {
        item.log.push("held: the owner's rules don't let it go without asking; it waits for the owner to approve sending it");
      }
      this.#save(item);
      return item;
    });
  }

  /**
   * A reply from the host's agent to an incoming request its owner approved. When the secret scan
   * stops what the agent wrote, the request is finished without its words (protocol.md section 11,
   * step 8): a decline with reason `other` for a question, a `failed` result with no words for a
   * review or a handoff. Nothing the agent wrote goes out, and it doesn't get to try again.
   */
  async reply(itemId: string, kind: string, args: ReplyArgs): Promise<{ item: Item; withheld: boolean }> {
    return this.serial(async () => {
      const item = this.item(itemId);
      if (!item || item.direction !== "in") throw new ConnectorError(`no incoming request ${itemId}`);
      if (item.state === "waiting_on_owner") throw new ConnectorError("its owner hasn't decided yet: only an approved request can be replied to");
      if (item.state !== "approved") throw new ConnectorError(`it is ${item.state}: there's nothing more to send`);
      if (seconds(item.expires_at) <= nowSeconds()) throw new ConnectorError("it expired");
      const { type, body } = this.#replyBody(item, kind, args);
      this.#checkShape(type, body);
      let withheld = false;
      let sent: { type: string; body: JsonObject } = { type, body };
      if (!(await this.#scanned(type, body))) {
        // A status is only progress: stopped, nothing goes. Anything else finishes the request without words.
        if (type === "status") throw new ConnectorError("the secret scan stopped that status: nothing was sent, and the request is still yours to reply to");
        withheld = true;
        sent = item.type === "question" ? { type: "decline", body: { reason: "other" } } : { type: "result", body: this.#failedResult(item) };
      }
      const out = await this.#sendReplyChecked(item, sent);
      if (sent.type !== "status") item.state = "replied";
      item.replies.push({ id: out.id, type: sent.type, from: this.file.obi, at: timestamp(nowSeconds()), body: sent.body });
      item.log.push(withheld ? `the scan stopped the agent's ${type}: sent a ${sent.type} without words instead` : `${type} sent`);
      this.#save(item);
      return { item, withheld };
    });
  }

  async #sendReplyChecked(item: Item, r: { type: string; body: JsonObject }) {
    await this.token();
    const sent = await this.member.reply(item.request_id!, r.type, r.body);
    this.#saveMemory();
    return sent;
  }

  /** A review's or a handoff's `failed` result with no words: every condition not met. */
  #failedResult(item: Item): JsonObject {
    const conditions = (item.body.acceptance ?? []) as { kind: string; severity?: string }[];
    const acceptance = conditions.map((c, index) => ({ index, kind: c.kind, ...(c.severity ? { severity: c.severity } : {}), met: false }));
    return (item.type === "review_request"
      ? { for: "review_request", outcome: "failed", repo: item.body.repo, head_sha: item.body.head_sha, findings: [] }
      : { for: "handoff", outcome: "failed", repo: item.body.repo, acceptance }) as unknown as JsonObject;
  }

  #replyBody(item: Item, kind: string, a: ReplyArgs): { type: string; body: JsonObject } {
    const req = item.body;
    switch (kind) {
      case "answer": {
        if (item.type !== "question") throw new ConnectorError(`an answer answers a question; this is a ${item.type}: reply with a result`);
        const choices = (req.choices as unknown[] | undefined)?.length;
        if (a.choice !== undefined && (choices === undefined || a.choice >= choices)) throw new ConnectorError(`choice is the index of one of the question's ${choices ?? 0} choices`);
        return { type: "answer", body: { by: "obi", text: a.text ?? "", ...(a.refs ? { refs: a.refs } : {}), ...(a.choice !== undefined ? { choice: a.choice } : {}) } as JsonObject };
      }
      case "result": {
        if (item.type === "question") throw new ConnectorError("a question takes an answer, not a result");
        const conditions = (req.acceptance ?? []) as { kind: string; severity?: string }[];
        const findings = (a.findings ?? []).map((f) => ({
          id: findingId(f.file, f.line, f.title), severity: f.severity, file: f.file, line: f.line, ...(f.end_line !== undefined ? { end_line: f.end_line } : {}), title: f.title, detail: f.detail,
        }));
        const rank: Record<string, number> = { nit: 1, minor: 2, major: 3, blocker: 4 };
        const outcome = a.outcome ?? "failed";
        const acceptance = conditions.map((c, index) => {
          let met = a.met?.[index] ?? false;
          if (item.type === "review_request" && c.kind === "no_blocker_findings") met = !findings.some((f) => f.severity === "blocker");
          if (item.type === "review_request" && c.kind === "no_findings_at_or_above") met = !findings.some((f) => rank[f.severity]! >= rank[c.severity!]!);
          return { index, kind: c.kind, ...(c.severity ? { severity: c.severity } : {}), met };
        });
        if (item.type === "review_request") {
          return {
            type: "result",
            body: {
              for: "review_request", outcome, repo: req.repo as string, head_sha: req.head_sha as string, findings,
              ...(outcome !== "failed" || a.met ? { acceptance } : {}), ...(a.summary ? { summary: a.summary } : {}),
            } as unknown as JsonObject,
          };
        }
        return {
          type: "result",
          body: {
            for: "handoff", outcome, repo: req.repo as string, acceptance, ...(a.head_branch ? { head_branch: a.head_branch } : {}),
            ...(a.head_sha ? { head_sha: a.head_sha } : {}), ...(a.pr ? { pr: a.pr } : {}), ...(a.summary ? { summary: a.summary } : {}),
          } as unknown as JsonObject,
        };
      }
      case "decline":
        if (!["busy", "out_of_scope", "other"].includes(a.reason ?? "other")) throw new ConnectorError("the agent declines as busy, out_of_scope or other; the other reasons are its owner's or the protocol's");
        return { type: "decline", body: { reason: a.reason ?? "other", ...(a.note ? { note: a.note } : {}) } };
      case "status":
        if (!["working", "blocked"].includes(a.state ?? "working")) throw new ConnectorError("the agent's status is working or blocked");
        return { type: "status", body: { state: a.state ?? "working", ...(a.note ? { note: a.note } : {}) } };
      default:
        throw new ConnectorError(`kind is answer, result, decline or status, not ${kind}`);
    }
  }

  async members(): Promise<Peer[]> {
    return this.serial(async () => {
      const peers = await this.member.directory();
      this.#saveMemory();
      return peers;
    });
  }

  /** Receives until `signal` aborts: long polls, applying decisions between them, backing off on errors. */
  async run(signal: AbortSignal, o: { wait?: number } = {}): Promise<void> {
    let backoff = 1;
    while (!signal.aborted) {
      try {
        await this.poll(o.wait ?? 10);
        backoff = 1;
      } catch (e) {
        this.#note(`receiving failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, Math.min(backoff, 60) * 1000));
        backoff *= 2;
      }
    }
  }
}

export interface ReplyArgs {
  text?: string;
  choice?: number;
  refs?: JsonObject[];
  outcome?: string;
  findings?: { severity: string; file: string; line: number; end_line?: number; title: string; detail: string }[];
  met?: boolean[];
  summary?: string;
  head_branch?: string;
  head_sha?: string;
  pr?: number;
  reason?: string;
  note?: string;
  state?: string;
}

/** A DataBody back to plain JSON: for keeping in this member's own mailbox, never for an agent. */
export function plainBody(body: unknown): JsonObject {
  return JSON.parse(JSON.stringify(body, (_k, v) => (v && typeof v === "object" && v["x-obi-text"] === "data" ? v.text : v)));
}
