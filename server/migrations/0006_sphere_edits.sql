-- What admins change after a Sphere is made (spec/sphere-api.md sections 3 and 4): its picture (a
-- square PNG, base64, and its SHA-256), more admins than the owner who made it, and invitations
-- the admins can list (when each was made, and a label of theirs, never an address). A deleted
-- Sphere's id stays taken, so nobody makes another under the address its members knew.
ALTER TABLE spheres ADD COLUMN image TEXT;
ALTER TABLE spheres ADD COLUMN image_sha256 TEXT;
ALTER TABLE owners ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1));
UPDATE owners SET admin = 1 WHERE owner = (SELECT admin_owner FROM spheres WHERE spheres.id = owners.sphere);
ALTER TABLE invitations ADD COLUMN label TEXT;
ALTER TABLE invitations ADD COLUMN created_at_s INTEGER;
CREATE TABLE deleted_spheres (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
