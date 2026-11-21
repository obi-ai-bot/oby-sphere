-- Artifacts (spec/sphere-api.md section 10): the blobs a member uploads, ciphertext only, kept in
-- the ARTIFACTS bucket under blobs/<sphere>/<id>; who each is for; and which exchanges named each,
-- so that taking a share back cuts its receiver off from every blob the share named.
CREATE TABLE blobs (
  sphere TEXT NOT NULL,
  id TEXT NOT NULL,
  uploader TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at_s INTEGER NOT NULL,
  created_at_s INTEGER NOT NULL,
  PRIMARY KEY (sphere, id)
);
CREATE INDEX blobs_by_expiry ON blobs (sphere, expires_at_s);

CREATE TABLE blob_recipients (
  sphere TEXT NOT NULL,
  blob TEXT NOT NULL,
  obi TEXT NOT NULL,
  PRIMARY KEY (sphere, blob, obi)
);

CREATE TABLE artifact_blobs (
  sphere TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (sphere, correlation_id, blob)
);
CREATE INDEX artifact_blobs_by_blob ON artifact_blobs (sphere, blob);
