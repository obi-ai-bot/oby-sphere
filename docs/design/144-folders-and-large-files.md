# Hand over folders and large files

Design note for [#144](https://github.com/obi-ai-bot/oby-sphere/issues/144), which continues [#47](https://github.com/obi-ai-bot/oby-sphere/issues/47). Status: a proposal, written 2026-11-25. No code yet.

## The problem

Bob's Oby asks Alice's Oby for last night's build logs (300 MB), or for a copy of the design folder. Alice's Oby can attach at most 5 MB per file (512 KB on a Vercel Sphere), ten files per message, one file at a time, and no folders. Whatever it sends stays on the relay for good, and on main anyone with the join key can download it (only ciphertext, when the Sphere is sealed). Alice needs a handover that is sealed for Bob alone, kept as ciphertext somewhere that can hold it, gone after a week, and that she can take back.

## Today

**On main:**

- **Upload.** `POST /api/files` streams to `data/files/` on the fs store (`receiveUpload()` in `fsStore()`). On Redis the whole body is buffered and kept as one base64 value (`SET <prefix>file:<id>`). The caps are `policy.maxFileBytes` (5 MB on fs and 512 KB on Redis; an admin can raise them to 50 MB and 1 MB), `maxFilesPerMessage` (10) and `maxAgentBytes` (200 MB or 10 MB). Vercel takes request bodies up to 4.5 MB, Upstash requests up to 10 MB.
- **No expiry, no delete.** A file record is an `apply()` op that `compact()` always keeps, and the bytes stay until the data folder goes.
- **Download.** `GET /api/files/:id`, for anyone who can read the Sphere, viewers with the join key included.
- **Sealing.** `encryptFile()` (in `getSec()`, `rep.mjs`) seals the whole file under one AES-256-GCM key, in memory; its key, IV and tag travel in the sealed envelope. `decryptFile()` can check the tag only once it has every byte, so a file must fit in memory, and a download can't be checked or resumed part by part.
- **Sending and receiving.** `readLocalFiles()` and `toolAttach()` refuse anything over 5 MB, whatever the policy says; `toolAttach()` takes only real files inside the Oby's folders that `isSecretPath()` doesn't flag. `runLocal()` saves an ask's files in `asks/<id>/inbox` (swept after a day by `sweepAsks()`), and `toolGetFile()` in `~/Downloads/obysphere`, never over an existing file (`uniquePath()`).

**In 0.3.0** (the `wave3/*-r` branches): files go with their message's channel, so a direct conversation's files are its two members' only, and a file not yet sent is its uploader's and the admins' (`visibleFiles()`). Admins are members, so admin members would set the new limits. `obysphere start` keeps the sender's Oby online whenever its computer is awake, which matters for option C. Notifications can tell Bob a handover arrived. Custom instruments change nothing here.

## What every option shares

### A bundle

The sender's representative makes one bundle of what it hands over:

- **A file** is a bundle of one file.
- **A folder** becomes a tar archive (POSIX ustar, with a pax `path` record for names longer than its 100 + 155 bytes). Only regular files and folders go in. Links, devices, `.git/`, `node_modules/` and anything `isSecretPath()` flags are left out, and the sender is told what was. The first entry, `.obysphere-snapshot.json`, lists each file's path, size and SHA-256. Entries are sorted, owners zeroed and times kept, so the same folder makes the same tar. A tar writer is about 120 lines: a 512-byte header per entry, the data padded to 512 bytes, two zero blocks at the end.

### Chunked sealing

The same construction as age's payload (STREAM):

- A fresh 32-byte file key and a 16-byte nonce. The payload key is HKDF-SHA256 of the file key, with the nonce as salt and `obysphere/bundle/v1` as info.
- The bundle is cut into 64 KiB chunks, each sealed with AES-256-GCM under the payload key. Its 12-byte IV is the chunk's number (11 bytes, big-endian) and one byte that is `1` on the last chunk and `0` before it.
- So each chunk is checked as it arrives. A chunk out of order fails, and a bundle cut short has no valid last chunk. The recipient writes to a temporary file and moves it into place only after the last chunk checks. The overhead is 16 bytes per 64 KiB.

### Parts, hashes and the manifest

The ciphertext is stored in **parts of 4 MiB** (64 chunks): under Vercel's 4.5 MB body limit, and the unit of upload, download and resume. Three checks:

- every chunk's GCM tag, which only the readers can check;
- every part's ciphertext SHA-256, which the relay checks on upload and the recipient before decrypting, so a corrupt or swapped part is found early and fetched again;
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

From #47. `rep.mjs` reads the tar itself, into a new folder, never over anything. It refuses absolute names, `..`, links, devices, and sizes that don't match the snapshot list or pass the cap, before writing a byte, and checks every file's hash. Files that could instruct an agent (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`, `.mcp.json`, `.vscode/`, `.husky/`) are held back, listed, and unpacked only when the owner approves in **Waiting for you**.

## Options

### A. The relay's own disk

**How it works.** The fs store gets three methods, `putPart()`, `readPart()` and `dropBundle()`, over `data/bundles/<id>/<n>` (mode 0600). Parts stream in and are hashed on the way, as `receiveUpload()` does, and stream out as `readFile()` does. The Redis store refuses bundles with a clear reason: Upstash keeps data in memory and takes 10 MB a request.

**Security and privacy.**

- **Sealed words and names:** only ciphertext on disk; no name, plaintext hash or key.
- **Keys and tokens:** in headers only; the file key only inside the envelope.
- **What the relay learns:** sender, readers, ciphertext size, part count, when, and who fetched it, when and how often.
- **Someone with the join key** can't fetch a bundle: readers only, unlike today's files.
- **A stolen device:** a reader's profile (its token and `keys.json`) fetches and opens every live bundle sealed to it. An admin removing that member stops the fetches, and the sender can revoke.
- **A malicious operator** sees sizes and times, can withhold or delete parts, and can keep ciphertext after a revoke. A swapped part fails its hash and its tags. It can't open anything.
- **A malicious member** fills only its own quota. A tar made to escape the folder, exhaust the disk or instruct the agent is stopped by the reader, the caps and the hold-back.

**Cost.** About 250 lines in a `// ===== bundles` section of `server.mjs`, and about 350 in `rep.mjs` (the tar writer and reader 200, chunked sealing 60, upload and download with resume 90). Hosting: a disk big enough on Railway or Docker; the relay carries every byte twice, in and out. Not for Vercel.

### B. An S3-compatible bucket

**How it works.** AWS S3, Cloudflare R2, Backblaze B2 and MinIO all speak S3's API. The relay gets `SPHERE_S3_ENDPOINT`, `SPHERE_S3_BUCKET`, `SPHERE_S3_REGION`, `SPHERE_S3_ACCESS_KEY_ID` and `SPHERE_S3_SECRET_ACCESS_KEY`, and signs its own requests with Signature Version 4 (HMAC-SHA256 from `node:crypto`, about 100 lines, no SDK). Each part is an object `b/<bundle id>/<n>`. Two ways to move the bytes:

- **B1, through the relay.** The same endpoints as A. The relay forwards each part to the bucket with a signed `Authorization` header, and streams downloads back. It works on Vercel: a 4 MiB part fits the body limit, and responses stream. No capability goes in a URL.
- **B2, presigned.** The relay hands the sender a presigned PUT for one part (that object, that SHA-256, 10 minutes) and a reader a presigned GET, and the bytes go straight to the bucket. S3's and R2's docs both call a presigned URL a bearer token, good for up to 7 days. Here it's one object, 10 minutes, ciphertext only, and the bucket's secret never leaves the relay: it bends the letter of "no keys in URLs", not its point. `rep.mjs` would never print, log or pass such a URL to another process.

Expiry: the relay deletes on revoke and expiry, and a lifecycle rule on `b/` (31 days) is the backstop for a relay that's down. S3 removes expired objects asynchronously, some time after the date.

**Security and privacy.** As in A, plus: the bucket's provider sees ciphertext, sizes and times, and with B2 also the members' addresses. A leaked bucket key gives the ciphertext of every live bundle and the power to delete it, not the words.

**Cost.** About 200 lines more in `server.mjs` (the signing and an S3 part store). An account and a bill with the provider. B1 also pays Vercel function time and transfer per byte; B2 doesn't.

**Vercel Blob,** set aside: its private stores fit (reads need a token, `ttlDays` expires blobs), but writes are documented only through the `@vercel/blob` SDK, which `server.mjs` can't depend on. Revisit if its REST API is documented; until then a Vercel Sphere can use an S3 bucket.

### C. Straight from the sender's machine

**How it works.** Nothing is stored on the relay. The sender's representative keeps the sealed bundle in its profile (`bundles/<id>.enc`), and the relay is a meeting point. A reader asks for a part; the relay sends a `pull` event down the sender's stream; the sender's representative sends that part; the relay pipes it to the reader without keeping it.

**Security and privacy.** The best for revoking and expiry: the sender deletes its file, and nothing is left anywhere. The relay learns the same as in A. The sender's representative serves only its own sealed bundles, by id, never a path.

**Cost.** About 150 lines in `server.mjs` and 120 in `rep.mjs`. Both machines must be online at once: `obysphere start` makes that likelier, a closed laptop stops it. One process only: on Vercel the two requests reach different instances, so Redis would have to carry the bytes.

## Recommendation

Build the shared format first, then **A**, then **B1**. A serves every fs Sphere with nothing to sign up for. B1 brings the same endpoints to Vercel with a bucket, still with no capability in a URL. Offer B2 only as an admin's choice (`SPHERE_S3_DIRECT=1`) for very large files, and C only if someone needs "nothing at rest".

## First step

**Folder snapshots within today's limits:** `rep.mjs` only, with no relay change and no new format.

- `sphere_ask` with a folder in `files`, `rep.mjs ask --file <folder>` and `sphere_attach` with a folder `path` pack it as a tar (the writer above) and send it as one sealed file, with today's `encryptFile()`, when it fits the Sphere's `maxFileBytes` (and the 5 MB `rep.mjs` allows today). Otherwise they say how big it was and what was left out.
- The receiving representative knows a snapshot by its type (`application/x-tar`) and its first entry, unpacks it with the safe reader into a new folder (the ask's inbox, or Downloads), holds back instruction files, and tells the agent what it got. An older `rep.mjs` just gets a `.tar`.
- It builds the tar writer, the safe reader and the hold-back that every later step needs.

Its tests, in `test/folders.test.mjs`:

- A folder makes the same tar twice, and it reads back whole; a name over 100 bytes survives through a pax record.
- `.env`, `id_ed25519`, `.git/`, `node_modules/`, a symlink and a FIFO are left out, and the sender is told.
- An archive with `../x`, `/etc/x`, a link, a device, or a size that doesn't match its list is refused before anything is written.
- `CLAUDE.md`, `AGENTS.md`, `.mcp.json` and `.claude/` are held back and listed.
- A folder over `maxFileBytes` is refused with its size, and nothing is uploaded.
- In a sealed Sphere, no name from the folder appears in the relay's data folder.

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

- [age's payload format](https://github.com/C2SP/C2SP/blob/main/age.md) (STREAM, 64 KiB chunks, the last-chunk flag); [POSIX pax and ustar](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html) (512-byte headers, name and prefix fields, the `path` record, the two zero blocks).
- [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) (bearer tokens, 7 days at most), [S3 multipart limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), [S3 expiring objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html) (asynchronous removal), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations) (4.5 MB request bodies, streamed responses), [Vercel Blob](https://vercel.com/docs/vercel-blob) (private stores, `ttlDays`, the SDK), [Upstash's request size limit](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded) (10 MB).
