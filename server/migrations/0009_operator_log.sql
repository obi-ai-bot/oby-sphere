-- The operator's acts on an Obysphere (spec/sphere-api.md section 3.3): every call made with the
-- operator token, for the Obysphere's admins to read. Never a secret: no token, no invitation secret.
CREATE TABLE operator_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sphere TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT
);
CREATE INDEX operator_log_by_sphere ON operator_log (sphere, id);

