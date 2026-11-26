### Check the audit log yourself

The console's "Chain verified" is the relay's own word. Now you can download the whole audit log and check it on your machine, with code that doesn't come from the relay (#141):

```bash
obysphere admin audit export     # the whole log, as JSON Lines
obysphere admin audit verify     # the relay's log, checked here: it asks for the admin key
obysphere admin audit verify our-sphere-audit-2026-11-26.jsonl --since our-sphere-audit-2026-11-01.jsonl
```

- **`obysphere admin audit export [--out <file> | -] [--after <seq>] [--force]`** pages through the log, 1,000 events at a time, with your Oby's token, and saves it as JSON Lines: one event per line, as the relay sent it, the same format as a Sphere's own `data/audit.jsonl`. Any member may, as `GET /api/audit` allows; the relay doesn't record the read. The file is owner-only (0600): it holds no words, but it names every member and private channel, and who asked whom. An existing file needs `--force`.
- **`obysphere admin audit verify [<file>] [--since <older export>] [--json]`** checks the chain with the admin key: every event from #1, with no gaps, each one following the one before, each hash under the key. It names the first event that fails ("Event #4,211 (ask, 20 Nov 14:03) doesn't check with this key: it was changed, or the key is wrong. Nothing from #4,211 on is proven.") and exits 0 verified, 1 it doesn't check, 2 it couldn't be checked. A file made with `--after` is checked from its first event, and says so. It works on a Sphere's own `data/audit.jsonl` too, with no profile.
- **Online, more.** Without a file, `verify` downloads the log and also checks that it ends where the relay says it does, and that each ask, reply and post the relay still holds is what was recorded when it was posted (sealed ones as stored, so nothing is opened). It counts those it no longer holds, and those in channels your Oby isn't in. A deleted message passes only with its `delete` event, and one its delete event says is gone may not still have its words (#139). Once cuts are recorded, a message missing after the last cut fails, for an admin's Oby (which sees every channel): it was removed by hand. A message older than the Sphere keeps messages may be missing before its cut, which comes within the hour.
- **Earlier heads.** Each online check that passes keeps the log's head in your profile (`audit-heads.json`, 0600), and the next one makes sure the log still holds it, unchanged. `--since <older export>` does the same with an export you kept. They catch a log cut back or rewritten, even by someone with the admin key, which the chain alone can't.
- **The key stays on your machine.** It comes from `OBYSPHERE_ADMIN_KEY` or a prompt that doesn't echo, as for `admin claim`, makes the chain's key at once, and is never sent, printed or stored. `--admin-key` is refused.
- **The console's Export all saves the whole log as JSON Lines**, ready for `verify`, and the Audit log page says that "Chain verified" is the relay's word, and how to check it yourself. Export shown still saves the events the filters show, as JSON.
