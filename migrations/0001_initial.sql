CREATE TABLE reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE(machine_id, report_id)
);
CREATE INDEX reports_history ON reports(machine_id, seq DESC);
CREATE INDEX reports_capture ON reports(machine_id, captured_at DESC, report_id DESC);
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  latest_seq INTEGER NOT NULL REFERENCES reports(seq),
  latest_captured_at TEXT NOT NULL,
  latest_report_id TEXT NOT NULL,
  warning TEXT
);
