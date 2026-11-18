-- Getting back in with a sign-in (spec/sphere-api.md section 3.2): what happened to an owner, for
-- every member to read. `revoked` is a JSON list of the agents the event revoked. No account,
-- email or domain is ever kept here.
CREATE TABLE owner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sphere TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  old_key_id TEXT NOT NULL,
  new_key_id TEXT NOT NULL,
  account_linked INTEGER CHECK (account_linked IN (0, 1)),
  revoked TEXT NOT NULL
);
CREATE INDEX owner_events_by_sphere ON owner_events (sphere, id);
