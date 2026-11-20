-- Which part of a ciphertext over 64 MiB each blob is (spec/sphere-api.md section 10): only part 1
-- has the age header the Obysphere checks, so an offer may name a blob as its first part, or as
-- its one blob, only when it went up as part 1, and blobs[i] only when it went up as part i + 1.
ALTER TABLE blobs ADD COLUMN part INTEGER NOT NULL DEFAULT 1;
