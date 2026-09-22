use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "desktop-settings.json";
const LAST_PROJECT_KEY: &str = "lastProject";

#[tauri::command]
pub fn get_remembered_project(app: AppHandle) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(LAST_PROJECT_KEY)?.as_str().map(|s| s.to_string())
}

#[tauri::command]
pub async fn choose_project_folder(app: AppHandle) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder()?;
    let path = folder.to_string();

    if let Ok(store) = app.store(STORE_FILE) {
        store.set(LAST_PROJECT_KEY, serde_json::json!(path));
        let _ = store.save();
    }

    Some(path)
}

#[tauri::command]
pub async fn start_project(app: AppHandle, folder: String) -> Result<(), String> {
    crate::sidecar::start(app, folder).await
}
