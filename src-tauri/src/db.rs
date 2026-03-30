use anyhow::{Context, Result};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use uuid::Uuid;

const DEFAULT_FOCUS_MINUTES: i64 = 50;
const DEFAULT_BREAK_MINUTES: i64 = 10;
const DEFAULT_SYNC_SERVER_URL: &str = "http://localhost:8787";
const DEFAULT_DEVICE_NAME: &str = "Daily Check macOS";

#[derive(Clone)]
pub struct AppState {
  pub db_path: PathBuf,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRecord {
  pub id: String,
  pub title: String,
  pub frequency: String,
  pub weekday_mask: String,
  pub reminder: String,
  pub focus_minutes: i64,
  pub break_minutes: i64,
  pub accent: String,
  pub completed_dates: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
  pub has_sync_key: bool,
  pub sound_enabled: bool,
  pub outbox_count: i64,
  pub sync_server_url: String,
  pub last_sync_at: Option<String>,
  pub routines: Vec<RoutineRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResponse {
  pub unlocked: bool,
  pub sync_key: Option<String>,
  pub message: String,
  pub snapshot: Option<AppSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncKeyResponse {
  pub sync_key: String,
  pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncActionResponse {
  pub snapshot: AppSnapshot,
  pub message: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInput {
  pub title: String,
  pub frequency: String,
  pub weekday_mask: String,
  pub reminder: String,
  pub accent: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutineUpdateInput {
  pub id: String,
  pub title: String,
  pub frequency: String,
  pub weekday_mask: String,
  pub reminder: String,
  pub accent: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimerUpdateInput {
  pub id: String,
  pub focus_minutes: i64,
  pub break_minutes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAttachResponse {
  server_cursor: i64,
  snapshot: RemoteSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSnapshot {
  routines: Vec<RemoteRoutine>,
  routine_checks: Vec<RemoteRoutineCheck>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRoutine {
  id: String,
  title: String,
  frequency: String,
  weekday_mask: String,
  reminder: String,
  accent: String,
  focus_minutes: i64,
  break_minutes: i64,
  updated_at: String,
  deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRoutineCheck {
  routine_id: String,
  date: String,
  completed: bool,
  updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSyncResponse {
  acked_event_ids: Vec<String>,
  server_cursor: i64,
  changes: Vec<RemoteSyncEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSyncEvent {
  entity_type: String,
  entity_id: String,
  action: String,
  payload: Value,
  updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachRequest {
  sync_key: String,
  device_id: String,
  device_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest {
  sync_key: String,
  device_id: String,
  device_name: String,
  last_cursor: i64,
  changes: Vec<SyncEventRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEventRequest {
  event_id: String,
  entity_type: String,
  entity_id: String,
  action: String,
  payload: Value,
  updated_at: String,
}

#[derive(Debug)]
struct OutboxRow {
  id: String,
  entity_type: String,
  entity_id: String,
  action: String,
  payload: String,
  created_at: i64,
}

#[derive(Debug)]
struct LocalRoutineSyncPayload {
  title: String,
  frequency: String,
  weekday_mask: String,
  reminder: String,
  accent: String,
  focus_minutes: i64,
  break_minutes: i64,
  updated_at: i64,
}

pub fn init_database(db_path: &Path) -> Result<()> {
  if let Some(parent) = db_path.parent() {
    fs::create_dir_all(parent).context("failed to create app data directory")?;
  }

  let conn = open_connection(db_path)?;
  run_migrations(&conn)?;

  if get_setting(&conn, "sound_enabled")?.is_none() {
    set_setting(&conn, "sound_enabled", "false")?;
  }

  if get_setting(&conn, "sync_server_url")?.is_none() {
    set_setting(&conn, "sync_server_url", DEFAULT_SYNC_SERVER_URL)?;
  }

  get_or_create_device_id(&conn)?;

  seed_routines_if_needed(&conn)?;
  Ok(())
}

#[tauri::command]
pub fn bootstrap_app(state: State<AppState>) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  load_snapshot(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn unlock_app(input: String, state: State<AppState>) -> Result<UnlockResponse, String> {
  let trimmed = input.trim();

  if trimmed.is_empty() {
    return Ok(UnlockResponse {
      unlocked: false,
      sync_key: None,
      message: "동기화 키를 입력하세요.".into(),
      snapshot: None,
    });
  }

  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let existing = get_setting(&conn, "sync_key").map_err(|error| error.to_string())?;
  let server_url = get_sync_server_url(&conn).map_err(|error| error.to_string())?;
  let device_id = get_or_create_device_id(&conn).map_err(|error| error.to_string())?;

  match existing {
    Some(saved_key) if saved_key == trimmed => {
      if let Err(error) = prepare_remote_sync(&conn, &server_url, trimmed, &device_id) {
        let snapshot = load_snapshot(&conn).map_err(|snapshot_error| snapshot_error.to_string())?;
        return Ok(UnlockResponse {
          unlocked: true,
          sync_key: Some(saved_key),
          message: format!(
            "서버에 연결하지 못해 오프라인 모드로 엽니다. {}",
            error
          ),
          snapshot: Some(snapshot),
        });
      }

      let snapshot = match sync_with_server(&conn, &server_url, trimmed, &device_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
          let snapshot = load_snapshot(&conn).map_err(|snapshot_error| snapshot_error.to_string())?;
          return Ok(UnlockResponse {
            unlocked: true,
            sync_key: Some(saved_key),
            message: format!(
              "동기화 없이 오프라인 모드로 엽니다. {}",
              error
            ),
            snapshot: Some(snapshot),
          });
        }
      };

      Ok(UnlockResponse {
        unlocked: true,
        sync_key: Some(saved_key),
        message: "저장된 동기화 키와 서버 연결을 확인했습니다.".into(),
        snapshot: Some(snapshot),
      })
    }
    Some(_) => Ok(UnlockResponse {
      unlocked: false,
      sync_key: None,
      message: "키가 일치하지 않습니다. 다시 확인하거나 키를 재생성해보세요.".into(),
      snapshot: None,
    }),
    None => {
      set_setting(&conn, "sync_key", trimmed).map_err(|error| error.to_string())?;
      if let Err(error) = prepare_remote_sync(&conn, &server_url, trimmed, &device_id) {
        let snapshot = load_snapshot(&conn).map_err(|snapshot_error| snapshot_error.to_string())?;
        return Ok(UnlockResponse {
          unlocked: true,
          sync_key: Some(trimmed.to_string()),
          message: format!(
            "동기화 키를 로컬에 저장했고, 서버 없이 오프라인 모드로 엽니다. {}",
            error
          ),
          snapshot: Some(snapshot),
        });
      }

      let snapshot = match sync_with_server(&conn, &server_url, trimmed, &device_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
          let snapshot = load_snapshot(&conn).map_err(|snapshot_error| snapshot_error.to_string())?;
          return Ok(UnlockResponse {
            unlocked: true,
            sync_key: Some(trimmed.to_string()),
            message: format!(
              "동기화 키를 저장했고, 지금은 오프라인 모드로 엽니다. {}",
              error
            ),
            snapshot: Some(snapshot),
          });
        }
      };

      Ok(UnlockResponse {
        unlocked: true,
        sync_key: Some(trimmed.to_string()),
        message: "동기화 키를 저장하고 서버와 연결했습니다.".into(),
        snapshot: Some(snapshot),
      })
    }
  }
}

#[tauri::command]
pub fn regenerate_sync_key(state: State<AppState>) -> Result<SyncKeyResponse, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let server_url = get_sync_server_url(&conn).map_err(|error| error.to_string())?;
  let device_id = get_or_create_device_id(&conn).map_err(|error| error.to_string())?;

  let sync_key = match get_setting(&conn, "sync_key").map_err(|error| error.to_string())? {
    Some(existing_key) => {
      let client = build_http_client().map_err(|error| error.to_string())?;
      let next_key =
        regenerate_remote_key(&client, &server_url, &existing_key, &device_id).map_err(|error| error.to_string())?;
      set_setting(&conn, "sync_key", &next_key).map_err(|error| error.to_string())?;
      next_key
    }
    None => generate_sync_key(),
  };

  Ok(SyncKeyResponse {
    sync_key,
    message: "새 동기화 키를 준비했습니다.".into(),
  })
}

#[tauri::command]
pub fn update_sync_server_url(input: String, state: State<AppState>) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let normalized = normalize_server_url(&input)?;
  set_setting(&conn, "sync_server_url", &normalized).map_err(|error| error.to_string())?;
  load_snapshot(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_now(state: State<AppState>) -> Result<SyncActionResponse, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let sync_key = get_setting(&conn, "sync_key")
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "동기화 키를 먼저 설정하세요.".to_string())?;
  let server_url = get_sync_server_url(&conn).map_err(|error| error.to_string())?;
  let device_id = get_or_create_device_id(&conn).map_err(|error| error.to_string())?;
  prepare_remote_sync(&conn, &server_url, &sync_key, &device_id).map_err(|error| error.to_string())?;
  let snapshot = sync_with_server(&conn, &server_url, &sync_key, &device_id).map_err(|error| error.to_string())?;

  Ok(SyncActionResponse {
    snapshot,
    message: "서버와 동기화를 마쳤습니다.".into(),
  })
}

fn with_write_transaction<T, F>(conn: &Connection, operation: F) -> Result<T, String>
where
  F: FnOnce(&Connection) -> Result<T, String>,
{
  conn
    .execute_batch("BEGIN IMMEDIATE")
    .map_err(|error| error.to_string())?;

  match operation(conn) {
    Ok(value) => {
      if let Err(error) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(error.to_string());
      }
      Ok(value)
    }
    Err(error) => {
      let _ = conn.execute_batch("ROLLBACK");
      Err(error)
    }
  }
}

#[tauri::command]
pub fn create_routine(input: RoutineInput, state: State<AppState>) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let now = current_timestamp();
  let payload = sanitize_routine_input(input)?;
  let id = Uuid::new_v4().to_string();

  with_write_transaction(&conn, |conn| {
    conn
      .execute(
        "INSERT INTO routines (
          id, title, frequency, monthly_day, weekday_mask, reminder, focus_minutes, break_minutes,
          accent, is_active, created_at, updated_at, deleted_at
        ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, NULL)",
        params![
          id,
          payload.title,
          payload.frequency,
          payload.weekday_mask,
          payload.reminder,
          DEFAULT_FOCUS_MINUTES,
          DEFAULT_BREAK_MINUTES,
          payload.accent,
          now
        ],
      )
      .map_err(|error| error.to_string())?;

    queue_outbox(conn, "routine", &id, "create", &payload).map_err(|error| error.to_string())?;
    load_snapshot(conn).map_err(|error| error.to_string())
  })
}

#[tauri::command]
pub fn update_routine(
  input: RoutineUpdateInput,
  state: State<AppState>,
) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let now = current_timestamp();
  let payload = sanitize_routine_input(RoutineInput {
    title: input.title,
    frequency: input.frequency,
    weekday_mask: input.weekday_mask,
    reminder: input.reminder,
    accent: input.accent,
  })?;

  with_write_transaction(&conn, |conn| {
    conn
      .execute(
        "UPDATE routines
         SET title = ?2,
             frequency = ?3,
             weekday_mask = ?4,
             monthly_day = NULL,
             reminder = ?5,
             accent = ?6,
             updated_at = ?7
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
          input.id,
          payload.title,
          payload.frequency,
          payload.weekday_mask,
          payload.reminder,
          payload.accent,
          now
        ],
      )
      .map_err(|error| error.to_string())?;

    queue_outbox(conn, "routine", &input.id, "update", &payload).map_err(|error| error.to_string())?;
    load_snapshot(conn).map_err(|error| error.to_string())
  })
}

#[tauri::command]
pub fn delete_routine(routine_id: String, state: State<AppState>) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let now = current_timestamp();

  with_write_transaction(&conn, |conn| {
    conn
      .execute(
        "UPDATE routines
         SET is_active = 0,
             deleted_at = ?2,
             updated_at = ?2
         WHERE id = ?1 AND deleted_at IS NULL",
        params![routine_id, now],
      )
      .map_err(|error| error.to_string())?;

    queue_outbox(
      conn,
      "routine",
      &routine_id,
      "delete",
      &json!({ "deletedAt": now }),
    )
    .map_err(|error| error.to_string())?;

    load_snapshot(conn).map_err(|error| error.to_string())
  })
}

#[tauri::command]
pub fn toggle_routine_check(
  routine_id: String,
  date: String,
  state: State<AppState>,
) -> Result<AppSnapshot, String> {
  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let now = current_timestamp();

  with_write_transaction(&conn, |conn| {
    let exists = conn
      .query_row(
        "SELECT 1 FROM routine_checks WHERE routine_id = ?1 AND check_date = ?2",
        params![routine_id, date],
        |_| Ok(true),
      )
      .optional()
      .map_err(|error| error.to_string())?
      .unwrap_or(false);

    if exists {
      conn
        .execute(
          "DELETE FROM routine_checks WHERE routine_id = ?1 AND check_date = ?2",
          params![routine_id, date],
        )
        .map_err(|error| error.to_string())?;
    } else {
      conn
        .execute(
          "INSERT INTO routine_checks (routine_id, check_date, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(routine_id, check_date) DO UPDATE SET updated_at = excluded.updated_at",
          params![routine_id, date, now],
        )
        .map_err(|error| error.to_string())?;
    }

    queue_outbox(
      conn,
      "routine_check",
      &routine_id,
      "toggle",
      &json!({ "date": date, "completed": !exists }),
    )
    .map_err(|error| error.to_string())?;

    load_snapshot(conn).map_err(|error| error.to_string())
  })
}

#[tauri::command]
pub fn update_routine_timer(
  input: TimerUpdateInput,
  state: State<AppState>,
) -> Result<AppSnapshot, String> {
  if input.focus_minutes < 10 || input.break_minutes < 5 {
    return Err("집중은 10분 이상, 휴식은 5분 이상이어야 합니다.".into());
  }

  let conn = open_connection(&state.db_path).map_err(|error| error.to_string())?;
  let now = current_timestamp();

  with_write_transaction(&conn, |conn| {
    conn
      .execute(
        "UPDATE routines
         SET focus_minutes = ?2,
             break_minutes = ?3,
             updated_at = ?4
         WHERE id = ?1 AND deleted_at IS NULL",
        params![input.id, input.focus_minutes, input.break_minutes, now],
      )
      .map_err(|error| error.to_string())?;

    queue_outbox(
      conn,
      "routine",
      &input.id,
      "update_timer",
      &json!({
        "focusMinutes": input.focus_minutes,
        "breakMinutes": input.break_minutes
      }),
    )
    .map_err(|error| error.to_string())?;

    load_snapshot(conn).map_err(|error| error.to_string())
  })
}

fn sync_with_server(
  conn: &Connection,
  server_url: &str,
  sync_key: &str,
  device_id: &str,
) -> Result<AppSnapshot> {
  let client = build_http_client()?;
  let last_cursor = get_setting(conn, "server_cursor")?
    .unwrap_or_else(|| "0".into())
    .parse::<i64>()
    .unwrap_or(0);
  let outbox_rows = load_pending_outbox(conn)?;
  let changes = outbox_rows
    .iter()
    .map(|row| build_sync_event(conn, row))
    .collect::<Result<Vec<_>>>()?;

  let response = client
    .post(format!("{}/v1/sync", server_url.trim_end_matches('/')))
    .json(&SyncRequest {
      sync_key: sync_key.to_string(),
      device_id: device_id.to_string(),
      device_name: DEFAULT_DEVICE_NAME.to_string(),
      last_cursor,
      changes,
    })
    .send()
    .context("동기화 서버에 연결하지 못했습니다.")?
    .error_for_status()
    .context("동기화 서버가 요청을 처리하지 못했습니다.")?
    .json::<RemoteSyncResponse>()
    .context("동기화 응답을 읽지 못했습니다.")?;

  mark_outbox_synced(conn, &response.acked_event_ids)?;
  apply_remote_events(conn, &response.changes)?;
  set_setting(conn, "server_cursor", &response.server_cursor.to_string())?;
  set_setting(conn, "last_sync_at", &current_timestamp().to_string())?;

  load_snapshot(conn)
}

fn prepare_remote_sync(conn: &Connection, server_url: &str, sync_key: &str, device_id: &str) -> Result<()> {
  let had_cursor = get_setting(conn, "server_cursor")?.is_some();
  let client = build_http_client()?;
  let attach = attach_remote(&client, server_url, sync_key, device_id)?;

  if had_cursor {
    return Ok(());
  }

  set_setting(conn, "server_cursor", &attach.server_cursor.to_string())?;

  if attach.snapshot.routines.is_empty() && attach.snapshot.routine_checks.is_empty() {
    ensure_outbox_has_local_snapshot(conn)?;
  } else {
    replace_local_snapshot(conn, &attach.snapshot)?;
    clear_outbox(conn)?;
  }

  Ok(())
}

fn build_http_client() -> Result<Client> {
  Client::builder()
    .timeout(std::time::Duration::from_secs(8))
    .build()
    .context("동기화 클라이언트를 만들지 못했습니다.")
}

fn attach_remote(client: &Client, server_url: &str, sync_key: &str, device_id: &str) -> Result<RemoteAttachResponse> {
  client
    .post(format!("{}/v1/sync/attach", server_url.trim_end_matches('/')))
    .json(&AttachRequest {
      sync_key: sync_key.to_string(),
      device_id: device_id.to_string(),
      device_name: DEFAULT_DEVICE_NAME.to_string(),
    })
    .send()
    .context("동기화 서버에 연결하지 못했습니다.")?
    .error_for_status()
    .context("동기화 서버가 키 확인을 처리하지 못했습니다.")?
    .json::<RemoteAttachResponse>()
    .context("동기화 연결 응답을 읽지 못했습니다.")
}

fn regenerate_remote_key(client: &Client, server_url: &str, sync_key: &str, device_id: &str) -> Result<String> {
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  struct Request<'a> {
    sync_key: &'a str,
    device_id: &'a str,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Response {
    new_sync_key: String,
  }

  let response = client
    .post(format!(
      "{}/v1/sync/regenerate-key",
      server_url.trim_end_matches('/')
    ))
    .json(&Request { sync_key, device_id })
    .send()
    .context("동기화 서버에 연결하지 못했습니다.")?
    .error_for_status()
    .context("동기화 키 재생성 요청이 실패했습니다.")?
    .json::<Response>()
    .context("새 동기화 키 응답을 읽지 못했습니다.")?;

  Ok(response.new_sync_key)
}

fn load_pending_outbox(conn: &Connection) -> Result<Vec<OutboxRow>> {
  let mut statement = conn.prepare(
    "SELECT id, entity_type, entity_id, action, payload, created_at
     FROM sync_outbox
     WHERE sync_status = 'pending'
     ORDER BY created_at ASC, id ASC",
  )?;

  let rows = statement
    .query_map([], |row| {
      Ok(OutboxRow {
        id: row.get(0)?,
        entity_type: row.get(1)?,
        entity_id: row.get(2)?,
        action: row.get(3)?,
        payload: row.get(4)?,
        created_at: row.get(5)?,
      })
    })?
    .collect::<rusqlite::Result<Vec<_>>>()
    .context("대기 중 동기화 항목을 읽지 못했습니다.")?;

  Ok(rows)
}

fn build_sync_event(conn: &Connection, row: &OutboxRow) -> Result<SyncEventRequest> {
  match row.entity_type.as_str() {
    "routine" => {
      if row.action == "delete" {
        let payload = serde_json::from_str::<Value>(&row.payload).unwrap_or_else(|_| json!({}));
        let deleted_at = payload
          .get("deletedAt")
          .and_then(Value::as_i64)
          .unwrap_or(row.created_at);

        return Ok(SyncEventRequest {
          event_id: row.id.clone(),
          entity_type: row.entity_type.clone(),
          entity_id: row.entity_id.clone(),
          action: "delete".into(),
          payload: json!({ "deletedAt": deleted_at }),
          updated_at: timestamp_to_iso(deleted_at),
        });
      }

      let routine = load_local_routine_for_sync(conn, &row.entity_id)?;
      Ok(SyncEventRequest {
        event_id: row.id.clone(),
        entity_type: row.entity_type.clone(),
        entity_id: row.entity_id.clone(),
        action: if row.action == "create" { "create".into() } else { "update".into() },
        payload: json!({
          "title": routine.title,
          "frequency": routine.frequency,
          "weekdayMask": routine.weekday_mask,
          "reminder": routine.reminder,
          "accent": routine.accent,
          "focusMinutes": routine.focus_minutes,
          "breakMinutes": routine.break_minutes
        }),
        updated_at: timestamp_to_iso(routine.updated_at),
      })
    }
    "routine_check" => {
      let payload = serde_json::from_str::<Value>(&row.payload).context("체크 동기화 데이터를 읽지 못했습니다.")?;
      let date = payload
        .get("date")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("체크 날짜가 없습니다."))?
        .to_string();
      let completed = payload
        .get("completed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
      let updated_at = if completed {
        load_routine_check_updated_at(conn, &row.entity_id, &date)?.unwrap_or(row.created_at)
      } else {
        row.created_at
      };

      Ok(SyncEventRequest {
        event_id: row.id.clone(),
        entity_type: row.entity_type.clone(),
        entity_id: format!("{}:{}", row.entity_id, date),
        action: "toggle".into(),
        payload: json!({
          "routineId": row.entity_id,
          "date": date,
          "completed": completed
        }),
        updated_at: timestamp_to_iso(updated_at),
      })
    }
    other => Err(anyhow::anyhow!("지원하지 않는 동기화 항목입니다: {other}")),
  }
}

fn load_local_routine_for_sync(conn: &Connection, routine_id: &str) -> Result<LocalRoutineSyncPayload> {
  conn
    .query_row(
      "SELECT title, frequency, weekday_mask, reminder, accent, focus_minutes, break_minutes, updated_at, deleted_at
       FROM routines
       WHERE id = ?1",
      [routine_id],
      |row| {
        Ok(LocalRoutineSyncPayload {
          title: row.get(0)?,
          frequency: row.get(1)?,
          weekday_mask: row.get(2)?,
          reminder: row.get(3)?,
          accent: row.get(4)?,
          focus_minutes: row.get(5)?,
          break_minutes: row.get(6)?,
          updated_at: row.get(7)?,
        })
      },
    )
    .context("루틴 동기화 데이터를 읽지 못했습니다.")
}

fn load_routine_check_updated_at(conn: &Connection, routine_id: &str, date: &str) -> Result<Option<i64>> {
  conn
    .query_row(
      "SELECT updated_at FROM routine_checks WHERE routine_id = ?1 AND check_date = ?2",
      params![routine_id, date],
      |row| row.get::<_, i64>(0),
    )
    .optional()
    .context("체크 시각을 읽지 못했습니다.")
}

fn mark_outbox_synced(conn: &Connection, acked_event_ids: &[String]) -> Result<()> {
  for event_id in acked_event_ids {
    conn.execute("DELETE FROM sync_outbox WHERE id = ?1", [event_id])?;
  }

  Ok(())
}

fn apply_remote_events(conn: &Connection, events: &[RemoteSyncEvent]) -> Result<()> {
  for event in events {
    let updated_at = iso_to_timestamp(&event.updated_at);

    match event.entity_type.as_str() {
      "routine" => {
        if event.action == "delete" {
          conn.execute(
            "UPDATE routines
             SET is_active = 0,
                 deleted_at = ?2,
                 updated_at = ?2
             WHERE id = ?1
               AND COALESCE(updated_at, 0) <= ?2",
            params![event.entity_id, updated_at],
          )?;
          continue;
        }

        let payload = normalize_remote_routine_payload(&event.payload)?;
        let focus_minutes = event
          .payload
          .get("focusMinutes")
          .and_then(Value::as_i64)
          .unwrap_or(DEFAULT_FOCUS_MINUTES);
        let break_minutes = event
          .payload
          .get("breakMinutes")
          .and_then(Value::as_i64)
          .unwrap_or(DEFAULT_BREAK_MINUTES);
        conn.execute(
          "INSERT INTO routines (
             id, title, frequency, monthly_day, weekday_mask, reminder, focus_minutes, break_minutes,
             accent, is_active, created_at, updated_at, deleted_at
           ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, NULL)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             frequency = excluded.frequency,
             weekday_mask = excluded.weekday_mask,
             reminder = excluded.reminder,
             focus_minutes = excluded.focus_minutes,
             break_minutes = excluded.break_minutes,
             accent = excluded.accent,
             is_active = 1,
             updated_at = excluded.updated_at,
             deleted_at = NULL
           WHERE COALESCE(routines.updated_at, 0) <= excluded.updated_at",
          params![
            event.entity_id,
            payload.title,
            payload.frequency,
            payload.weekday_mask,
            payload.reminder,
            focus_minutes,
            break_minutes,
            payload.accent,
            updated_at
          ],
        )?;
      }
      "routine_check" => {
        let routine_id = event
          .payload
          .get("routineId")
          .and_then(Value::as_str)
          .or_else(|| event.entity_id.split(':').next())
          .unwrap_or_default();
        let date = event
          .payload
          .get("date")
          .and_then(Value::as_str)
          .or_else(|| event.entity_id.split(':').nth(1))
          .unwrap_or_default();
        let completed = event
          .payload
          .get("completed")
          .and_then(Value::as_bool)
          .unwrap_or(false);

        if routine_id.is_empty() || date.is_empty() {
          continue;
        }

        if completed {
          conn.execute(
            "INSERT INTO routine_checks (routine_id, check_date, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(routine_id, check_date) DO UPDATE SET updated_at = excluded.updated_at
             WHERE COALESCE(routine_checks.updated_at, 0) <= excluded.updated_at",
            params![routine_id, date, updated_at],
          )?;
        } else {
          conn.execute(
            "DELETE FROM routine_checks
             WHERE routine_id = ?1
               AND check_date = ?2
               AND COALESCE(updated_at, 0) <= ?3",
            params![routine_id, date, updated_at],
          )?;
        }
      }
      _ => {}
    }
  }

  Ok(())
}

fn normalize_remote_routine_payload(payload: &Value) -> Result<RoutineInput> {
  sanitize_routine_input(RoutineInput {
    title: payload.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
    frequency: payload
      .get("frequency")
      .and_then(Value::as_str)
      .unwrap_or("Daily")
      .to_string(),
    weekday_mask: payload
      .get("weekdayMask")
      .and_then(Value::as_str)
      .unwrap_or("1111111")
      .to_string(),
    reminder: payload
      .get("reminder")
      .and_then(Value::as_str)
      .unwrap_or("09:00")
      .to_string(),
    accent: payload
      .get("accent")
      .and_then(Value::as_str)
      .unwrap_or("#ff8b3d")
      .to_string(),
  })
  .map(|input| RoutineInput {
    title: input.title,
    frequency: input.frequency,
    weekday_mask: input.weekday_mask,
    reminder: input.reminder,
    accent: input.accent,
  })
  .map_err(anyhow::Error::msg)
}

fn replace_local_snapshot(conn: &Connection, snapshot: &RemoteSnapshot) -> Result<()> {
  conn.execute("DELETE FROM routine_checks", [])?;
  conn.execute("DELETE FROM routines", [])?;

  for routine in &snapshot.routines {
    if routine.deleted_at.is_some() {
      continue;
    }

    conn.execute(
      "INSERT INTO routines (
         id, title, frequency, monthly_day, weekday_mask, reminder, focus_minutes, break_minutes,
         accent, is_active, created_at, updated_at, deleted_at
       ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, NULL)",
      params![
        routine.id,
        routine.title,
        routine.frequency,
        routine.weekday_mask,
        routine.reminder,
        routine.focus_minutes,
        routine.break_minutes,
        routine.accent,
        iso_to_timestamp(&routine.updated_at)
      ],
    )?;
  }

  for check in &snapshot.routine_checks {
    if !check.completed {
      continue;
    }

    conn.execute(
      "INSERT INTO routine_checks (routine_id, check_date, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(routine_id, check_date) DO UPDATE SET updated_at = excluded.updated_at",
      params![check.routine_id, check.date, iso_to_timestamp(&check.updated_at)],
    )?;
  }

  Ok(())
}

fn clear_outbox(conn: &Connection) -> Result<()> {
  conn.execute("DELETE FROM sync_outbox", [])?;
  Ok(())
}

fn ensure_outbox_has_local_snapshot(conn: &Connection) -> Result<()> {
  let pending_count = conn.query_row(
    "SELECT COUNT(*) FROM sync_outbox WHERE sync_status = 'pending'",
    [],
    |row| row.get::<_, i64>(0),
  )?;

  if pending_count > 0 {
    return Ok(());
  }

  let mut routine_statement = conn.prepare(
    "SELECT id, title, frequency, weekday_mask, reminder, accent, focus_minutes, break_minutes
     FROM routines
     WHERE deleted_at IS NULL
     ORDER BY created_at ASC",
  )?;

  let routines = routine_statement.query_map([], |row| {
    Ok((
      row.get::<_, String>(0)?,
      RoutineInput {
        title: row.get(1)?,
        frequency: row.get(2)?,
        weekday_mask: row.get(3)?,
        reminder: row.get(4)?,
        accent: row.get(5)?,
      },
      row.get::<_, i64>(6)?,
      row.get::<_, i64>(7)?,
    ))
  })?;

  for routine in routines {
    let (id, payload, focus_minutes, break_minutes) = routine?;
    let action_payload = json!({
      "title": payload.title,
      "frequency": payload.frequency,
      "weekdayMask": payload.weekday_mask,
      "reminder": payload.reminder,
      "accent": payload.accent,
      "focusMinutes": focus_minutes,
      "breakMinutes": break_minutes
    });
    queue_outbox(conn, "routine", &id, "create", &action_payload)?;
  }

  let mut check_statement = conn.prepare(
    "SELECT routine_id, check_date
     FROM routine_checks
     ORDER BY updated_at ASC",
  )?;

  let checks = check_statement.query_map([], |row| {
    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
  })?;

  for check in checks {
    let (routine_id, date) = check?;
    queue_outbox(
      conn,
      "routine_check",
      &routine_id,
      "toggle",
      &json!({ "date": date, "completed": true }),
    )?;
  }

  Ok(())
}

fn open_connection(db_path: &Path) -> Result<Connection> {
  let conn = Connection::open(db_path).context("failed to open local sqlite database")?;
  conn
    .busy_timeout(std::time::Duration::from_secs(5))
    .context("failed to set sqlite busy timeout")?;
  conn
    .pragma_update(None, "journal_mode", "WAL")
    .context("failed to enable sqlite wal mode")?;
  conn
    .pragma_update(None, "synchronous", "NORMAL")
    .context("failed to tune sqlite synchronous mode")?;
  conn
    .pragma_update(None, "foreign_keys", "ON")
    .context("failed to enable foreign keys")?;
  Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );",
  )?;

  let migrations = [
    ("001_initial", include_str!("../migrations/001_initial.sql")),
    ("002_weekday_rules", include_str!("../migrations/002_weekday_rules.sql")),
  ];

  for (id, sql) in migrations {
    let already_applied = conn
      .query_row(
        "SELECT 1 FROM schema_migrations WHERE id = ?1",
        [id],
        |_| Ok(true),
      )
      .optional()?
      .unwrap_or(false);

    if already_applied {
      continue;
    }

    if id == "002_weekday_rules" && !column_exists(conn, "routines", "weekday_mask")? {
      conn.execute("ALTER TABLE routines ADD COLUMN weekday_mask TEXT", [])?;
    }

    conn.execute_batch(sql)?;
    conn.execute(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)",
      params![id, current_timestamp()],
    )?;
  }

  Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
  let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
  let columns = statement.query_map([], |row| row.get::<_, String>(1))?;

  for existing in columns {
    if existing? == column {
      return Ok(true);
    }
  }

  Ok(false)
}

fn load_snapshot(conn: &Connection) -> Result<AppSnapshot> {
  let mut routines_stmt = conn.prepare(
    "SELECT id, title, frequency, weekday_mask, reminder, focus_minutes, break_minutes, accent
     FROM routines
     WHERE is_active = 1 AND deleted_at IS NULL
     ORDER BY created_at ASC, title ASC",
  )?;

  let routine_rows = routines_stmt.query_map([], |row| {
    Ok(RoutineRecord {
      id: row.get(0)?,
      title: row.get(1)?,
      frequency: row.get(2)?,
      weekday_mask: row.get(3)?,
      reminder: row.get(4)?,
      focus_minutes: row.get(5)?,
      break_minutes: row.get(6)?,
      accent: row.get(7)?,
      completed_dates: Vec::new(),
    })
  })?;

  let mut routines = routine_rows.collect::<rusqlite::Result<Vec<_>>>()?;
  let routine_indexes = routines
    .iter()
    .enumerate()
    .map(|(index, routine)| (routine.id.clone(), index))
    .collect::<HashMap<_, _>>();

  if !routine_indexes.is_empty() {
    let mut checks_stmt = conn.prepare(
      "SELECT routine_checks.routine_id, routine_checks.check_date
       FROM routine_checks
       INNER JOIN routines ON routines.id = routine_checks.routine_id
       WHERE routines.is_active = 1 AND routines.deleted_at IS NULL
       ORDER BY routine_checks.routine_id ASC, routine_checks.check_date ASC",
    )?;

    let check_rows = checks_stmt.query_map([], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for check in check_rows {
      let (routine_id, check_date) = check?;
      if let Some(index) = routine_indexes.get(&routine_id) {
        routines[*index].completed_dates.push(check_date);
      }
    }
  }

  let has_sync_key = get_setting(conn, "sync_key")?.is_some();
  let sound_enabled = get_setting(conn, "sound_enabled")?
    .map(|value| value == "true")
    .unwrap_or(false);
  let sync_server_url = get_sync_server_url(conn)?;
  let last_sync_at = get_setting(conn, "last_sync_at")?.map(|value| timestamp_to_display(&value));
  let outbox_count = conn.query_row(
    "SELECT COUNT(*) FROM sync_outbox WHERE sync_status = 'pending'",
    [],
    |row| row.get::<_, i64>(0),
  )?;

  Ok(AppSnapshot {
    has_sync_key,
    sound_enabled,
    outbox_count,
    sync_server_url,
    last_sync_at,
    routines,
  })
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
  conn
    .query_row(
      "SELECT value FROM settings WHERE key = ?1",
      [key],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .context("failed to read setting")
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
  conn
    .execute(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      params![key, value, current_timestamp()],
    )
    .context("failed to write setting")?;
  Ok(())
}

fn get_sync_server_url(conn: &Connection) -> Result<String> {
  let existing = get_setting(conn, "sync_server_url")?.unwrap_or_else(|| DEFAULT_SYNC_SERVER_URL.to_string());
  normalize_server_url(&existing).map_err(anyhow::Error::msg)
}

fn get_or_create_device_id(conn: &Connection) -> Result<String> {
  if let Some(existing) = get_setting(conn, "device_id")? {
    return Ok(existing);
  }

  let device_id = Uuid::new_v4().to_string();
  set_setting(conn, "device_id", &device_id)?;
  Ok(device_id)
}

fn queue_outbox<T: Serialize>(
  conn: &Connection,
  entity_type: &str,
  entity_id: &str,
  action: &str,
  payload: &T,
) -> Result<()> {
  let id = Uuid::new_v4().to_string();
  let payload_json = serde_json::to_string(payload).context("failed to serialize outbox payload")?;
  conn
    .execute(
      "INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at, sync_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
      params![id, entity_type, entity_id, action, payload_json, current_timestamp()],
    )
    .context("failed to enqueue outbox event")?;
  Ok(())
}

fn sanitize_routine_input(input: RoutineInput) -> Result<RoutineInput, String> {
  if input.title.trim().is_empty() {
    return Err("루틴 이름을 입력하세요.".into());
  }

  let normalized_frequency = match input.frequency.as_str() {
    "Daily" | "Weekdays" | "Weekends" | "CustomDays" => input.frequency,
    _ => return Err("반복 규칙을 다시 확인하세요.".into()),
  };

  let reminder = input.reminder.trim().to_string();
  if !reminder.is_empty() {
    let bytes = reminder.as_bytes();
    let valid = bytes.len() == 5
      && bytes[2] == b':'
      && bytes[0].is_ascii_digit()
      && bytes[1].is_ascii_digit()
      && bytes[3].is_ascii_digit()
      && bytes[4].is_ascii_digit();

    if !valid {
      return Err("알림 시간 형식을 다시 확인하세요.".into());
    }
  }

  let weekday_mask = match normalized_frequency.as_str() {
    "Daily" => "1111111".to_string(),
    "Weekdays" => "0111110".to_string(),
    "Weekends" => "1000001".to_string(),
    "CustomDays" => {
      let trimmed = input.weekday_mask.trim().to_string();
      if trimmed.len() != 7 || !trimmed.chars().all(|value| value == '0' || value == '1') {
        return Err("요일 지정 값이 올바르지 않습니다.".into());
      }

      if !trimmed.contains('1') {
        return Err("요일 지정을 선택했다면 최소 하루는 골라야 합니다.".into());
      }

      trimmed
    }
    _ => unreachable!(),
  };

  Ok(RoutineInput {
    title: input.title.trim().to_string(),
    frequency: normalized_frequency,
    weekday_mask,
    reminder,
    accent: if input.accent.trim().is_empty() {
      "#ff8b3d".into()
    } else {
      input.accent
    },
  })
}

fn seed_routines_if_needed(conn: &Connection) -> Result<()> {
  let count = conn.query_row(
    "SELECT COUNT(*) FROM routines WHERE deleted_at IS NULL",
    [],
    |row| row.get::<_, i64>(0),
  )?;

  if count > 0 {
    return Ok(());
  }

  let now = current_timestamp();
  for routine in [
    RoutineInput {
      title: "아침 계획".into(),
      frequency: "Weekdays".into(),
      weekday_mask: "0111110".into(),
      reminder: "09:10".into(),
      accent: "#f97316".into(),
    },
    RoutineInput {
      title: "스트레칭".into(),
      frequency: "Daily".into(),
      weekday_mask: "1111111".into(),
      reminder: "14:00".into(),
      accent: "#2dd4bf".into(),
    },
    RoutineInput {
      title: "받은 편지함 정리".into(),
      frequency: "CustomDays".into(),
      weekday_mask: "0101010".into(),
      reminder: "17:30".into(),
      accent: "#facc15".into(),
    },
    RoutineInput {
      title: "주말 회고".into(),
      frequency: "Weekends".into(),
      weekday_mask: "1000001".into(),
      reminder: "18:20".into(),
      accent: "#38bdf8".into(),
    },
  ] {
    let routine_payload = json!({
      "title": routine.title.clone(),
      "frequency": routine.frequency.clone(),
      "weekdayMask": routine.weekday_mask.clone(),
      "reminder": routine.reminder.clone(),
      "accent": routine.accent.clone(),
      "focusMinutes": DEFAULT_FOCUS_MINUTES,
      "breakMinutes": DEFAULT_BREAK_MINUTES
    });
    let id = Uuid::new_v4().to_string();
    conn.execute(
      "INSERT INTO routines (
        id, title, frequency, monthly_day, weekday_mask, reminder, focus_minutes, break_minutes,
        accent, is_active, created_at, updated_at, deleted_at
      ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, NULL)",
      params![
        id,
        routine.title,
        routine.frequency,
        routine.weekday_mask,
        routine.reminder,
        DEFAULT_FOCUS_MINUTES,
        DEFAULT_BREAK_MINUTES,
        routine.accent,
        now
      ],
    )?;

    queue_outbox(conn, "routine", &id, "create", &routine_payload)?;
  }

  Ok(())
}

fn generate_sync_key() -> String {
  let token = Uuid::new_v4().simple().to_string().to_uppercase();
  format!("RT-{}-{}-{}", &token[0..4], &token[4..8], &token[8..12])
}

fn current_timestamp() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs() as i64)
    .unwrap_or(0)
}

