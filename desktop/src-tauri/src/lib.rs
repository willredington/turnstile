#[cfg(target_os = "macos")]
mod escape;
mod project;
mod sidecar;
mod state;

use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem};
use tauri::{Emitter, Manager, Url};

/// The window's URL as it was right after startup, before `main.js`'s
/// `window.location.replace(...)` ever has a chance to navigate it to a running sidecar's own
/// served UI. Captured once in `.setup()`. Used by the "open-folder" menu handler below to tell
/// whether the window is still showing the local shell page (loading/error screen) or has since
/// navigated away to a project's board.
static APP_URL: OnceLock<Url> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(state::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            project::get_remembered_project,
            project::choose_project_folder,
            project::start_project
        ])
        .setup(|app| {
            // Building the menu bar from scratch (a bare App submenu + a bare File submenu)
            // meant there was no Edit or Window submenu at all — copy/paste/cut/select-all/undo
            // had no key equivalent registered anywhere and silently didn't work in the webview.
            // `Menu::default` is Tauri's standard cross-platform template: on macOS it already
            // gives us App (with Quit), File (with Close Window), Edit (undo/redo/cut/copy/
            // paste/select-all), View, Window (minimize/close) and Help, each wired to its
            // standard key equivalent (Cmd+Q, Cmd+W, Cmd+Z, Cmd+X/C/V/A, Cmd+M, ...). Start from
            // that template and layer "Open Folder…" onto its existing File submenu instead of
            // composing the whole bar by hand — this is what keeps the Quit item (Cmd+Q) working
            // exactly as before, now for free via the template rather than a hand-built item.
            let menu = Menu::default(app.handle())?;

            let open_folder =
                MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("Cmd+O"))?;

            let file_menu = menu.items()?.into_iter().find_map(|item| {
                let submenu = item.as_submenu()?.clone();
                (submenu.text().ok()? == "File").then_some(submenu)
            });
            if let Some(file_menu) = file_menu {
                file_menu.prepend(&open_folder)?;
            }

            app.set_menu(menu)?;

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    let _ = APP_URL.set(url);
                }
                #[cfg(target_os = "macos")]
                escape::deliver_escape_in_fullscreen(window.clone());
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() != "open-folder" {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };

            // main.js's `listen('menu-open-folder', ...)` only exists on the local shell page
            // (index.html + main.js). Once `sidecar-ready` fires, that page's own
            // `window.location.replace(url)` navigates the window to the sidecar's served UI —
            // a completely different document — which unloads main.js and, with it, that
            // listener. A plain `emit` at that point reaches nobody. So: if we're still on the
            // local shell page, emit as normal and let the existing listener reuse
            // `chooseAndLaunch()`. If we've already navigated to a project's board, bring the
            // window back to the local shell page first (with a marker query param), so
            // main.js reloads fresh, re-registers its listeners, and — per the check added to
            // `main()` — opens the folder picker immediately instead of relaunching the
            // remembered project. Without this branch "Open Folder…" would silently do nothing
            // once a project was already loaded, which is the main scenario this menu item
            // exists for.
            let is_on_local_shell = match (window.url().ok(), APP_URL.get()) {
                (Some(mut current), Some(base)) => {
                    current.set_query(None);
                    &current == base
                }
                _ => false,
            };

            if is_on_local_shell {
                let _ = app.emit("menu-open-folder", ());
            } else if let Some(base) = APP_URL.get() {
                let mut url = base.clone();
                url.set_query(Some("openFolder=1"));
                let _ = window.navigate(url);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Every way the app exits — closing the last window, or macOS's Cmd+Q, which
            // bypasses the window-close flow and only ever emits this — takes the sidecar with
            // it. `kill_current()` is idempotent (a no-op once the child is already cleared).
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<state::SidecarState>().kill_current();
            }
        });
}
