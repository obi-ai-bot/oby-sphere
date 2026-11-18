// The phone relay (spec/sphere-api.md section 9): Wellington's Mac (obi-wellington) registers a
// relay and its phones' token hashes, and the Sphere passes sealed frames between them, reading
// and keeping none.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { b64url, hex, randomBytes, sha256Hex } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { MAC_FRAMES_PER_MINUTE, MAX_ENVELOPE_BYTES, PHONE_FRAMES_PER_MINUTE, type PhoneRelay } from "../src/relay";
import { BASE, World, expectSchema, makeCall, newKey, side, signJwt, team, until } from "./helpers";

/** A phone as the Mac pairs it: its relay token, and the hash the Sphere keeps. */
async function phone() {
  const token = b64url(randomBytes(32));
  return { token, hash: await sha256Hex(utf8(token)) };
}

const newRelay = () => b64url(randomBytes(16));
const path = (relay: string, device?: string) => `/v0.1/relay/${relay}${device ? `/devices/${device}` : ""}`;

function open(w: World, relay: string, token: string, upgrade = true): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (upgrade) headers.Upgrade = "websocket";
  return handle(new Request(BASE + path(relay), { headers }), env, { now: w.clock.now });
}

const stub = (relay: string) => env.RELAYS.get(env.RELAYS.idFromName(relay));

/** Sets a socket's count of frames this minute (its tag: `mac`, or the device id) without sending them: each costs the test runner milliseconds. */
const countFrames = (relay: string, tag: string, frames: number) =>
  runInDurableObject(stub(relay), (r: PhoneRelay) => void (r as unknown as { minutes: Map<string, object> }).minutes.set(tag, { start: Date.now(), frames, bytes: 0 }));

/** Text that holds every byte of any binary value as `n,n,n`, so a frame's bytes show up in it wherever they are kept. */
const flat = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x instanceof ArrayBuffer ? [...new Uint8Array(x)] : ArrayBuffer.isView(x) ? [...new Uint8Array(x.buffer, x.byteOffset, x.byteLength)] : x));

/** The team, Wellington's Mac's token, a relay with two phones, and what it takes to open each. */
async function paired() {
  const w = await team();
  const mac = await w.obiToken("obi-wellington");
  const relay = newRelay();
  const a = await phone();
  const b = await phone();
  const made = await w.call("PUT", path(relay), { token: mac });
  expect(made.status).toBe(201);
  expectSchema("relay", made.body);
  expect((await w.call("PUT", path(relay, a.hash), { token: mac })).status).toBe(201);
  const added = await w.call("PUT", path(relay, b.hash), { token: mac });
  expect(added.status).toBe(201);
  expect(added.body).toEqual({ relay, devices: [a.hash, b.hash].sort() });
  return { w, mac, relay, a, b };
}

const bytes = (b: ArrayBuffer) => [...new Uint8Array(b)];
const framed = (device: string, body: number[]) => new Uint8Array([...Buffer.from(device, "hex"), ...body]);

afterEach(() => vi.restoreAllMocks());

