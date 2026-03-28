PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  frequency TEXT NOT NULL,
  monthly_day INTEGER,
  weekday_mask TEXT,
  reminder TEXT NOT NULL,
  focus_minutes INTEGER NOT NULL,
  break_minutes INTEGER NOT NULL,
  accent TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS routine_checks (
  routine_id TEXT NOT NULL,
  check_date TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (routine_id, check_date),
  FOREIGN KEY (routine_id) REFERENCES routines(id)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_routines_active ON routines(is_active, deleted_at);
CREATE INDEX IF NOT EXISTS idx_routine_checks_date ON routine_checks(check_date);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(sync_status, created_at);
