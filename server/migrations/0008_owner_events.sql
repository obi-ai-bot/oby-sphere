-- Getting back in with a sign-in (spec/sphere-api.md section 3.2): why an owner's key changed, for
-- every member to read. `reason` is a closed code; `revoked` a JSON list of the agents the event
-- revoked. No account, email, domain or free text is ever kept here.
CREATE TABLE owner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sphere TEXT NOT NULL,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('signed_in_again', 'admin_reset', 'operator_reset', 'rotated')),
  at TEXT NOT NULL,
  old_key_id TEXT NOT NULL,
  new_key_id TEXT NOT NULL,
  revoked TEXT NOT NULL
);
CREATE INDEX owner_events_by_sphere ON owner_events (sphere, id);
