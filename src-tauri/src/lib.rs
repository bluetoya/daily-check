mod db;

use db::{
    bootstrap_app, create_routine, delete_routine, regenerate_sync_key, sync_now,
    toggle_routine_check, unlock_app, update_routine, update_routine_progress,
    update_routine_timer, update_sync_server_url, AppState,
};
use tauri::Manager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[allow(dead_code)]
fn show_main_window(_: &tauri::AppHandle) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "앱 열기", true, None::<&str>)?;
    let today = MenuItem::with_id(app, "today", "오늘 화면으로 이동", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &today, &quit])?;

    TrayIconBuilder::with_id("daily-check-tray")
        .menu(&menu)
        .title("Daily Check")
        .tooltip("Daily Check")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open" | "today" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let mut db_path = app.path().app_data_dir()?;
            db_path.push("daily-check.sqlite3");
            db::init_database(&db_path)?;
            app.manage(AppState { db_path });

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let menu = tauri::menu::Menu::default(app.handle())?;
                app.set_menu(menu)?;
                build_tray(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            unlock_app,
            regenerate_sync_key,
            update_sync_server_url,
            sync_now,
            create_routine,
            update_routine,
            delete_routine,
            toggle_routine_check,
            update_routine_progress,
            update_routine_timer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
