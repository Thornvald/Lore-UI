// Local loreserver control (start/stop/status/persistent store config), the
// working-tree watcher, and the share-address helpers (LAN + Tailscale IP).

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use super::process::no_window;

/// A local loreserver the app started itself (so we can stop it again).
static SERVER: Mutex<Option<Child>> = Mutex::new(None);

/// The active working-tree watcher (one repo at a time). Kept alive here so it
/// keeps firing; dropping it (when a new repo is watched) stops the old one.
static WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// Watch the open repo's working tree and emit a "repo-changed" event whenever a
/// real file change happens, so the Changes list updates without a manual Refresh.
/// Lore's own `.lore` store and the big regenerated folders (Unreal Saved/, etc.)
/// are skipped so commits and engine churn do not spam refreshes.
#[tauri::command]
pub fn start_repo_watch(app: tauri::AppHandle, repo: String) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};
    use tauri::Emitter;

    const SKIP: &[&str] = &[
        ".lore", ".git", "Saved", "Intermediate", "DerivedDataCache", "Binaries",
        "Build", "node_modules", "target", ".vs",
    ];
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        // Ignore Lore's internal store and regenerated folders.
        let skip = event.paths.iter().any(|p| {
            p.components()
                .any(|c| SKIP.contains(&c.as_os_str().to_string_lossy().as_ref()))
        });
        if skip {
            return;
        }
        let _ = app.emit("repo-changed", ());
    })
    .map_err(|e| format!("Could not start the file watcher: {e}"))?;
    watcher
        .watch(std::path::Path::new(&repo), RecursiveMode::Recursive)
        .map_err(|e| format!("Could not watch the project folder: {e}"))?;
    *WATCHER.lock().unwrap() = Some(watcher);
    Ok(())
}

/// True if a lore server answers at `base_url` (e.g. "lore://127.0.0.1:41337").
/// Uses a cheap `repository list` and looks for connection errors.
#[tauri::command(async)]
pub fn lore_server_status(base_url: String) -> bool {
    let mut cmd = Command::new("lore");
    cmd.args(["repository", "list", &base_url, "--non-interactive"])
        .stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output();
    match out {
        Ok(o) => {
            let s = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            !(s.contains("transport error")
                || s.contains("connecting to remote")
                || s.contains("Connection refused")
                || s.contains("ConnectionRefused"))
        }
        Err(_) => false,
    }
}

/// Start a local loreserver, detached and windowless, so it outlives the app
/// and short tool runs. No-op if the app already started one.
#[tauri::command(async)]
pub fn lore_start_server(config_dir: Option<String>) -> Result<String, String> {
    let mut guard = SERVER.lock().unwrap();
    if guard.is_some() {
        return Ok("Server already started by the app.".to_string());
    }
    let mut cmd = Command::new("loreserver");
    // A persistent data folder keeps repos across restarts (else loreserver uses
    // a temp dir). The folder must hold a local.toml (see write_server_store_config).
    if let Some(dir) = config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        cmd.args(["--config", dir]);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS (0x8) | CREATE_NO_WINDOW (0x08000000)
        cmd.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start loreserver: {e}. Is it on your PATH?"))?;
    *guard = Some(child);
    Ok("Local server starting…".to_string())
}

/// Write a loreserver config dir under `data_dir` that points the immutable +
/// mutable stores at a persistent folder, and return that config dir path (to
/// pass to `lore_start_server`). This is how the quick local server keeps data.
#[tauri::command(async)]
pub fn write_server_store_config(data_dir: String) -> Result<String, String> {
    let base = std::path::Path::new(&data_dir);
    if data_dir.trim().is_empty() {
        return Err("Pick a data folder first.".to_string());
    }
    let config_dir = base.join("lore-config");
    let store_dir = base.join("store");
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("Could not create config folder: {e}"))?;
    std::fs::create_dir_all(&store_dir).map_err(|e| format!("Could not create store folder: {e}"))?;
    let store_path = store_dir.to_string_lossy().replace('\\', "/");
    let toml = format!(
        "[immutable_store.local]\npath = \"{store_path}\"\n\n[mutable_store.local]\npath = \"{store_path}\"\n"
    );
    std::fs::write(config_dir.join("local.toml"), toml)
        .map_err(|e| format!("Could not write server config: {e}"))?;
    Ok(config_dir.to_string_lossy().to_string())
}

/// A sensible default folder for the local server's PERSISTENT data, so the
/// auto-started server never runs on temp storage (which silently loses every
/// repo when it restarts). Created if missing.
#[tauri::command(async)]
pub fn default_server_data_dir() -> Result<String, String> {
    let base = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Could not find the user home folder.".to_string())?;
    let dir = std::path::Path::new(&base).join("LoreServerData");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the server data folder: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Stop the local server the app started (does nothing to an external server).
#[tauri::command(async)]
pub fn lore_stop_server() -> Result<String, String> {
    let mut guard = SERVER.lock().unwrap();
    match guard.take() {
        Some(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            Ok("Local server stopped.".to_string())
        }
        None => Err("The app did not start a server (it may be running externally).".to_string()),
    }
}

/// Best-guess LAN IPv4 of this machine, so the setup screen can show teammates
/// the address to connect to (e.g. "lore://192.168.1.20:41337").
///
/// Trick: connecting a UDP socket picks the default-route interface without
/// sending any packet, which gives us the outward-facing local IP. Returns
/// None if there is no route (offline / no LAN).
#[tauri::command(async)]
pub fn local_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    // Ignore a loopback answer - it is useless for sharing with teammates.
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

/// This machine's Tailscale address, if Tailscale is up. Connecting a UDP socket
/// to Tailscale's MagicDNS IP (100.100.100.100) routes through the tailscale
/// interface, so the socket's own address is the 100.x CGNAT address - exactly
/// what a friend on the same tailnet uses to reach this server. Returns None when
/// Tailscale is not running (the route to that IP then leaves the tailnet).
#[tauri::command(async)]
pub fn tailscale_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("100.100.100.100:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if let std::net::IpAddr::V4(v4) = ip {
        let o = v4.octets();
        // Tailscale assigns out of 100.64.0.0/10 (CGNAT).
        if o[0] == 100 && (64..=127).contains(&o[1]) {
            return Some(ip.to_string());
        }
    }
    None
}
