CREATE TABLE message (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data         TEXT
);

CREATE TABLE part (
  id           TEXT PRIMARY KEY,
  message_id   TEXT,
  session_id   TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data         TEXT
);

CREATE INDEX part_message_id_id_idx ON part (message_id, id);
