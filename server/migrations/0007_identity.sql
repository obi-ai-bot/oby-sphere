-- Signing in with any OpenID Connect provider (spec/sphere-api.md section 3.1): which provider a
-- sign-in is with, and where its code goes back to (null: obi-sphere://signin). Sign-ins made
-- before were all with Google.
ALTER TABLE sign_ins ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
ALTER TABLE sign_ins ADD COLUMN return_to TEXT;

-- Tokens bound to a key (DPoP, spec/identity.md section 4.6): the RFC 7638 thumbprint of the key a
-- token is bound to, or null for a bearer token.
ALTER TABLE tokens ADD COLUMN jkt TEXT;

-- The DPoP proofs the token endpoint took, by key and jti, until they can no longer be used: each
-- proof gets one token.
CREATE TABLE dpop_proofs (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  exp_s INTEGER NOT NULL,
  PRIMARY KEY (jkt, jti)
);
CREATE INDEX dpop_proofs_expiry ON dpop_proofs (exp_s);
