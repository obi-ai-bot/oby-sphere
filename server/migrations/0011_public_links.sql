-- Public links (spec/sphere-api.md section 11): one row per link, its ciphertext in the ARTIFACTS
-- bucket under public/<linkId>, and the page its owner's client uploaded, if any. A link id is the
-- server's, not one Sphere's: /a/<linkId> names no Sphere.
CREATE TABLE public_links (
  link_id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  owner_obi TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  page TEXT,
  page_sha256 TEXT,
  updated_at_s INTEGER NOT NULL
);
CREATE INDEX public_links_by_sphere ON public_links (sphere);

-- How many public requests each client made this minute: the rate limit. `client` is SHA-256 of
-- the client's address and the minute, so it says nothing once the minute is over, and it goes.
CREATE TABLE public_hits (
  client TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX public_hits_by_minute ON public_hits (minute);
