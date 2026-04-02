import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

export type AttachInput = {
  syncKey: string;
  deviceId: string;
  deviceName: string;
};

export type SyncChange = {
  eventId: string;
  entityType: "routine" | "routine_check";
  entityId: string;
  action: "create" | "update" | "delete" | "toggle" | "progress" | "update_timer";
  payload: Record<string, unknown>;
  updatedAt?: number | string;
};

export type SyncInput = {
  syncKey: string;
  deviceId: string;
  deviceName?: string;
  lastCursor?: number;
  changes: SyncChange[];
};

export type RegenerateKeyInput = {
  syncKey: string;
  deviceId: string;
};

type Snapshot = {
  routines: RoutineRow[];
  routineChecks: RoutineCheckRow[];
};

type RoutineRow = {
  id: string;
  title: string;
  type: "check" | "progress";
  frequency: string;
  weekdayMask: string;
  reminder: string;
  accent: string;
  focusMinutes: number;
  breakMinutes: number;
  targetValue: number | null;
  unit: string | null;
  stepValue: number | null;
  quickAdjustValues: number[];
  updatedAt: string;
  deletedAt: string | null;
};

type RoutineCheckRow = {
  routineId: string;
  date: string;
  completed: boolean;
  progressValue: number | null;
  updatedAt: string;
};

type ServerEvent = {
  cursor: number;
  eventId: string;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  updatedAt: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, "../schema.sql");

export function createDbPool(databaseUrl: string) {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
}

