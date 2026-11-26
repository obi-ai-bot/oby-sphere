### Files of your own that answers never read

You can now name files and folders of your own that answers never read, besides `.env` files, keys and credentials (#125): `machine.neverRead` in settings.json, or **Never read** in your console's **Settings › This computer**, a name at a time ([SETTINGS.md](SETTINGS.md#your-own-neverread)).

```json
"neverRead": ["*.sqlite", "customers/", "notes/private-*.md"]
```

- **Written as the built-in list is.** A name counts anywhere inside your folders, `*` is any characters inside one name, `/` joins names, and a name that ends in `/` is a folder and everything in it.
- **Held the same three ways, for every answer.** Claude Code's Read rules (and Edit rules, in a writable folder), the sandbox of read-only commands, and `rep.mjs`'s own checks: `sphere_attach` refuses such a file ("your owner keeps that file private"), and `serve --cwd` refuses a folder they hide. The same code makes them as makes the built-in list, and they come after it: nothing you write takes a file off it. The full shell, Codex and Cursor can't be kept from reading them, as for the built-in list. A change to them starts each conversation afresh, so an answer never carries on from one that read a file you now hide.
- **Checked like every setting.** An error names the one that's wrong. Refused: an empty name, a full path, `..`, `**`, `*` or `*.*` alone (they'd hide every file, or nearly), glob or rule marks other than `*` and `/`, characters that can't be seen, and a name that would hide one of your folders whole. At most 50 names, of up to 200 characters and four `*` each.
- **Private.** They never reach the Sphere: what your Oby tells it (`POST /api/me`) is the same with or without them, and a change to them alone tells it nothing. The answering model isn't told them either.
- **In the console.** The field sits under your folders: type a name and press Enter, and × takes one off. A name that doesn't pass is said right under the field. The built-in list is folded under it, read-only ("Always hidden: .env files, keys, credentials and similar"). `GET /local/settings` now also gives that list, as `neverReadBuiltIn`.
- **In words.** `rep.mjs settings` lists them after what your Oby may touch.
- **Older files and versions.** With no names, settings.json has no `neverRead`, so an older `rep.mjs` still reads it; one with names needs this version.
