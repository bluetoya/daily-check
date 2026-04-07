mod db;

use db::{
    bootstrap_app, create_routine, delete_routine, export_backup, import_backup,
    regenerate_sync_key, sync_now, toggle_routine_check, unlock_app, update_routine, update_routine_progress,
    update_routine_timer, update_sync_server_url, AppState,
};
use tauri::{image::Image, Manager};
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

    let mut tray_builder = TrayIconBuilder::with_id("daily-check-tray")
        .menu(&menu)
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
        });

    let tray_icon = build_tray_icon();
    tray_builder = tray_builder.icon(tray_icon).icon_as_template(false);

    tray_builder.build(app)?;

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_tray_icon() -> Image<'static> {
    const WIDTH: usize = 20;
    const HEIGHT: usize = 20;
    let mut rgba = vec![0u8; WIDTH * HEIGHT * 4];

    let set_pixel = |buffer: &mut [u8], x: usize, y: usize, color: [u8; 4]| {
        let index = (y * WIDTH + x) * 4;
        buffer[index..index + 4].copy_from_slice(&color);
    };

    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let mut color = [0, 0, 0, 0];
            let dx = x as f32 - 8.5;
            let dy = y as f32 - 10.5;

            if (dx * dx) / 30.0 + (dy * dy) / 24.0 <= 1.0
                && (4..=13).contains(&x)
                && (6..=14).contains(&y)
            {
                color = [245, 248, 255, 255];
            }

            if (6..=11).contains(&x) && (8..=10).contains(&y) {
                color = [103, 227, 255, 255];
            }

            if (7..=10).contains(&x) && (15..=16).contains(&y) {
                color = [245, 248, 255, 255];
            }

            if matches!((x, y), (4, 6) | (13, 6) | (4, 14) | (13, 14)) {
                color = [0, 0, 0, 0];
            }

            if matches!(
                (x, y),
                (15, 4)
                    | (14, 5)
                    | (15, 5)
                    | (16, 5)
                    | (15, 6)
                    | (14, 7)
                    | (15, 7)
                    | (16, 7)
                    | (15, 8)
            ) {
                color = [255, 187, 92, 255];
            }

            if color[3] > 0 {
                set_pixel(&mut rgba, x, y, color);
            }
        }
    }

    Image::new_owned(rgba, WIDTH as u32, HEIGHT as u32)
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
            export_backup,
            import_backup,
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
