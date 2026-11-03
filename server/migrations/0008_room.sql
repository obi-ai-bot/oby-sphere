-- The room (spec/sphere-api.md section 6.5): each Sphere's newest 5,000 posts, as their senders
-- signed them, sealed for each member. Apart from the chain: nothing here touches `audit`. Numbered
-- past 0006 and 0007, and needing neither, so it can go out on a server that hasn't got them yet.
CREATE TABLE room_posts (
  sphere TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  from_obi TEXT NOT NULL,
  recorded_at_s INTEGER NOT NULL,
  post TEXT NOT NULL,
  PRIMARY KEY (sphere, seq),
  UNIQUE (sphere, id)
);
CREATE INDEX room_posts_by_sender ON room_posts (sphere, from_obi, recorded_at_s);
