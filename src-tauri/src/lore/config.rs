// Repo identity / remote URL read+write from `.lore/config.toml`, plus the
// "reveal in Explorer" file-browser helper.

use std::process::Command;

/// Open the system file browser with `path` selected (or the repo folder when
/// `path` is empty). Windows-only for now (Explorer).
#[tauri::command(async)]
pub fn reveal_in_explorer(repo: String, path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        std::path::PathBuf::from(&repo)
    } else {
        std::path::Path::new(&repo).join(&path)
    };
    #[cfg(windows)]
    {
        let mut cmd = Command::new("explorer");
        if path.trim().is_empty() {
            cmd.arg(&target);
        } else {
            // `/select,<path>` highlights the file inside its folder.
            cmd.arg(format!("/select,{}", target.display()));
        }
        // explorer returns a non-zero code even on success, so just spawn it.
        cmd.spawn().map_err(|e| format!("Could not open Explorer: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Reveal in Explorer is only available on Windows.".to_string())
}

/// The repo's configured identity (e.g. an email) from `.lore/config.toml`, or
/// "" if none is set. Lore records no per-commit author, so this single identity
/// is the best "who am I committing as" the data offers.
#[tauri::command(async)]
pub fn lore_identity(repo: String) -> String {
    let cfg = std::path::Path::new(&repo).join(".lore").join("config.toml");
    let text = match std::fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("identity") {
            if let Some(val) = rest.trim_start().strip_prefix('=') {
                return val.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

/// The repo's remote server URL from `.lore/config.toml` (e.g.
/// "lore://100.x.y.z:41337"), or "" if none. Lets the UI show whether the open
/// project is on a Local server (localhost) or a Remote one.
#[tauri::command(async)]
pub fn lore_repo_remote(repo: String) -> String {
    let cfg = std::path::Path::new(&repo).join(".lore").join("config.toml");
    let text = match std::fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("remote_url") {
            if let Some(val) = rest.trim_start().strip_prefix('=') {
                return val.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

/// Set (or clear) this repo's identity in `.lore/config.toml`. Writing a
/// root-level `identity = "<email>"` is where Lore keeps the `--identity` value,
/// so future commits use it. An empty value removes the line.
#[tauri::command(async)]
pub fn lore_set_identity(repo: String, identity: String) -> Result<String, String> {
    let cfg = std::path::Path::new(&repo).join(".lore").join("config.toml");
    if !cfg.is_file() {
        return Err("This project has no .lore/config.toml.".to_string());
    }
    let text = std::fs::read_to_string(&cfg).map_err(|e| format!("Cannot read config: {e}"))?;
    let value = identity.trim().replace('"', "");

    // Drop any existing root-level identity line first.
    let mut lines: Vec<String> = text
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("identity") && l.contains('='))
        })
        .map(|l| l.to_string())
        .collect();

    if !value.is_empty() {
        let new_line = format!("identity = \"{value}\"");
        // Put it at the top (root table), before the first [section].
        let pos = lines.iter().position(|l| l.trim_start().starts_with('['));
        match pos {
            Some(i) => lines.insert(i, new_line),
            None => lines.push(new_line),
        }
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(&cfg, out).map_err(|e| format!("Could not write identity: {e}"))?;
    Ok("Identity saved.".to_string())
}