export async function runMigrations(pool: Pool) {
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

export async function healthcheck(pool: Pool) {
  await pool.query("SELECT 1");
}

export async function attachSyncSpace(pool: Pool, input: AttachInput) {
  const syncKey = input.syncKey.trim();
  if (!syncKey) {
    throw new Error("syncKey is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const syncKeyHash = hashSyncKey(syncKey);
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM sync_spaces WHERE sync_key_hash = $1",
      [syncKeyHash],
    );

    const spaceId = existing.rows[0]?.id ?? randomUUID();

    if (!existing.rows.length) {
      await client.query(
        "INSERT INTO sync_spaces (id, sync_key_hash) VALUES ($1, $2)",
        [spaceId, syncKeyHash],
      );
    }

    await upsertDevice(client, spaceId, input.deviceId, input.deviceName);

    const snapshot = await loadSnapshot(client, spaceId);
    const serverCursor = await loadLatestCursor(client, spaceId);

    await client.query("COMMIT");

    return {
      ok: true,
      spaceId,
      serverCursor,
      snapshot,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function syncChanges(pool: Pool, input: SyncInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const spaceId = await requireSpaceId(client, input.syncKey);
    await upsertDevice(client, spaceId, input.deviceId, input.deviceName ?? input.deviceId);

    const ackedEventIds: string[] = [];

    for (const change of input.changes) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO sync_events (
          sync_space_id, device_id, event_id, entity_type, entity_id, action, payload, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (sync_space_id, event_id) DO NOTHING
        RETURNING id`,
        [
          spaceId,
          input.deviceId,
          change.eventId,
          change.entityType,
          change.entityId,
          change.action,
          JSON.stringify(change.payload ?? {}),
          normalizeTimestamp(change.updatedAt),
        ],
      );

      ackedEventIds.push(change.eventId);
      if (!inserted.rowCount) {
        continue;
      }

      await applyChange(client, spaceId, input.deviceId, change);
    }

    const lastCursor = input.lastCursor ?? 0;
    const serverChanges = await loadServerChanges(client, spaceId, lastCursor);
    const serverCursor =
      serverChanges[serverChanges.length - 1]?.cursor ?? (await loadLatestCursor(client, spaceId));

    await client.query("COMMIT");

    return {
      ok: true,
      ackedEventIds,
      serverCursor,
      changes: serverChanges,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function regenerateSyncKey(pool: Pool, input: RegenerateKeyInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const spaceId = await requireSpaceId(client, input.syncKey);
    const nextSyncKey = generateSyncKey();

    await client.query(
      "UPDATE sync_spaces SET sync_key_hash = $2, updated_at = NOW() WHERE id = $1",
      [spaceId, hashSyncKey(nextSyncKey)],
    );

    const attached = await client.query(
      "SELECT 1 FROM devices WHERE sync_space_id = $1 AND device_id = $2",
      [spaceId, input.deviceId],
    );

    if (!attached.rowCount) {
      await client.query("ROLLBACK");
      throw new Error("등록된 기기에서만 키를 재생성할 수 있습니다.");
    }

    await client.query("COMMIT");

    return {
      ok: true,
      newSyncKey: nextSyncKey,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyChange(
  client: PoolClient,
  spaceId: string,
  deviceId: string,
  change: SyncChange,
) {
  const updatedAt = normalizeTimestamp(change.updatedAt);

  if (change.entityType === "routine") {
    if (change.action === "delete") {
      await client.query(
        `UPDATE routines
         SET is_active = FALSE,
             deleted_at = $4,
             updated_at = $4,
             last_modified_by = $3
         WHERE sync_space_id = $1
           AND id = $2
           AND updated_at <= $4`,
        [spaceId, change.entityId, deviceId, updatedAt],
      );
      return;
    }

    const payload = normalizeRoutinePayload(change.payload);
    await client.query(
      `INSERT INTO routines (
        sync_space_id, id, title, type, frequency, weekday_mask, reminder, accent,
        focus_minutes, break_minutes, target_value, unit, step_value, quick_adjust_values,
        is_active, deleted_at, updated_at, last_modified_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, TRUE, NULL, $15, $16)
      ON CONFLICT (sync_space_id, id) DO UPDATE
      SET title = EXCLUDED.title,
          type = EXCLUDED.type,
          frequency = EXCLUDED.frequency,
          weekday_mask = EXCLUDED.weekday_mask,
          reminder = EXCLUDED.reminder,
          accent = EXCLUDED.accent,
          focus_minutes = EXCLUDED.focus_minutes,
          break_minutes = EXCLUDED.break_minutes,
          target_value = EXCLUDED.target_value,
          unit = EXCLUDED.unit,
          step_value = EXCLUDED.step_value,
          quick_adjust_values = EXCLUDED.quick_adjust_values,
          is_active = TRUE,
          deleted_at = NULL,
          updated_at = EXCLUDED.updated_at,
          last_modified_by = EXCLUDED.last_modified_by
      WHERE routines.updated_at <= EXCLUDED.updated_at`,
      [
        spaceId,
        change.entityId,
        payload.title,
        payload.type,
        payload.frequency,
        payload.weekdayMask,
        payload.reminder,
        payload.accent,
        payload.focusMinutes,
        payload.breakMinutes,
        payload.targetValue,
        payload.unit,
        payload.stepValue,
        JSON.stringify(payload.quickAdjustValues),
        updatedAt,
        deviceId,
      ],
    );
    return;
  }

  if (change.entityType === "routine_check") {
    const payload = normalizeRoutineCheckPayload(change.payload, change.entityId);

    if (!payload.completed && (payload.progressValue ?? 0) <= 0) {
      await client.query(
        `DELETE FROM routine_checks
         WHERE sync_space_id = $1
           AND routine_id = $2
           AND check_date = $3
           AND updated_at <= $4`,
        [spaceId, payload.routineId, payload.date, updatedAt],
      );
      return;
    }

    await client.query(
      `INSERT INTO routine_checks (
        sync_space_id, routine_id, check_date, completed, progress_value, updated_at, last_modified_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sync_space_id, routine_id, check_date) DO UPDATE
       SET completed = EXCLUDED.completed,
           progress_value = EXCLUDED.progress_value,
           updated_at = EXCLUDED.updated_at,
           last_modified_by = EXCLUDED.last_modified_by
       WHERE routine_checks.updated_at <= EXCLUDED.updated_at`,
      [
        spaceId,
        payload.routineId,
        payload.date,
        payload.completed,
        payload.progressValue,
        updatedAt,
        deviceId,
      ],
    );
  }
}

async function loadSnapshot(client: PoolClient, spaceId: string): Promise<Snapshot> {
  const routinesResult = await client.query<{
    id: string;
    title: string;
    type: "check" | "progress";
    frequency: string;
    weekday_mask: string;
    reminder: string;
    accent: string;
    focus_minutes: number;
    break_minutes: number;
    target_value: number | null;
    unit: string | null;
    step_value: number | null;
    quick_adjust_values: number[] | null;
    updated_at: string;
    deleted_at: string | null;
  }>(
    `SELECT id, title, type, frequency, weekday_mask, reminder, accent, focus_minutes, break_minutes,
            target_value, unit, step_value, quick_adjust_values, updated_at, deleted_at
     FROM routines
     WHERE sync_space_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at ASC, id ASC`,
    [spaceId],
  );

  const checksResult = await client.query<{
    routine_id: string;
    check_date: string;
    completed: boolean;
    progress_value: number | null;
    updated_at: string;
  }>(
    `SELECT routine_id, check_date::text, completed, progress_value, updated_at
     FROM routine_checks
     WHERE sync_space_id = $1
     ORDER BY check_date ASC`,
    [spaceId],
  );

  return {
    routines: routinesResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      frequency: row.frequency,
      weekdayMask: row.weekday_mask,
      reminder: row.reminder,
      accent: row.accent,
      focusMinutes: row.focus_minutes,
      breakMinutes: row.break_minutes,
      targetValue: row.target_value,
      unit: row.unit,
      stepValue: row.step_value,
      quickAdjustValues: Array.isArray(row.quick_adjust_values) ? row.quick_adjust_values : [],
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    })),
    routineChecks: checksResult.rows.map((row) => ({
      routineId: row.routine_id,
      date: row.check_date,
      completed: row.completed,
      progressValue: row.progress_value,
      updatedAt: row.updated_at,
    })),
  };
}

async function loadServerChanges(client: PoolClient, spaceId: string, lastCursor: number): Promise<ServerEvent[]> {
  const result = await client.query<{
    id: string;
    event_id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    payload: Record<string, unknown>;
    updated_at: string;
  }>(
    `SELECT id, event_id, entity_type, entity_id, action, payload, updated_at
     FROM sync_events
     WHERE sync_space_id = $1 AND id > $2
     ORDER BY id ASC`,
    [spaceId, lastCursor],
  );

  return result.rows.map((row) => ({
    cursor: Number(row.id),
    eventId: row.event_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    payload: row.payload,
    updatedAt: row.updated_at,
  }));
}

async function loadLatestCursor(client: PoolClient, spaceId: string) {
  const result = await client.query<{ max_id: string | null }>(
    "SELECT MAX(id) AS max_id FROM sync_events WHERE sync_space_id = $1",
    [spaceId],
  );

  return Number(result.rows[0]?.max_id ?? 0);
}

async function requireSpaceId(client: PoolClient, syncKey: string) {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM sync_spaces WHERE sync_key_hash = $1",
    [hashSyncKey(syncKey.trim())],
  );

  const spaceId = result.rows[0]?.id;
  if (!spaceId) {
    throw new Error("유효한 동기화 키를 찾을 수 없습니다.");
  }

  return spaceId;
}

async function upsertDevice(client: PoolClient, spaceId: string, deviceId: string, deviceName: string) {
  await client.query(
    `INSERT INTO devices (sync_space_id, device_id, device_name, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sync_space_id, device_id) DO UPDATE
     SET device_name = EXCLUDED.device_name,
         last_seen_at = NOW()`,
    [spaceId, deviceId, deviceName],
  );
}

function hashSyncKey(syncKey: string) {
  return createHash("sha256").update(syncKey).digest("hex");
}

function normalizeTimestamp(input?: number | string) {
  if (typeof input === "number") {
    const milliseconds = input < 10_000_000_000 ? input * 1000 : input;
    return new Date(milliseconds).toISOString();
  }

  if (typeof input === "string" && input.trim()) {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

function generateSyncKey() {
  const chunk = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DC-${chunk()}-${chunk()}-${chunk()}`;
}

function normalizeRoutinePayload(payload: Record<string, unknown>) {
  const title = String(payload.title ?? "").trim();
  const type = payload.type === "progress" ? "progress" : "check";
  const frequency = String(payload.frequency ?? "Daily");
  const weekdayMask = String(payload.weekdayMask ?? "1111111");
  const reminder = String(payload.reminder ?? "").trim();
  const accent = String(payload.accent ?? "#f97316");
  const focusMinutes = sanitizeMinutes(payload.focusMinutes, 50, 10);
  const breakMinutes = sanitizeMinutes(payload.breakMinutes, 10, 5);
  const targetValue = type === "progress" ? sanitizePositiveInteger(payload.targetValue, 100) : null;
  const unit =
    type === "progress" ? String(payload.unit ?? "회").trim() || "회" : null;
  const stepValue = type === "progress" ? sanitizePositiveInteger(payload.stepValue, 10) : null;
  const quickAdjustValues = type === "progress"
    ? sanitizeQuickAdjustValues(payload.quickAdjustValues, targetValue ?? 100, stepValue ?? 10)
    : [];

  if (!title) {
    throw new Error("루틴 제목이 필요합니다.");
  }

  return {
    title,
    type,
    frequency,
    weekdayMask,
    reminder,
    accent,
    focusMinutes,
    breakMinutes,
    targetValue,
    unit,
    stepValue,
    quickAdjustValues,
  };
}

function normalizeRoutineCheckPayload(payload: Record<string, unknown>, fallbackEntityId: string) {
  const routineId = String(payload.routineId ?? fallbackEntityId.split(":")[0] ?? "").trim();
  const date = String(payload.date ?? fallbackEntityId.split(":")[1] ?? "").trim();
  const completed = Boolean(payload.completed);
  const progressValue = sanitizeNullableProgressValue(payload.progressValue);

  if (!routineId || !date) {
    throw new Error("체크 데이터가 올바르지 않습니다.");
  }

  return {
    routineId,
    date,
    completed,
    progressValue,
  };
}

function sanitizeMinutes(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.round(parsed));
}

function sanitizePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.round(parsed));
}

function sanitizeNullableProgressValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.round(parsed));
}

function sanitizeQuickAdjustValues(value: unknown, targetValue: number, stepValue: number) {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry !== 0)
    .map((entry) => Math.max(-targetValue, Math.min(targetValue, Math.round(entry))));

  if (!normalized.length) {
    return [-stepValue, stepValue, stepValue * 2];
  }

  return [...new Set(normalized)].sort((left, right) => left - right);
}