describe("phone relay", () => {
  it("lets a Mac and two phones meet and pass frames both ways, keeping and logging none", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    expect(m.texts.map((t) => JSON.parse(t))).toEqual([{ device: a.hash, peer: "joined" }, { device: b.hash, peer: "joined" }]);
    // Canaries no frame may leave behind, one each way.
    const canary = [0xca, 0x4a, 0x41, 0x52, 0x59, 0x5f, 0x34, 0x32];
    const macCanary = [0x4d, 0x41, 0x43, 0x5f, 0x43, 0x41, 0x4e, 0x41, 0x52, 0x59];
    pa.ws.send(new Uint8Array(canary));
    pb.ws.send(new Uint8Array(MAX_ENVELOPE_BYTES).fill(7));
    await until(() => m.frames.length === 2);
    const fromA = m.frames.find((f) => f.byteLength === 32 + canary.length)!;
    expect(hex(new Uint8Array(fromA, 0, 32))).toBe(a.hash);
    expect(bytes(fromA.slice(32))).toEqual(canary);
    const fromB = m.frames.find((f) => f.byteLength === 32 + MAX_ENVELOPE_BYTES)!;
    expect(hex(new Uint8Array(fromB, 0, 32))).toBe(b.hash);
    m.ws.send(framed(a.hash, macCanary));
    m.ws.send(new Uint8Array([...framed(b.hash, []), ...new Uint8Array(MAX_ENVELOPE_BYTES).fill(8)]));
    await until(() => pa.frames.length === 1 && pb.frames.length === 1);
    expect(bytes(pa.frames[0]!)).toEqual(macCanary);
    expect(pb.frames[0]!.byteLength).toBe(MAX_ENVELOPE_BYTES);
    // A frame for a device that isn't there, or shorter than a device id, is dropped.
    m.ws.send(framed("ab".repeat(32), [1]));
    m.ws.send(new Uint8Array(31));
    pa.ws.send("ping");
    await until(() => pa.texts.includes("pong"));
    pb.ws.close(1000);
    await until(() => m.texts.length === 3);
    expect(JSON.parse(m.texts[2]!)).toEqual({ device: b.hash, peer: "left" });
    expect([m.closed, pa.closed]).toEqual([null, null]);
    expect(pa.frames.length).toBe(1);

    const stored = await runInDurableObject(stub(relay), async (_i, state) => [...(await state.storage.list()).entries()]);
    const kept = flat(stored) + flat(await env.DB.prepare("SELECT * FROM relays, relay_devices").all());
    for (const c of [canary, macCanary]) {
      expect(kept).not.toContain(c.join(","));
      expect(flat(logged)).not.toContain(c.join(","));
    }
    expect(kept).not.toContain(a.token);
  });

  it("refuses a wrong token, and closes and refuses a forgotten one", async () => {
    const { w, mac, relay, a, b } = await paired();
    expect((await open(w, relay, (await phone()).token)).status).toBe(401);
    expect((await open(w, newRelay(), a.token)).status).toBe(401);
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    expect((await w.call("DELETE", path(relay, a.hash), { token: mac })).status).toBe(204);
    await until(() => pa.closed !== null);
    expect(pa.closed!.code).toBe(4001);
    await until(() => m.texts.length === 3);
    expect(JSON.parse(m.texts[2]!)).toEqual({ device: a.hash, peer: "left" });
    expect((await open(w, relay, a.token)).status).toBe(401);
    expect((await w.call("DELETE", path(relay, a.hash), { token: mac })).status).toBe(404);
    expect([m.closed, pb.closed]).toEqual([null, null]);
    expect((await w.call("PUT", path(relay), { token: mac })).body).toEqual({ relay, devices: [b.hash] });
    // Told once.
    expect(m.texts.length).toBe(3);
  });

  it("is an optional extension: /v0.1/features lists it, and with PHONE_RELAY=off every relay path answers 404", async () => {
    const { w, mac, relay, a } = await paired();
    expect((await w.call("GET", "/v0.1/features")).body.features).toContain("phone_relay");
    for (const value of ["off", " OFF ", "false", "no"]) {
      const offEnv = { ...env, PHONE_RELAY: value };
      const off = makeCall(w.clock, offEnv);
      const listed = await off("GET", "/v0.1/features");
      expect(listed.body.features).not.toContain("phone_relay");
      expectSchema("featuresResponse", listed.body);
      // The relay the Mac made while it was on, a new one, and a phone's socket: all 404, before any token or upgrade is looked at.
      for (const [method, p] of [["PUT", path(relay)], ["PUT", path(newRelay())], ["DELETE", path(relay)], ["PUT", path(relay, a.hash)], ["DELETE", path(relay, a.hash)], ["GET", path(relay)]] as const) {
        const r = await off(method, p, { token: mac });
        expect(r.status, `${method} ${p}`).toBe(404);
        expect(r.body.error.code).toBe("not_found");
      }
      const socket = await handle(new Request(BASE + path(relay), { headers: { Authorization: `Bearer ${a.token}`, Upgrade: "websocket" } }), offEnv, { now: w.clock.now });
      expect(socket.status).toBe(404);
    }
    // Back on, the relay and its phones are as they were.
    for (const value of ["on", ""]) expect((await makeCall(w.clock, { ...env, PHONE_RELAY: value })("PUT", path(relay), { token: mac })).body.devices).toContain(a.hash);
  });

  it("lets only a member's Mac own a relay, by default", async () => {
    const { w, mac, relay, a } = await paired();
    const other = await w.obiToken("obi-ernesto");
    expect((await w.call("PUT", path(relay), { token: other })).status).toBe(409);
    expect((await w.call("PUT", path(relay, (await phone()).hash), { token: other })).status).toBe(403);
    expect((await w.call("DELETE", path(relay, a.hash), { token: other })).status).toBe(403);
    expect((await open(w, relay, other)).status).toBe(403);
    expect((await w.call("PUT", path(newRelay()), { token: await w.ownerToken() })).body.error.code).toBe("forbidden");
    expect((await w.call("PUT", path(newRelay()), { token: await w.obiToken("obi-wellington", "directory:read") })).body.error.code).toBe("insufficient_scope");
    expect((await w.call("PUT", path(newRelay()), { token: "not-a-token-0123456789abcdefghijklmnop" })).status).toBe(401);
    // A Mac that isn't a member has no token here: whatever it signs is an unknown token.
    const stranger = await newKey();
    const signed = await signJwt({ iss: stranger.publicKey, aud: `obi-sphere:relay:${relay}`, iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID() }, stranger);
    expect((await w.call("PUT", path(newRelay()), { token: signed })).status).toBe(401);
    expect((await open(w, relay, signed)).status).toBe(401);
  });

  it("deletes a revoked member's relays: their sockets close within a minute, their tokens open nothing", async () => {
    const { w, mac, relay, a } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken() })).status).toBe(200);
    expect((await env.DB.prepare("SELECT (SELECT COUNT(*) FROM relays) + (SELECT COUNT(*) FROM relay_devices) AS n").first<{ n: number }>())!.n).toBe(0);
    await runDurableObjectAlarm(stub(relay));
    await until(() => m.closed !== null && pa.closed !== null);
    expect([m.closed!.code, pa.closed!.code]).toEqual([4001, 4001]);
    expect((await open(w, relay, a.token)).status).toBe(401);
    expect((await open(w, relay, mac)).status).toBe(401);
    // Ernesto's relay stays.
    const other = newRelay();
    const ernesto = await w.obiToken("obi-ernesto");
    expect((await w.call("PUT", path(other), { token: ernesto })).status).toBe(201);
    expect((await w.call("PUT", path(other), { token: ernesto })).status).toBe(200);
  });

  it("checks paths, upgrades and how many relays and devices", async () => {
    const { w, mac, relay } = await paired();
    expect((await w.call("PUT", path("short"), { token: mac })).status).toBe(400);
    expect((await w.call("PUT", path(relay, "A".repeat(64)), { token: mac })).status).toBe(400);
    expect((await open(w, relay, mac, false)).status).toBe(400);
    expect((await open(w, newRelay(), mac)).status).toBe(404);
    expect((await w.call("DELETE", path(newRelay()), { token: mac })).status).toBe(404);
    expect((await w.call("PUT", path(relay), { token: mac })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await w.call("PUT", path(newRelay()), { token: mac })).status).toBe(201);
    const fifth = await w.call("PUT", path(newRelay()), { token: mac });
    expect([fifth.status, fifth.headers.get("Retry-After")]).toEqual([429, null]);
    for (let i = 0; i < 14; i++) expect((await w.call("PUT", path(relay, (await phone()).hash), { token: mac })).status).toBe(201);
    expect((await w.call("PUT", path(relay, (await phone()).hash), { token: mac })).status).toBe(429);
  });

  it("closes a phone when the Mac isn't there, and every phone when it leaves", async () => {
    const { w, mac, relay, a, b } = await paired();
    const early = side(await open(w, relay, a.token));
    await until(() => early.closed !== null);
    expect(early.closed!.code).toBe(4008);
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    m.ws.close(1000);
    await until(() => pa.closed !== null && pb.closed !== null);
    expect([pa.closed!.code, pb.closed!.code]).toEqual([4008, 4008]);
  });

  it("keeps one socket each: a new one replaces the earlier, and a new Mac socket keeps the phones", async () => {
    const { w, mac, relay, a } = await paired();
    const m1 = side(await open(w, relay, mac));
    const p1 = side(await open(w, relay, a.token));
    const p2 = side(await open(w, relay, a.token));
    await until(() => p1.closed !== null);
    expect(p1.closed!.code).toBe(4003);
    // A Mac renewing its token: a new socket with a new one.
    const m2 = side(await open(w, relay, await w.obiToken("obi-wellington")));
    await until(() => m1.closed !== null && m2.texts.length === 1);
    expect(m1.closed!.code).toBe(4003);
    expect(JSON.parse(m2.texts[0]!)).toEqual({ device: a.hash, peer: "joined" });
    p2.ws.send(new Uint8Array([1]));
    await until(() => m2.frames.length === 1);
    expect([p2.closed, m1.texts.filter((t) => t.includes('"left"'))]).toEqual([null, []]);
  });

  it("closes a socket that sends a frame over its size, or text", async () => {
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    pa.ws.send(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
    pb.ws.send("hello");
    await until(() => pa.closed !== null && pb.closed !== null);
    expect([pa.closed!.code, pb.closed!.code]).toEqual([1009, 4004]);
    m.ws.send(new Uint8Array(32 + MAX_ENVELOPE_BYTES + 1));
    await until(() => m.closed !== null);
    expect(m.closed!.code).toBe(1009);
  });

  it("closes only the socket that passes its minute's frames or bytes", async () => {
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    await countFrames(relay, a.hash, PHONE_FRAMES_PER_MINUTE - 5);
    for (let i = 0; i < 6; i++) pa.ws.send(new Uint8Array([i]));
    await until(() => pa.closed !== null);
    expect(pa.closed!.code).toBe(4009);
    await until(() => m.frames.length === 5);
    // The Mac and the other phone carry on.
    m.ws.send(framed(b.hash, [7]));
    await until(() => pb.frames.length === 1);
    // Phone A back within the minute is still counted.
    const pa2 = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 4);
    pa2.ws.send(new Uint8Array([1]));
    await until(() => pa2.closed !== null);
    expect(pa2.closed!.code).toBe(4009);
    // 65 frames of 256 KiB pass a phone's 16 MiB.
    for (let i = 0; i < 65; i++) pb.ws.send(new Uint8Array(MAX_ENVELOPE_BYTES));
    await until(() => pb.closed !== null, 1000);
    expect(pb.closed!.code).toBe(4009);
    expect(m.closed).toBeNull();
    // The Mac's own budget, 4 times a phone's, serves every phone.
    expect(MAC_FRAMES_PER_MINUTE).toBe(4 * PHONE_FRAMES_PER_MINUTE);
    await countFrames(relay, "mac", MAC_FRAMES_PER_MINUTE);
    m.ws.send(new Uint8Array(33));
    await until(() => m.closed !== null);
    expect(m.closed!.code).toBe(4009);
  });

  it("closes a revoked or expired Mac, a forgotten phone and an idle socket within a minute", async () => {
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    await runDurableObjectAlarm(stub(relay));
    expect([m.closed, pa.closed]).toEqual([null, null]);
    // The member revoked behind the relay's back (the API deletes its relays too: the test before).
    await env.DB.prepare("UPDATE members SET status = 'revoked' WHERE sphere = 'e2e' AND obi = 'obi-wellington'").run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => m.closed !== null && pa.closed !== null);
    expect([m.closed!.code, pa.closed!.code]).toEqual([4001, 4008]);
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE sphere = 'e2e' AND obi = 'obi-wellington'").run();
    // A card rotation revokes the Obi's tokens.
    const m1 = side(await open(w, relay, mac));
    const pa1 = side(await open(w, relay, a.token));
    await until(() => m1.texts.length === 1);
    await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sha256 = ?1").bind(await sha256Hex(utf8(mac))).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => m1.closed !== null && pa1.closed !== null);
    expect([m1.closed!.code, pa1.closed!.code]).toEqual([4001, 4008]);

    const fresh = await w.obiToken("obi-wellington");
    const m2 = side(await open(w, relay, fresh));
    const pb = side(await open(w, relay, b.token));
    await until(() => m2.texts.length === 1);
    // Forgotten behind the relay's back: the alarm finds it.
    await env.DB.prepare("DELETE FROM relay_devices WHERE token_sha256 = ?1").bind(b.hash).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => pb.closed !== null);
    expect(pb.closed!.code).toBe(4001);
    await env.DB.prepare("UPDATE tokens SET expires_at_s = 0 WHERE sha256 = ?1").bind(await sha256Hex(utf8(fresh))).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => m2.closed !== null);
    expect(m2.closed!.code).toBe(4007);

    const m3 = side(await open(w, relay, await w.obiToken("obi-wellington")));
    const pa3 = side(await open(w, relay, a.token));
    await until(() => m3.texts.length === 1);
    pa3.ws.send("ping");
    await until(() => pa3.texts.includes("pong"));
    // The Mac sent nothing for 3 minutes; the phone pinged just now.
    await runInDurableObject(stub(relay), async (_i, state) => {
      for (const ws of state.getWebSockets("mac")) ws.serializeAttachment({ ...ws.deserializeAttachment(), last: Date.now() - 3 * 60_000 });
      for (const ws of state.getWebSockets(a.hash)) ws.serializeAttachment({ ...ws.deserializeAttachment(), last: Date.now() - 3 * 60_000 });
    });
    await runDurableObjectAlarm(stub(relay));
    await until(() => m3.closed !== null && pa3.closed !== null);
    expect([m3.closed!.code, pa3.closed!.code]).toEqual([4006, 4008]);
  });

  it("closes everything on a relay its Mac deletes, and forgets it", async () => {
    const { w, mac, relay, a } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    expect((await w.call("DELETE", path(relay), { token: mac })).status).toBe(204);
    await until(() => m.closed !== null && pa.closed !== null);
    expect([m.closed!.code, pa.closed!.code]).toEqual([4001, 4001]);
    expect((await open(w, relay, a.token)).status).toBe(401);
    expect((await w.call("PUT", path(relay, a.hash), { token: mac })).status).toBe(404);
  });

  it("lets a socket open at most 30 times in 10 minutes", async () => {
    const { w, mac, relay } = await paired();
    for (let i = 0; i < 30; i++) side(await open(w, relay, mac));
    const refused = await open(w, relay, mac);
    expect([refused.status, refused.headers.get("Retry-After")]).toEqual([429, "60"]);
  });
});
