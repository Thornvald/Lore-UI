mod lore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            lore::lore_status,
            lore::lore_stage,
            lore::lore_commit,
            lore::lore_push,
            lore::lore_sync,
            lore::lore_branches,
            lore::lore_switch_branch,
            lore::lore_create_branch,
            lore::lore_diff,
            lore::lore_merge_branch,
            lore::lore_create_repo,
            lore::lore_history,
            lore::lore_discard,
            lore::lore_commit_files,
            lore::lore_commit_file_diff,
            lore::lore_revert_commit,
            lore::lore_undo_commit,
            lore::lore_run,
            lore::lore_set_globals,
            lore::lore_server_status,
            lore::lore_start_server,
            lore::lore_stop_server,
            lore::lore_is_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
