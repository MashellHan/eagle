CREATE TABLE machine_hour_reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(machine_id, hour)
);
CREATE INDEX machine_hour_history ON machine_hour_reports(machine_id, hour DESC);
CREATE INDEX fleet_hour_history ON machine_hour_reports(hour DESC, seq DESC);