fn timestamp_to_iso(timestamp: i64) -> String {
  let seconds = if timestamp > 10_000_000_000 {
    timestamp / 1000
  } else {
    timestamp
  };
  format_rfc3339(seconds)
}

fn iso_to_timestamp(value: &str) -> i64 {
  if let Ok(parsed) = value.parse::<i64>() {
    return parsed;
  }

  match time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339) {
    Ok(parsed) => parsed.unix_timestamp(),
    Err(_) => current_timestamp(),
  }
}

fn timestamp_to_display(value: &str) -> String {
  let timestamp = value.parse::<i64>().unwrap_or_else(|_| iso_to_timestamp(value));
  let datetime = time::OffsetDateTime::from_unix_timestamp(timestamp)
    .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
    .to_offset(
      time::UtcOffset::from_hms(9, 0, 0).unwrap_or(time::UtcOffset::UTC),
    );

  datetime
    .format(
      &time::format_description::parse("[year]-[month]-[day] [hour]:[minute]").unwrap(),
    )
    .unwrap_or_else(|_| value.to_string())
}

fn format_rfc3339(seconds: i64) -> String {
  let datetime = time::OffsetDateTime::from_unix_timestamp(seconds)
    .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
  datetime
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn normalize_server_url(input: &str) -> Result<String, String> {
  let trimmed = input.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return Err("동기화 서버 주소를 입력하세요.".into());
  }

  if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
    return Err("동기화 서버 주소는 http:// 또는 https://로 시작해야 합니다.".into());
  }

  Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{env, fs};

  struct TestDb {
    path: PathBuf,
  }

  impl TestDb {
    fn new() -> Self {
      let path = env::temp_dir().join(format!("daily-check-test-{}.sqlite3", Uuid::new_v4()));
      Self { path }
    }

    fn connection(&self) -> Result<Connection> {
      init_database(&self.path)?;
      open_connection(&self.path)
    }
  }

  impl Drop for TestDb {
    fn drop(&mut self) {
      let _ = fs::remove_file(&self.path);
    }
  }

  #[test]
  fn offline_crud_updates_local_snapshot_and_outbox() {
    let db = TestDb::new();
    let conn = db.connection().expect("db init");
    reset_local_test_state(&conn).expect("reset local state");

    let routine_id = "offline-routine";
    insert_routine_event(&conn, routine_id, "오프라인 생성", 1_710_000_001).expect("create routine");
    update_routine_title_event(&conn, routine_id, "오프라인 수정", 1_710_000_002).expect("update routine");
    toggle_check_event(&conn, routine_id, "2026-03-30", true, 1_710_000_003).expect("toggle on");

    let snapshot = load_snapshot(&conn).expect("load snapshot after offline changes");
    assert_eq!(snapshot.routines.len(), 1);
    assert_eq!(snapshot.routines[0].title, "오프라인 수정");
    assert_eq!(snapshot.routines[0].completed_dates, vec!["2026-03-30".to_string()]);
    assert_eq!(pending_outbox_count(&conn), 3);

    delete_routine_event(&conn, routine_id, 1_710_000_004).expect("delete routine");

    let deleted_snapshot = load_snapshot(&conn).expect("load snapshot after delete");
    assert!(deleted_snapshot.routines.is_empty());
    assert_eq!(pending_outbox_count(&conn), 4);
  }

  #[test]
  fn online_sync_replays_crud_between_two_devices() {
    let Some(server_url) = sync_test_server_url() else {
      eprintln!("SYNC_TEST_SERVER_URL not set; skipping online sync test");
      return;
    };

    let sync_key = format!("VERIFY-CRUD-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let db_a = TestDb::new();
    let conn_a = db_a.connection().expect("db a init");
    reset_local_test_state(&conn_a).expect("reset db a");
    set_setting(&conn_a, "sync_server_url", &server_url).expect("set db a server url");

    let db_b = TestDb::new();
    let conn_b = db_b.connection().expect("db b init");
    reset_local_test_state(&conn_b).expect("reset db b");
    set_setting(&conn_b, "sync_server_url", &server_url).expect("set db b server url");

    insert_routine_event(&conn_a, "shared-routine", "기기 간 루틴", 1_710_000_101).expect("device a create");
    connect_new_device(&conn_a, &server_url, &sync_key).expect("device a initial sync");
    assert_eq!(pending_outbox_count(&conn_a), 0);

    let snapshot_b = connect_new_device(&conn_b, &server_url, &sync_key).expect("device b initial pull");
    assert_eq!(snapshot_b.routines.len(), 1);
    assert_eq!(snapshot_b.routines[0].title, "기기 간 루틴");

    update_routine_title_event(&conn_b, "shared-routine", "기기 B 수정", 1_710_000_102).expect("device b update");
    let snapshot_b_synced = sync_existing_device(&conn_b, &sync_key).expect("device b sync update");
    assert_eq!(snapshot_b_synced.routines[0].title, "기기 B 수정");

    let snapshot_a_after_update = sync_existing_device(&conn_a, &sync_key).expect("device a pull update");
    assert_eq!(snapshot_a_after_update.routines[0].title, "기기 B 수정");

    toggle_check_event(&conn_a, "shared-routine", "2026-03-31", true, 1_710_000_103).expect("device a check");
    sync_existing_device(&conn_a, &sync_key).expect("device a sync check");
    let snapshot_b_after_check = sync_existing_device(&conn_b, &sync_key).expect("device b pull check");
    assert_eq!(snapshot_b_after_check.routines[0].completed_dates, vec!["2026-03-31".to_string()]);

    delete_routine_event(&conn_b, "shared-routine", 1_710_000_104).expect("device b delete");
    sync_existing_device(&conn_b, &sync_key).expect("device b sync delete");
    let snapshot_a_after_delete = sync_existing_device(&conn_a, &sync_key).expect("device a pull delete");
    assert!(snapshot_a_after_delete.routines.is_empty());
  }

  #[test]
  fn stale_remote_event_does_not_override_newer_state() {
    let Some(server_url) = sync_test_server_url() else {
      eprintln!("SYNC_TEST_SERVER_URL not set; skipping concurrency test");
      return;
    };

    let sync_key = format!("VERIFY-CONFLICT-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let db_a = TestDb::new();
    let conn_a = db_a.connection().expect("db a init");
    reset_local_test_state(&conn_a).expect("reset db a");
    set_setting(&conn_a, "sync_server_url", &server_url).expect("set db a server url");

    let db_b = TestDb::new();
    let conn_b = db_b.connection().expect("db b init");
    reset_local_test_state(&conn_b).expect("reset db b");
    set_setting(&conn_b, "sync_server_url", &server_url).expect("set db b server url");

    insert_routine_event(&conn_a, "conflict-routine", "초기 루틴", 1_710_000_201).expect("seed conflict routine");
    connect_new_device(&conn_a, &server_url, &sync_key).expect("device a initial sync");
    connect_new_device(&conn_b, &server_url, &sync_key).expect("device b initial pull");

    update_routine_title_event(&conn_b, "conflict-routine", "더 최신 값", 1_710_000_300).expect("device b newer update");
    sync_existing_device(&conn_b, &sync_key).expect("device b sync newer update");

    update_routine_title_event(&conn_a, "conflict-routine", "오래된 값", 1_710_000_250).expect("device a stale update");
    let snapshot_a = sync_existing_device(&conn_a, &sync_key).expect("device a sync stale update");
    assert_eq!(find_routine_title(&snapshot_a, "conflict-routine"), Some("더 최신 값"));

    let snapshot_b = sync_existing_device(&conn_b, &sync_key).expect("device b final sync");
    assert_eq!(find_routine_title(&snapshot_b, "conflict-routine"), Some("더 최신 값"));
    assert_eq!(pending_outbox_count(&conn_a), 0);
    assert_eq!(pending_outbox_count(&conn_b), 0);
  }

  fn sync_test_server_url() -> Option<String> {
    env::var("SYNC_TEST_SERVER_URL").ok().and_then(|value| {
      let trimmed = value.trim().trim_end_matches('/').to_string();
      if trimmed.is_empty() {
        None
      } else {
        Some(trimmed)
      }
    })
  }

  fn reset_local_test_state(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM routine_checks", [])?;
    conn.execute("DELETE FROM sync_outbox", [])?;
    conn.execute("DELETE FROM routines", [])?;
    conn.execute(
      "DELETE FROM settings WHERE key IN ('sync_key', 'server_cursor', 'last_sync_at')",
      [],
    )?;
    Ok(())
  }

  fn connect_new_device(conn: &Connection, server_url: &str, sync_key: &str) -> Result<AppSnapshot> {
    let device_id = get_or_create_device_id(conn)?;
    let client = build_http_client()?;
    let attach = attach_remote(&client, server_url, sync_key, &device_id)?;
    set_setting(conn, "sync_key", sync_key)?;
    set_setting(conn, "server_cursor", &attach.server_cursor.to_string())?;

    if attach.snapshot.routines.is_empty() && attach.snapshot.routine_checks.is_empty() {
      ensure_outbox_has_local_snapshot(conn)?;
    } else {
      replace_local_snapshot(conn, &attach.snapshot)?;
      clear_outbox(conn)?;
    }

    sync_with_server(conn, server_url, sync_key, &device_id)
  }

  fn sync_existing_device(conn: &Connection, sync_key: &str) -> Result<AppSnapshot> {
    let server_url = get_sync_server_url(conn)?;
    let device_id = get_or_create_device_id(conn)?;
    sync_with_server(conn, &server_url, sync_key, &device_id)
  }

  fn insert_routine_event(conn: &Connection, id: &str, title: &str, updated_at: i64) -> Result<()> {
    let payload = sanitize_routine_input(RoutineInput {
      title: title.to_string(),
      frequency: "Weekdays".to_string(),
      weekday_mask: "0111110".to_string(),
      reminder: "09:00".to_string(),
      accent: "#f97316".to_string(),
    })
    .map_err(anyhow::Error::msg)?;

    conn.execute(
      "INSERT INTO routines (
         id, title, frequency, monthly_day, weekday_mask, reminder, focus_minutes, break_minutes,
         accent, is_active, created_at, updated_at, deleted_at
       ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, NULL)",
      params![
        id,
        payload.title,
        payload.frequency,
        payload.weekday_mask,
        payload.reminder,
        DEFAULT_FOCUS_MINUTES,
        DEFAULT_BREAK_MINUTES,
        payload.accent,
        updated_at
      ],
    )?;

    insert_outbox_row(
      conn,
      "routine",
      id,
      "create",
      &json!({
        "title": title,
        "frequency": "Weekdays",
        "weekdayMask": "0111110",
        "reminder": "09:00",
        "accent": "#f97316",
        "focusMinutes": DEFAULT_FOCUS_MINUTES,
        "breakMinutes": DEFAULT_BREAK_MINUTES
      }),
      updated_at,
    )
  }

  fn update_routine_title_event(conn: &Connection, id: &str, title: &str, updated_at: i64) -> Result<()> {
    let (frequency, weekday_mask, reminder, accent, focus_minutes, break_minutes) = conn.query_row(
      "SELECT frequency, weekday_mask, reminder, accent, focus_minutes, break_minutes
       FROM routines
       WHERE id = ?1",
      [id],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, String>(3)?,
          row.get::<_, i64>(4)?,
          row.get::<_, i64>(5)?,
        ))
      },
    )?;

    conn.execute(
      "UPDATE routines
       SET title = ?2,
           updated_at = ?3
       WHERE id = ?1",
      params![id, title, updated_at],
    )?;

    insert_outbox_row(
      conn,
      "routine",
      id,
      "update",
      &json!({
        "title": title,
        "frequency": frequency,
        "weekdayMask": weekday_mask,
        "reminder": reminder,
        "accent": accent,
        "focusMinutes": focus_minutes,
        "breakMinutes": break_minutes
      }),
      updated_at,
    )
  }

  fn toggle_check_event(
    conn: &Connection,
    routine_id: &str,
    date: &str,
    completed: bool,
    updated_at: i64,
  ) -> Result<()> {
    if completed {
      conn.execute(
        "INSERT INTO routine_checks (routine_id, check_date, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(routine_id, check_date) DO UPDATE SET updated_at = excluded.updated_at",
        params![routine_id, date, updated_at],
      )?;
    } else {
      conn.execute(
        "DELETE FROM routine_checks WHERE routine_id = ?1 AND check_date = ?2",
        params![routine_id, date],
      )?;
    }

    insert_outbox_row(
      conn,
      "routine_check",
      routine_id,
      "toggle",
      &json!({
        "date": date,
        "completed": completed
      }),
      updated_at,
    )
  }

  fn delete_routine_event(conn: &Connection, id: &str, updated_at: i64) -> Result<()> {
    conn.execute(
      "UPDATE routines
       SET is_active = 0,
           deleted_at = ?2,
           updated_at = ?2
       WHERE id = ?1",
      params![id, updated_at],
    )?;

    insert_outbox_row(
      conn,
      "routine",
      id,
      "delete",
      &json!({ "deletedAt": updated_at }),
      updated_at,
    )
  }

  fn insert_outbox_row(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload: &Value,
    created_at: i64,
  ) -> Result<()> {
    conn.execute(
      "INSERT INTO sync_outbox (id, entity_type, entity_id, action, payload, created_at, sync_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
      params![
        Uuid::new_v4().to_string(),
        entity_type,
        entity_id,
        action,
        serde_json::to_string(payload)?,
        created_at
      ],
    )?;

    Ok(())
  }

  fn pending_outbox_count(conn: &Connection) -> i64 {
    conn
      .query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE sync_status = 'pending'",
        [],
        |row| row.get::<_, i64>(0),
      )
      .expect("count pending outbox")
  }

  fn find_routine_title<'a>(snapshot: &'a AppSnapshot, routine_id: &str) -> Option<&'a str> {
    snapshot
      .routines
      .iter()
      .find(|routine| routine.id == routine_id)
      .map(|routine| routine.title.as_str())
  }
}
