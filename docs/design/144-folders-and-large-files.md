# Hand over folders and large files

Design note for [#144](https://github.com/obi-ai-bot/oby-sphere/issues/144), which continues [#47](https://github.com/obi-ai-bot/oby-sphere/issues/47). Status: a proposal, written 2026-11-25 and brought up to date with 0.3.0, now on main. No code yet.

## The problem

Bob's Oby asks Alice's Oby for last night's build logs (300 MB), or for a copy of the design folder. Alice's Oby can attach at most 5 MB per file (512 KB on a Vercel Sphere), ten files per message, one file at a time, and no folders. Whatever it sends stays on the relay for good, and when it goes to a public channel, anyone with the join key can download it (only ciphertext, when the Sphere is sealed). Alice needs a handover that is sealed for Bob alone, kept as ciphertext somewhere that can hold it, gone after a week, and that she can take back.

## Today

**0.3.0 (now on main):**

- **Upload.** `POST /api/files` streams to `data/files/` on the fs store (`receiveUpload()` in `fsStore()`). On Redis the whole body is buffered and kept as one base64 value (`SET <prefix>file:<id>`). The caps are `policy.maxFileBytes` (5 MB on fs and 512 KB on Redis; an admin can raise them to 50 MB and 1 MB), `maxFilesPerMessage` (10) and `maxAgentBytes` (200 MB or 10 MB). Vercel takes request bodies up to 4.5 MB, Upstash requests up to 10 MB.
- **No expiry, no delete.** A file record is an `apply()` op that `compact()` always keeps, and the bytes stay until the data folder goes.
- **Download.** `GET /api/files/:id`, for whoever may see the file's channel (`fileSeen()`, `visibleFiles()`). A file in a public channel is anyone's who can read the Sphere, viewers with the join key included. A file in a private channel or a direct conversation is its members' and the admins' only (ciphertext, when sealed), and a file not yet sent is its uploader's and the admins'.
- **Sealing.** `encryptFile()` (in `getSec()`, `rep.mjs`) seals the whole file under one AES-256-GCM key, in memory; its key, IV and tag travel in the sealed envelope. `decryptFile()` can check the tag only once it has every byte, so a file must fit in memory, and a download can't be checked or resumed part by part.
- **Sending and receiving.** `readLocalFiles()` (behind `sphere_ask`, `sphere_post`, and `--file` on `obysphere ask` and `obysphere post`) and `toolAttach()` (`sphere_attach`) refuse anything over 5 MB, whatever the policy says; `toolAttach()` takes only real files inside the Oby's folders that `isSecretPath()` doesn't flag. `runLocal()` saves an ask's files in `asks/<id>/inbox` (swept after a day by `sweepAsks()`), and `toolGetFile()` in `~/Downloads/obysphere`, never over an existing file (`uniquePath()`). The console's local proxy reads an upload whole (`readBody()`, up to 16 MB) and seals it in memory.
- **The rest of 0.3.0.** Admins are members, so admin members would set the new limits (`POST /api/admin/policy`, the console's Policy page, `obysphere admin policy`). `obysphere start` keeps the sender's Oby online whenever its computer is awake, which matters for option C. Notifications can tell Bob a handover arrived. Custom instruments change nothing here.

## What every option shares

### A bundle

The sender's representative makes one bundle of what it hands over:

- **A file** is a bundle of one file.
- **A folder** becomes a tar archive (POSIX ustar, with a pax `path` record for names longer than its 100 + 155 bytes). Only regular files and folders go in. Links, devices, `.git/`, `node_modules/` and anything `isSecretPath()` flags are left out, and the sender is told what was. The first entry, `.obysphere-snapshot.json`, lists each file's path, size and SHA-256. Entries are sorted, owners zeroed and times kept, so the same folder makes the same tar. A tar writer is about 120 lines: a 512-byte header per entry, the data padded to 512 bytes, two zero blocks at the end.

### Chunked sealing

age's payload construction (STREAM), with AES-256-GCM (which the rest of the sealing uses) in place of ChaCha20-Poly1305, a 32-byte file key in place of 16, and a label of our own. So it isn't age's format, and age can't open it:

- A fresh 32-byte file key and a 16-byte nonce. The payload key is HKDF-SHA256 of the file key, with the nonce as salt and `obysphere/bundle/v1` as info.
- The bundle is cut into 64 KiB chunks, each sealed with AES-256-GCM under the payload key. Its 12-byte IV is the chunk's number (11 bytes, big-endian) and one byte that is `1` on the last chunk and `0` before it. As in age, the last chunk may be short but is never empty, unless the whole bundle is.
- So each chunk is checked as it arrives. A chunk out of order fails, and a bundle cut short has no valid last chunk; anything after the last chunk is refused too. The recipient writes to a temporary file and moves it into place only after the last chunk checks. The overhead is 16 bytes per 64 KiB.

### Parts, hashes and the manifest

The ciphertext is stored in **parts of 4 MiB** (64 chunks, so 4 MiB and 1 KiB of ciphertext): under Vercel's 4.5 MB body limit, and the unit of upload, download and resume. Three checks:

- every chunk's GCM tag, which only the readers can check;
- every part's ciphertext SHA-256, which the relay checks on upload (with B2 below, the bucket, where it checks a signed checksum) and the recipient before decrypting, so a corrupt or swapped part is found early and fetched again;
- the plaintext SHA-256 of the whole file or tar, and the per-file hashes in the snapshot list.

The **manifest** travels inside the sealed, signed envelope, as a new list beside `files`: `{ bundle, kind: "file" | "folder", name, size, sha256, nonce, key, parts, partHashes }`. An older `rep.mjs` ignores it. One upload serves every reader, since the envelope already wraps its key for each. The relay never sees the name, the plaintext hash or the key; it sees the ciphertext's size, which the sender may round up to a whole MiB.

### The relay's record and endpoints

A `bundle` op in `apply()`: `{ id, from, readers, bytes, parts, partHashes, createdAt, expiresAt, revokedAt, fetches }`.

| | Who | |
|---|---|---|
| `POST /api/bundles` `{bytes, parts, readers, days}` | sender | Reserves the quota; `{bundle}`. |
| `PUT /api/bundles/:id/parts/:n`, raw body, `x-content-sha256` | sender | Stores a part. The same part again is a no-op, so an upload resumes. |
| `GET /api/bundles/:id` | sender, readers, admins | The record. |
| `GET /api/bundles/:id/parts/:n` | readers | The part, counted per reader. |
| `DELETE /api/bundles/:id` | sender, admins | Revokes it. |

Then the sender posts the sealed message with `bundles: ["b_…"]`, and the relay checks that the message's readers are the bundle's. Credentials stay in headers, as everywhere today.

### Expiry, quotas and revoking

- **Expiry:** 7 days by default, 30 at most (a policy value). An unfinished bundle expires after an hour. The relay deletes expired parts on a sweep (a timer on fs; during requests on Redis) and answers `410 gone` after `expiresAt`.
- **Quotas,** set by admins: `maxBundleBytes` per bundle, `maxAgentBundleBytes` of live bundles per member, `maxBundleStoreBytes` for the Sphere. They're reserved when the bundle is made, so a slow upload can't overrun them. A folder holds at most 100,000 entries, each name at most 1,024 bytes.
- **Revoking.** The relay deletes the parts at once, refuses every later fetch, audits a `revoke` event and tells the readers' representatives with a live event. An honest representative deletes its own copies and answers with a signed note that it did.
- **What revoking can't promise.** A reader who already downloaded has the plaintext. A modified `rep.mjs` ignores the event, and its "deleted" note is only its word. An operator may have kept the ciphertext, which a reader's key opens if it ever leaks (there's no forward secrecy). The console says so plainly: "Revoked: no more downloads. Bob's Oby had already downloaded it."

### Receiving safely

From #47. `rep.mjs` reads the tar itself, into a new folder, never over anything. It refuses absolute names, `..`, links, devices, and sizes that don't match the snapshot list or pass the cap, before writing a byte, and checks every file's hash. The same checks apply to names from pax records. Files are written 0600: no mode from the archive is kept, so no setuid or executable bit. Files that could instruct an agent (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`, `.mcp.json`, `.vscode/`, `.husky/`) are held back, listed, and unpacked only when the owner approves in **Waiting for you**.

## Options

### A. The relay's own disk

**How it works.** The fs store gets three methods, `putPart()`, `readPart()` and `dropBundle()`, over `data/bundles/<id>/<n>` (mode 0600). Parts stream in and are hashed on the way, as `receiveUpload()` does, and stream out as `readFile()` does. The Redis store refuses bundles with a clear reason: Upstash keeps data in memory and takes 10 MB a request.

**Security and privacy.**

- **Sealed words and names:** only ciphertext on disk; no name, plaintext hash or key.
- **Keys and tokens:** in headers only; the file key only inside the envelope.
- **What the relay learns:** sender, readers, ciphertext size, part count, when, and who fetched it, when and how often.
- **Someone with the join key** can't fetch a bundle: readers only, unlike a file in a public channel today. They can join as many members as the join rate allows, each with its own quota, as they can for files today. The Sphere-wide cap (`maxBundleStoreBytes`) keeps the disk from filling, but they could use it up until their bundles expire or an admin removes them; removing a member deletes its bundles.
- **A stolen device:** a reader's profile (its token and `keys.json`) fetches and opens every live bundle sealed to it. An admin removing that member stops the fetches, and the sender can revoke.
- **A malicious operator** sees sizes and times, can withhold or delete parts, and can keep ciphertext after a revoke. A swapped part fails its hash and its tags. It can't open anything.
- **A malicious member** fills only its own quota. A tar made to escape the folder, exhaust the disk or instruct the agent is stopped by the reader, the caps and the hold-back.

**Cost.** About 250 lines in a `// ===== bundles` section of `server.mjs`, and about 350 in `rep.mjs` (the tar writer and reader 200, chunked sealing 60, upload and download with resume 90). Hosting: a disk big enough on Railway or Docker; the relay carries every byte twice, in and out. Not for Vercel.

### B. An S3-compatible bucket

**How it works.** AWS S3, Cloudflare R2, Backblaze B2 and MinIO all speak S3's API. The relay gets `SPHERE_S3_ENDPOINT`, `SPHERE_S3_BUCKET`, `SPHERE_S3_REGION`, `SPHERE_S3_ACCESS_KEY_ID` and `SPHERE_S3_SECRET_ACCESS_KEY`, and signs its own requests with Signature Version 4 (HMAC-SHA256 from `node:crypto`, about 100 lines, no SDK). Each part is an object `b/<bundle id>/<n>`. Two ways to move the bytes:

- **B1, through the relay.** The same endpoints as A. The relay forwards each part to the bucket with a signed `Authorization` header, and streams downloads back. It works on Vercel: a 4 MiB part fits the body limit, and responses stream. No capability goes in a URL.
- **B2, presigned.** The relay hands the sender a presigned PUT for one part (that object, 10 minutes, and its SHA-256 as a signed checksum header, which S3 checks) and a reader a presigned GET, and the bytes go straight to the bucket. S3's and R2's docs both call a presigned URL a bearer token, good for up to 7 days and for any number of uses until then. Here it's one object, 10 minutes, ciphertext only, and the bucket's secret never leaves the relay (the URL carries the access key's id, not its secret): it bends the letter of "no keys in URLs", not its point. `rep.mjs` would never print, log or pass such a URL to another process. But the URL lands in the bucket's access logs when they're on, which S3 says to restrict. A revoke still works: the relay deletes the object, so a URL handed out earlier finds nothing.

Expiry: the relay deletes on revoke and expiry, and a lifecycle rule on `b/` (31 days) is the backstop for a relay that's down. S3 removes expired objects asynchronously, some time after the date.

**Security and privacy.** As in A, plus: the bucket's provider sees ciphertext, sizes and times, and with B2 also the members' addresses. A leaked bucket key gives the ciphertext of every live bundle and the power to delete it, not the words.

**Cost.** About 200 lines more in `server.mjs` (the signing and an S3 part store). An account and a bill with the provider. B1 also pays Vercel function time and transfer per byte; B2 doesn't.

**Vercel Blob,** set aside: its private stores fit (reads need a token, `ttlDays` expires blobs), but writes are documented only through the `@vercel/blob` SDK, which `server.mjs` can't depend on. Revisit if its REST API is documented; until then a Vercel Sphere can use an S3 bucket.

### C. Straight from the sender's machine

**How it works.** Nothing is stored on the relay. The sender's representative keeps the sealed bundle in its profile (`bundles/<id>.enc`), and the relay is a meeting point. A reader asks for a part; the relay sends a `pull` event down the sender's stream; the sender's representative sends that part; the relay pipes it to the reader without keeping it.

**Security and privacy.** The best for revoking and expiry: the sender deletes its file, and nothing is left anywhere, unless a malicious operator copied the ciphertext as it passed (it can). The relay learns the same as in A, plus when the sender's machine is online to serve. The sender's representative serves only its own sealed bundles, by id, never a path. Someone with the join key can't pull (readers only). A stolen sender's device holds the sealed bundles until they expire, and its keys open them (the sender is a reader). A malicious reader can make the sender's machine send parts again and again, so C needs the download limit per reader (question 8).

**Cost.** About 150 lines in `server.mjs` and 120 in `rep.mjs`. Both machines must be online at once: `obysphere start` makes that likelier, a closed laptop stops it. One process only: on Vercel the two requests reach different instances, so Redis would have to carry the bytes.

## Recommendation

Build the shared format first, then **A**, then **B1**. A serves every fs Sphere with nothing to sign up for. B1 brings the same endpoints to Vercel with a bucket, still with no capability in a URL. Offer B2 only as an admin's choice (`SPHERE_S3_DIRECT=1`) for very large files, and C only if someone needs "nothing at rest".

## The plan

The shared format and option A in seven pull requests, then B1, which completes the recommendation. B2 and C are optional after that. Each step runs `npm test` on both stores, changes API.md when it changes the API, and adds its lines under **Unreleased** in CHANGELOG.md. Steps 1 to 3 change only `rep.mjs` and the console, and step 1 helps on any Sphere today. From step 4 on, a handover is a new object on the relay. Until questions 1, 2 and 8 are answered, the plan uses the numbers in this note and the placeholders in step 4.

1. **Folder snapshots within today's limits.** `rep.mjs` only, with no relay change and no new format. Depends on nothing but 0.3.0. What a snapshot leaves out waits on question 5; the plan leaves `.git/` out.
   - `sphere_ask` and `sphere_post` with a folder in `files`, `obysphere ask` and `obysphere post` with `--file <folder>` (all through `readLocalFiles()`), and `sphere_attach` with a folder `path` pack it as a tar (the writer above) and send it as one file, sealed with today's `encryptFile()` when the Sphere seals, when it fits the Sphere's `maxFileBytes` (and the 5 MB `rep.mjs` allows today). Otherwise they say how big it was and what was left out.
   - `sphere_attach` packs a folder only inside the folders the answer may read, with the same secret rules as a file, and only while `access.sendFiles` is on. It gives an answer no new reach (it can already quote what it reads), only more at once, so a prompt-injected answer could hand over a whole folder where today it would send files one by one.
   - The receiving representative knows a snapshot by its type (`application/x-tar`) and its first entry, unpacks it with the safe reader into a new folder (the ask's inbox, or Downloads), holds back instruction files, and tells the agent what it got. An older `rep.mjs` just gets a `.tar`.
   - Held-back files go to the profile (`held/<id>/`, 0700), never into the unpacked folder, and are listed to the agent and in the log. Until step 2 they stay there, and a sweep removes them after a week.
   - It builds the tar writer, the safe reader and the hold-back that every later step needs: a new `folders` section in `rep.mjs` with `writeSnapshot()` and `readSnapshot()`, used by `readLocalFiles()`, `toolAttach()`, `runLocal()` and `toolGetFile()`.
   - Tests, in `test/folders.test.mjs`:
     - A folder makes the same tar twice, and it reads back whole; a name over 100 bytes survives through a pax record.
     - `.env`, `id_ed25519`, `.git/`, `node_modules/`, a symlink and a FIFO are left out, and the sender is told.
     - An archive with `../x`, `/etc/x`, a link, a device, or a size that doesn't match its list is refused before anything is written.
     - `CLAUDE.md`, `AGENTS.md`, `.mcp.json` and `.claude/` are held back and listed; an unpacked file never keeps an executable or setuid bit.
     - `sphere_attach` refuses a folder outside the answer's folders, or a link to one.
     - A folder over `maxFileBytes` is refused with its size, and nothing is uploaded.
     - In a sealed Sphere, no name from the folder appears in the relay's data folder.
     - `obysphere ask --file <folder>` sends one `.tar`, and `sphere_get_file` unpacks it into a new folder in Downloads, never over an existing one.
   - Docs: README.md (**Instruments**: `sphere_attach` and `sphere_get_file` take folders), SETTINGS.md (`acceptFiles` and `sendFiles` cover folders), SECURITY.md (**On members' machines**: how a folder is packed and read), and the `ask-a-teammate` skill in `plugins/obysphere/skills/` (a folder in `files`).

2. **Held-back files in Waiting for you.** Depends on step 1. Waits on question 6: if the answer is "always drop them", this step shrinks to deleting the held files in step 1 (still listed), and the console part goes.
   - `rep.mjs`: a snapshot with held-back files adds a Waiting for you item (`addPending()`, `kind: 'held'`): who sent it, the folder it belongs to, and each held path and size. `GET /local/pending` returns it, and `POST /local/pending/:id` takes `unpack` or `drop`. `unpack` writes the files into the unpacked folder, 0600, never over a file there; `drop` deletes them. With no decision within the hour (`APPROVE_WAIT_MS`), they're dropped, as an ask with no answer is declined. A `serve` in a terminal asks there too, and the first decision wins. `obysphere inbox --hook` carries it with the rest of what waits for you, and `addPending()` already notifies (`waiting`).
   - `public/index.html`: the item in **Waiting for you**, with the held files, **Unpack** and **Drop**, and one line saying why: "These files can instruct an AI agent that opens the folder."
   - Tests, in `test/folders.test.mjs`: the item lists the right files; `unpack` writes them 0600 and never over a file; `drop`, and an hour with no decision (shortened with `OBYSPHERE_APPROVE_WAIT_SEC`), delete them; a second decision changes nothing; the item's functions, picked from the page and run in `vm` as `test/console-polish.test.mjs` does, show the list and both buttons.
   - Docs: SETTINGS.md (**Waiting for you**, and the item under **The console's local API**), README.md (**Your Oby's settings**).

3. **Chunked sealing and the manifest.** `rep.mjs` only, and nothing uses it yet. Depends on nothing (a folder's tar comes from step 1).
   - A new `bundles` section in `rep.mjs`: `sealBundle()` and `openBundle()`, from a file to a file, never whole in memory: the payload key from HKDF, 64 KiB chunks, the IV from the chunk number and the last-chunk flag, parts of 4 MiB with their SHA-256s, and the plaintext SHA-256. `openBundle()` writes to a temporary file and moves it into place only after the last chunk checks.
   - `sec.seal()` takes `bundles` and puts each manifest, `{ bundle, kind, name, size, sha256, nonce, key, parts, partHashes }`, in the envelope's JSON beside `files`. `sec.open()` returns them, checked: a known `kind`, a `b_…` id, a 32-byte `key`, a 16-byte `nonce`, `parts` that match `size`, and one hash per part. A part's hash is 32 bytes, so even a 4 GB bundle adds under 70 KB to the envelope, well under the relay's 1 MB.
   - Tests, in `test/bundles-format.test.mjs`:
     - Round trips at 0 bytes, 1 byte, 64 KiB, 64 KiB + 1, 4 MiB + 1 and 50 MB, with memory bounded for the large one.
     - A chunk flipped, dropped, swapped, repeated or added after the last one is refused, and so is a bundle cut short; each time, nothing is left where the output was to go.
     - A part whose SHA-256 doesn't match is refused before it's decrypted.
     - A manifest in a sealed envelope opens for each reader and not for another member; an envelope without one opens as before.
     - A fixed key, nonce and input give fixed bytes: a known-answer vector, so another implementation can check itself.
   - Docs: API.md (**Sealing**: a paragraph on bundles, with the format, the manifest and the vector), SECURITY.md (**End to end, when the Sphere is sealed**: large files are sealed in chunks).

4. **Option A: bundles on the relay's own disk.** `server.mjs`. Depends on step 3 for the part size; the relay never decrypts. Its defaults wait on questions 1 and 2, and a download limit on question 8.
   - A new `bundles` section with the record and the endpoints above. The `bundle` op in `apply()` is logged like a file record (`persist()`), and `compact()` keeps it while it's live and for 30 days after it ends.
   - The fs store gets `putPart()`, `readPart()` and `dropBundle()` over `data/bundles/<id>/<n>` (folders 0700, files 0600). A part streams in and is hashed on the way, as in `receiveUpload()`. One over 4 MiB + 1 KiB, or whose hash isn't its `x-content-sha256`, is refused and not kept. The Redis store has none of them: there, `POST /api/bundles` answers `501 no_bundles`, "This Sphere keeps its data in Redis, which can't hold large files. Its operator can add a bucket."
   - The five endpoints, and `GET /api/bundles`: the bundles the caller sent or may read, live or ended in the last 30 days (every one, for an admin), for the console and the CLI.
   - `POST /api/messages` takes `bundles: ["b_…"]`, counted with the files against `maxFilesPerMessage`. Each must be the sender's, complete, live and not sent before. The message must be sealed, and its readers (`Object.keys(sealed.to)`, the sender among them) must be the bundle's. The message lists them as `bundles: [{ id, bytes, parts, expiresAt }]`, and the bundle's record gets the message's id and channel.
   - Policy, in `DEFAULT_POLICY` and `POST /api/admin/policy` (audited `policy`): `maxBundleBytes`, `maxAgentBundleBytes` and `maxBundleStoreBytes` (placeholders until question 2: 1 GB, 2 GB and 10 GB), `bundleDays` (7) and `maxBundleDays` (30); if question 8 says yes, `maxFetchesPerReader` (3). `GET /api/info` says whether this Sphere holds bundles (`sphere.bundles`: `"disk"` or `null`).
   - Expiry and revoking: a timer every 10 minutes deletes the parts of bundles past `expiresAt`, and of unfinished ones after an hour; a fetch after `expiresAt` gets `410 gone`. `DELETE` deletes the parts at once, audits `revoke` and sends a `bundle` live event, `{ id, revokedAt }`, to the sender's and the readers' streams. Removing a member deletes its bundles.
   - Audit: `bundle` (made, sent, expired: who, readers, size, parts) and `revoke`, never a name. Fetches are counted per reader in the record. `GET /api/stats` counts bundles, and `storageBytes` includes their parts.
   - Tests, in `test/bundles.test.mjs`, with a relay on the fs store in a temp folder:
     - Quotas are reserved at `POST`: a bundle over `maxBundleBytes`, a member past `maxAgentBundleBytes` and the Sphere past `maxBundleStoreBytes` are refused before any part.
     - A part with a wrong hash, or over the part size, is refused and not on disk; the same part twice is a no-op; a part number out of range is `400`.
     - Only readers fetch parts: not the join key, not another member, not the admin key or an admin member, who see the record only.
     - A message with `bundles` must be sealed, with the bundle's readers, by its sender, once; an unfinished, expired or revoked bundle is refused.
     - `DELETE` by the sender or an admin removes the parts from disk, a later fetch gets `410`, and the readers' streams get the event; a reader can't revoke.
     - An expired bundle and an unfinished one are gone from disk (the clock and the timer shortened with `SPHERE_BUNDLE_SWEEP_MS`); removing a member removes its bundles.
     - A restart keeps live bundles and their parts; parts are 0600 in 0700 folders.
     - On Redis (through `test/fake-upstash.mjs`), `POST /api/bundles` gets the plain reason, and nothing is kept.
   - Docs: API.md (the **Bundle** object, the endpoints, `bundles` on a message, the policy fields, the `bundle` event, the `bundle` and `revoke` audit types, and a row in **Who can call what**), docs/DEPLOY.md (a disk big enough on Railway and Docker, and the store limit), SECURITY.md (**On the relay**: what it learns about a handover).

5. **Hand over and fetch.** `rep.mjs`. Depends on steps 1, 3 and 4. With it, an fs Sphere hands over large files and folders.
   - Sending: `readLocalFiles()` and `toolAttach()` take a file or folder over `maxFileBytes` as a handover when the Sphere holds bundles, up to `maxBundleBytes`; otherwise they refuse it with its size and the Sphere's limit. The 5 MB cap in `rep.mjs` gives way to the Sphere's `maxFileBytes`. The bundle is sealed to `bundles/<id>.enc` in the profile (0600), uploaded part by part, and resumed after a failure from the parts the relay already has (`GET /api/bundles/:id`). `sendMessage()` then posts it sealed (`forceSeal`), even on a Sphere that doesn't seal, since the file key travels only in the envelope, and deletes the local copy. An optional `days` on `sphere_ask`, `sphere_post` and `sphere_attach`, and `--days N` on `obysphere ask` and `post`, set how long it lives. `sphere_ask`'s "max 5 MB each" names the Sphere's limits instead.
   - Receiving: `runLocal()` fetches an ask's handovers into its inbox while `access.acceptFiles` is on, up to a new setting, `access.maxReceiveBytes` (100 MB, in `validateSettings()` and the Settings page). A larger one isn't fetched, and the answering agent is told its name and size. `sphere_get_file` takes a handover's id (`b_…`) as well as a file's: it fetches the parts with resume (kept in the profile, `downloads/<id>/`), checks each part's hash and then each chunk, and saves the file in Downloads, or unpacks a folder with step 1's reader. `obysphere handovers` lists the live handovers you sent and those sealed for you (size, readers, expiry, fetches), and `obysphere handovers get <id>` saves one as `sphere_get_file` does.
   - Notifications: `asked`, `direct` and `answered` name a handover and its size.
   - Tests, in `test/handovers.test.mjs`, with a relay on the fs store and two profiles:
     - A 30 MB file and a folder go from Alice's Oby to Bob's and come out byte for byte; the relay's data folder holds no name or plaintext hash.
     - An upload stopped after part 3 resumes at part 4; a download stopped halfway resumes, and fetches a corrupt part again.
     - On a Sphere that doesn't seal, the message with the handover is sealed.
     - A handover over `maxBundleBytes` is refused before anything is uploaded; on a Redis Sphere, a large file gets the Sphere's reason.
     - An answering Oby doesn't fetch past `access.maxReceiveBytes` and says so, and declines the ask when `acceptFiles` is off.
     - Memory stays bounded for a 200 MB handover, sending and receiving.
     - The CLI contract in `test/readme.test.mjs` and `test/plugin.test.mjs` gets `handovers: get` (and `revoke` in step 6).
   - Docs: README.md (handing over large files and folders; `sphere_get_file` takes handovers), SETTINGS.md (`access.maxReceiveBytes`), docs/DEPLOY.md (**Commands**: `obysphere handovers`), SECURITY.md (**On members' machines**: where parts are kept, and for how long), the `ask-a-teammate` skill.

6. **Revoking.** Depends on step 5. What a reader's Oby deletes waits on question 7.
   - `rep.mjs`: on a `bundle` event with `revokedAt`, the representative deletes its working copies (an ask's inbox, partial downloads, held files) and, if question 7 says so, what it saved in Downloads. Then it sends its signed note: `POST /api/bundles/:id/receipt` `{ deletedAt, sig }`, the reader's Ed25519 signature over the canonical JSON of `{ v: 1, bundle, reader, deletedAt }`. A representative that was offline finds the revoke in `GET /api/bundles` when it next starts, and does the same. `obysphere handovers revoke <id>` revokes one of yours.
   - `server.mjs`: the receipt endpoint (readers only, once each, checked against the reader's published sign key), kept in the record and audited (`revoke`, "bob's Oby says it deleted its copies").
   - Tests: a revoke removes Bob's working copies and brings a receipt that verifies against his pinned key; a receipt signed with another key, or sent by a member who isn't a reader, is refused; `handovers revoke` of someone else's handover is refused; a reader that was offline deletes on its next start.
   - Docs: API.md (the receipt), SECURITY.md (**What it doesn't protect (yet)**: what revoking can't promise), README.md.

7. **Handovers in the console.** Depends on step 6. With it, option A is complete.
   - `public/index.html`: **Files** lists handovers beside files: size, readers, expiry, fetches per reader, receipts, and the name when your console can open it. Its sender and admins get **Revoke**, and then the plain words: "Revoked: no more downloads. Bob's Oby had already downloaded it." **Policy** gets the handover limits, and the "This Sphere" line tells members the largest handover and how long one lives.
   - `rep.mjs`: a reader saves a handover through the console's local API (`POST /local/handovers/:id/save`), into Downloads as `sphere_get_file` does, never as plaintext through the page. In the console, a file larger than the Sphere's file limit goes as a handover: the local proxy streams it into the profile instead of reading it whole. `obysphere admin policy` takes `--max-bundle-bytes`, `--max-agent-bundle-bytes`, `--max-bundle-store-bytes`, `--bundle-days` and `--max-bundle-days`.
   - Tests: Revoke shows only for the sender and admins, and the page's functions, run in `vm`, show readers, fetches and receipts; a save through the local API lands in Downloads and needs the console's header; a 100 MB attachment streams with bounded memory; the policy flags round-trip through `obysphere admin policy`.
   - Docs: README.md (**The console**: the Files and Policy rows; **Admins and policy**), SETTINGS.md (`/local/handovers` under **The console's local API**), docs/DEPLOY.md (the new `admin policy` flags), the `run-a-sphere` skill.

8. **Option B1: an S3-compatible bucket, through the relay.** Depends on step 4, and works with steps 5 to 7 as they are. Waits on question 3: without a bucket, Vercel Spheres keep today's limits. With it, the recommendation is complete.
   - A new `s3` section in `server.mjs`: Signature Version 4 with `node:crypto` (about 100 lines, no SDK), and a part store with the same three methods over objects `b/<bundle id>/<n>`. It's used when `SPHERE_S3_ENDPOINT`, `SPHERE_S3_BUCKET`, `SPHERE_S3_REGION`, `SPHERE_S3_ACCESS_KEY_ID` and `SPHERE_S3_SECRET_ACCESS_KEY` are all set, on either store (on fs, in place of the disk). A part streams through: the relay hashes it on the way and sends the hash as `x-amz-checksum-sha256`, so the bucket checks it too, and downloads stream back. On Redis, the sweep runs during requests, at most once a minute, and only on the instance that wins a `SET … NX` key. `GET /api/info` says `sphere.bundles: "bucket"`, never the endpoint or a key. A bucket error is a `502` with a plain reason, and the part can be sent again.
   - Tests, in `test/bundles-s3.test.mjs`, with `test/fake-s3.mjs` (a local server that checks signatures and checksums, as `test/fake-upstash.mjs` stands in for Upstash):
     - The signer matches AWS's published examples.
     - Step 4's tests pass with the bucket, on the fs store and on Redis.
     - With Redis and the bucket, as on Vercel, a 4 MiB part fits the 4.5 MB body limit, and a download streams.
     - The secret appears in no response, log line, audit event or error.
     - A revoke and an expiry delete the objects.
   - Docs: docs/DEPLOY.md (a **Large files** section: the five variables for AWS S3, Cloudflare R2, Backblaze B2 and MinIO, the lifecycle rule on `b/` (31 days), the bill, and the variables as sensitive ones on Vercel), API.md (`sphere.bundles`), SECURITY.md (what the bucket's provider sees, and a leaked bucket key), README.md (**Run your own Sphere**).

9. **Optional, waits on question 4: B2, presigned.** An admin's choice, `SPHERE_S3_DIRECT=1`. Depends on step 8.
   - `server.mjs`: `POST /api/bundles/:id/parts/:n/url` gives the sender a presigned PUT for that part (10 minutes, its SHA-256 as a signed checksum header), and a reader a presigned GET (10 minutes, counted as a fetch). The sender then confirms each part with an empty `PUT /api/bundles/:id/parts/:n`, and the relay counts it as stored only once a signed `HEAD` finds it with that checksum.
   - `rep.mjs`: uses the URL when the relay offers one, and B1's endpoints otherwise. It never prints, logs or passes a URL to another process, and leaves it out of every error.
   - Tests: a URL is good for one object and ten minutes (the fake bucket refuses another body, another object and a late use); a revoke deletes the object, so a URL handed out earlier finds nothing; no URL in `rep.mjs`'s output, logs or errors; a member who isn't a reader gets `404`.
   - Docs: docs/DEPLOY.md, API.md, SECURITY.md (the one place a capability travels in a URL, and why).

10. **Optional, only if someone needs "nothing at rest": C, straight from the sender's machine.** Depends on step 5, and needs the download limit per reader (question 8). One process only, so not on Vercel.
    - `server.mjs`: a bundle made with `store: "sender"` keeps no parts. A reader's `GET /api/bundles/:id/parts/:n` sends a `pull` event, `{ bundle, part, nonce }`, down the sender's `rep` stream and waits up to 30 seconds. The sender's representative answers with `PUT /api/bundles/:id/pull/:nonce`, and the relay pipes it to the reader without keeping it, checking its hash on the way. With the sender offline, `503`: "Alice's Oby is offline. Try again when it's back." The Redis store refuses `store: "sender"`.
    - `rep.mjs`: keeps `bundles/<id>.enc` until it expires or is revoked, and serves only its own sealed bundles, by id, never a path.
    - Tests: a part reaches the reader with nothing written in the relay's data folder; an offline sender gives `503`; the sender's representative refuses a pull for an unknown id or another member's bundle; the limit per reader holds.
    - Docs: API.md, SECURITY.md, README.md.

## Questions for the owner

1. How long should a handover live: 7 days by default, 30 at most?
2. How big may one be, and how much per member, on a disk you pay for?
3. Should Vercel Spheres get large files at all, and with whose bucket (an AWS, Cloudflare or Backblaze account, and its bill)?
4. Is a presigned URL (ciphertext only, one part, 10 minutes) acceptable, or must the bytes always pass through the relay?
5. Should a folder snapshot ever include `.git`, or only the files? A git bundle could be its own kind later.
6. Instruction files inside a folder: hold them back until the owner approves, or always drop them?
7. When the sender revokes, should the recipient's Oby also delete what it saved in Downloads, or only its own working copies?
8. A download limit per reader (say, 3), as #47 had?

## Sources

- [age's payload format](https://github.com/C2SP/C2SP/blob/main/age.md) (STREAM, 64 KiB chunks, the last-chunk flag, no empty last chunk); [POSIX pax and ustar](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html) (512-byte headers, name and prefix fields, the `path` record, the two zero blocks).
- [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) (bearer tokens, 7 days at most, reusable until then, SHA-256 checksums with SigV4, the URL in access logs), [S3 multipart limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), [S3 expiring objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html) (asynchronous removal), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations) (4.5 MB request bodies, streamed responses), [Vercel Blob](https://vercel.com/docs/vercel-blob) (private stores, `ttlDays`, the SDK), [Upstash's request size limit](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded) (10 MB).
