CREATE TABLE IF NOT EXISTS sync_spaces (
  id UUID PRIMARY KEY,
  sync_key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  sync_space_id UUID NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sync_space_id, device_id)
);

CREATE TABLE IF NOT EXISTS routines (
  sync_space_id UUID NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'check',
  frequency TEXT NOT NULL,
  weekday_mask TEXT NOT NULL,
  reminder TEXT NOT NULL,
  accent TEXT NOT NULL,
  focus_minutes INTEGER NOT NULL DEFAULT 50,
  break_minutes INTEGER NOT NULL DEFAULT 10,
  target_value INTEGER NULL,
  unit TEXT NULL,
  step_value INTEGER NULL,
  quick_adjust_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_modified_by TEXT NOT NULL,
  PRIMARY KEY (sync_space_id, id)
);

CREATE TABLE IF NOT EXISTS routine_checks (
  sync_space_id UUID NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL,
  check_date DATE NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT TRUE,
  progress_value INTEGER NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_modified_by TEXT NOT NULL,
  PRIMARY KEY (sync_space_id, routine_id, check_date),
  FOREIGN KEY (sync_space_id, routine_id) REFERENCES routines(sync_space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_events (
  id BIGSERIAL PRIMARY KEY,
  sync_space_id UUID NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sync_space_id, event_id)
);

CREATE INDEX IF NOT EXISTS sync_events_space_cursor_idx
  ON sync_events (sync_space_id, id);

CREATE INDEX IF NOT EXISTS routines_space_updated_idx
  ON routines (sync_space_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS routine_checks_space_date_idx
  ON routine_checks (sync_space_id, check_date DESC);

ALTER TABLE routines ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'check';
ALTER TABLE routines ADD COLUMN IF NOT EXISTS target_value INTEGER NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS unit TEXT NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS step_value INTEGER NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS quick_adjust_values JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE routine_checks ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE routine_checks ADD COLUMN IF NOT EXISTS progress_value INTEGER NULL;
