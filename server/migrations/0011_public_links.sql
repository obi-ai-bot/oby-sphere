-- Public links (spec/sphere-api.md section 11): one row per link, the object in the ARTIFACTS
-- bucket that holds its current ciphertext (public/<linkId>/<uuid>: each version its own, so a
-- replace that fails leaves the live one), when it expires, and the page its owner's client
-- uploaded, if any. A link id is the server's, not one Sphere's: /a/<linkId> names no Sphere.
CREATE TABLE public_links (
  link_id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  owner_obi TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at_s INTEGER NOT NULL,
  page TEXT,
  page_sha256 TEXT,
  updated_at_s INTEGER NOT NULL
);
CREATE INDEX public_links_by_sphere ON public_links (sphere, owner_obi);
CREATE INDEX public_links_by_expiry ON public_links (expires_at_s);
