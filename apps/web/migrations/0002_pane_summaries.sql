CREATE TABLE pane_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX pane_summaries_lookup ON pane_summaries(machine_id, space_id, pane_id, seq DESC);
