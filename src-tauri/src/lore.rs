// Lore CLI bridge.
//
// The `lore` CLI has no JSON output, so this module shells out to the binary
// and parses its human-readable text. Every format here was captured from real
// `lore 0.8.3` output (see status/stage/commit/push/branch samples), not guessed.
//
// Note: `lore` sometimes exits 0 even on failure (e.g. a gRPC connection error
// prints "[Error] ..." but returns exit code 0). So we never trust the exit code
// alone - we combine stdout+stderr and scan for an "[Error]" line.

use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// A local loreserver the app started itself (so we can stop it again).
static SERVER: Mutex<Option<Child>> = Mutex::new(None);

/// True if a lore server answers at `base_url` (e.g. "lore://127.0.0.1:41337").
/// Uses a cheap `repository list` and looks for connection errors.
#[tauri::command(async)]
pub fn lore_server_status(base_url: String) -> bool {
    let out = Command::new("lore")
        .args(["repository", "list", &base_url, "--non-interactive"])
        .stdin(Stdio::null())
        .output();
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
pub fn lore_start_server() -> Result<String, String> {
    let mut guard = SERVER.lock().unwrap();
    if guard.is_some() {
        return Ok("Server already started by the app.".to_string());
    }
    let mut cmd = Command::new("loreserver");
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

/// Global lore flags (e.g. --offline, --force, --identity X) set from the
/// Settings window. Prepended to every command, before the subcommand.
static GLOBALS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn globals() -> Vec<String> {
    GLOBALS.lock().unwrap().clone()
}

/// Replace the active global flags.
#[tauri::command(async)]
pub fn lore_set_globals(globals: Vec<String>) {
    *GLOBALS.lock().unwrap() = globals;
}

/// One changed file in the working tree.
#[derive(Serialize)]
pub struct FileChange {
    /// "A" added, "M" modified, "D" deleted.
    pub status: String,
    pub path: String,
}

/// Parsed result of `lore status --scan`.
#[derive(Serialize)]
pub struct StatusInfo {
    pub repository: String,
    pub branch: String,
    pub local_revision: String,
    /// Plain-words sync state, e.g. "in sync with remote" or "ahead of remote".
    pub sync_state: String,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
    /// Raw CLI text, shown in the app's log panel for transparency.
    pub raw: String,
}

#[derive(Serialize)]
pub struct Branch {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize)]
pub struct BranchList {
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
    pub raw: String,
}

/// Run `lore <args>` inside `repo` and return combined stdout+stderr.
/// Returns Err with the captured text if the binary fails to launch or the
/// output contains a "[Error]" line.
fn run_lore(repo: &str, args: &[&str]) -> Result<String, String> {
    // Global flags from Settings go first, then the command's own args.
    let mut full = globals();
    full.extend(args.iter().map(|a| a.to_string()));
    let output = Command::new("lore")
        .args(&full)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Could not run lore: {e}. Is the lore CLI on your PATH?"))?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    // lore's exit code is unreliable, so scan the text for an error marker.
    if let Some(line) = combined.lines().find(|l| l.trim_start().starts_with("[Error]")) {
        return Err(line.trim().to_string());
    }
    if !output.status.success() && combined.trim().is_empty() {
        return Err(format!("lore exited with status {}", output.status));
    }
    Ok(combined)
}

/// Parse the output of `lore status --scan`.
fn parse_status(raw: String) -> StatusInfo {
    let mut info = StatusInfo {
        repository: String::new(),
        branch: String::new(),
        local_revision: String::new(),
        sync_state: String::new(),
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        raw: raw.clone(),
    };

    // Which file-list section are we currently inside.
    #[derive(PartialEq)]
    enum Section {
        None,
        Staged,
        Unstaged,
        Untracked,
    }
    let mut section = Section::None;

    for line in raw.lines() {
        let trimmed = line.trim_end();

        if let Some(rest) = trimmed.strip_prefix("Repository ") {
            info.repository = rest.trim().to_string();
            continue;
        }
        // "On branch main revision 1 -> <hash>"
        if let Some(rest) = trimmed.strip_prefix("On branch ") {
            // rest = "main revision 1 -> <hash>"
            let mut parts = rest.split_whitespace();
            if let Some(name) = parts.next() {
                info.branch = name.to_string();
            }
            // find token after "revision"
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            if let Some(pos) = tokens.iter().position(|t| *t == "revision") {
                if let Some(rev) = tokens.get(pos + 1) {
                    info.local_revision = rev.to_string();
                }
            }
            continue;
        }
        if trimmed.starts_with("Local branch ") {
            // "Local branch in sync with remote" / "is ahead of remote" / "is behind remote"
            info.sync_state = trimmed.trim_start_matches("Local branch ").trim().to_string();
            continue;
        }

        // Section headers.
        if trimmed.starts_with("Changes staged for commit") {
            section = Section::Staged;
            continue;
        }
        if trimmed.starts_with("Changes not staged for commit") {
            section = Section::Unstaged;
            continue;
        }
        if trimmed.starts_with("Untracked files") {
            section = Section::Untracked;
            continue;
        }
        if trimmed.starts_with("Tracked changes") {
            section = Section::None;
            continue;
        }

        // File lines look like "A hello.txt", "M hello.txt", "D notes.txt".
        // (Staged lines can carry a trailing space, already stripped.)
        let starts_with_marker = trimmed.len() >= 2
            && matches!(&trimmed[0..1], "A" | "M" | "D")
            && trimmed[1..2].chars().all(|c| c.is_whitespace());
        if section != Section::None && starts_with_marker {
            let status = trimmed[0..1].to_string();
            let path = trimmed[1..].trim().to_string();
            let change = FileChange { status, path };
            match section {
                Section::Staged => info.staged.push(change),
                Section::Unstaged => info.unstaged.push(change),
                Section::Untracked => info.untracked.push(change),
                Section::None => {}
            }
        }
    }

    info
}

/// Parse `lore branch list`.
fn parse_branches(raw: String) -> BranchList {
    let mut list = BranchList {
        local: Vec::new(),
        remote: Vec::new(),
        raw: raw.clone(),
    };

    enum Sec {
        None,
        Local,
        Remote,
    }
    let mut sec = Sec::None;

    for line in raw.lines() {
        let t = line.trim_end();
        if t.starts_with("Local branches") {
            sec = Sec::Local;
            continue;
        }
        if t.starts_with("Remote branches") {
            sec = Sec::Remote;
            continue;
        }
        // Entries: "* main" (current) or "  feature-x".
        let current = t.trim_start().starts_with('*');
        let name = t.trim_start().trim_start_matches('*').trim().to_string();
        if name.is_empty() {
            continue;
        }
        let branch = Branch { name, current };
        match sec {
            Sec::Local => list.local.push(branch),
            Sec::Remote => list.remote.push(branch),
            Sec::None => {}
        }
    }

    list
}

// ---- Tauri commands ----

#[tauri::command(async)]
pub fn lore_status(repo: String) -> Result<StatusInfo, String> {
    let raw = run_lore(&repo, &["status", "--scan"])?;
    Ok(parse_status(raw))
}

#[tauri::command(async)]
pub fn lore_stage(repo: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return Err("Nothing picked to save.".to_string());
    }
    let mut args: Vec<&str> = vec!["stage"];
    for f in &files {
        args.push(f.as_str());
    }
    run_lore(&repo, &args)
}

#[tauri::command(async)]
pub fn lore_commit(repo: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Write a short message before saving.".to_string());
    }
    run_lore(&repo, &["commit", &message])
}

#[tauri::command(async)]
pub fn lore_push(repo: String) -> Result<String, String> {
    run_lore(&repo, &["push"])
}

#[tauri::command(async)]
pub fn lore_sync(repo: String) -> Result<String, String> {
    run_lore(&repo, &["sync"])
}

#[tauri::command(async)]
pub fn lore_branches(repo: String) -> Result<BranchList, String> {
    let raw = run_lore(&repo, &["branch", "list"])?;
    Ok(parse_branches(raw))
}

#[tauri::command(async)]
pub fn lore_switch_branch(repo: String, name: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "switch", &name])
}

#[tauri::command(async)]
pub fn lore_create_branch(repo: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Type a name for the new branch.".to_string());
    }
    run_lore(&repo, &["branch", "create", &name])
}

/// Show the unified diff of one file: current revision vs the working file.
/// `lore diff <path>` defaults source=current revision, target=filesystem.
#[tauri::command(async)]
pub fn lore_diff(repo: String, path: String) -> Result<String, String> {
    let out = run_lore(&repo, &["diff", &path])?;
    if out.trim().is_empty() {
        return Ok("No line changes to show for this file.".to_string());
    }
    Ok(out)
}

/// Merge `source` branch into the current branch.
/// v1 handles the clean (no-conflict) path; conflicts are surfaced in the
/// returned text for the caller to warn about.
#[tauri::command(async)]
pub fn lore_merge_branch(repo: String, source: String, message: String) -> Result<String, String> {
    if source.trim().is_empty() {
        return Err("Pick a branch to merge from.".to_string());
    }
    if message.trim().is_empty() {
        return Err("Write a short message for the merge.".to_string());
    }
    run_lore(&repo, &["branch", "merge", &source, "--message", &message])
}

/// Create a new repository in `path`, registered on the server given by `url`
/// (e.g. "lore://127.0.0.1:41337/my-project"). The folder gets a `.lore` tree.
/// Needs a reachable Lore server, or lore reports a connection error.
#[tauri::command(async)]
pub fn lore_create_repo(path: String, url: String) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("Type the server address, like lore://127.0.0.1:41337/my-project".to_string());
    }
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("Pick a folder first.".to_string());
    }
    if dir.join(".lore").is_dir() {
        return Err("That folder is already a Lore project.".to_string());
    }
    run_lore(&path, &["repository", "create", url.trim()])
}

/// One entry from `lore history`.
#[derive(Serialize)]
pub struct Commit {
    pub revision: String,
    pub signature: String,
    pub date: String,
    pub message: String,
    pub is_merge: bool,
}

fn parse_history(raw: String) -> Vec<Commit> {
    let mut out: Vec<Commit> = Vec::new();
    let mut msg: Vec<String> = Vec::new();

    // Message lines are indented 4 spaces; field lines start at column 0.
    let value = |line: &str| line.splitn(2, ':').nth(1).unwrap_or("").trim().to_string();

    for line in raw.lines() {
        if line.starts_with("    ") {
            msg.push(line.trim().to_string());
            continue;
        }
        let t = line.trim();
        if t.starts_with("Revision") {
            // Starting a new entry: attach accumulated message to the previous one.
            if let Some(last) = out.last_mut() {
                last.message = msg.join("\n");
            }
            msg.clear();
            out.push(Commit {
                revision: value(t),
                signature: String::new(),
                date: String::new(),
                message: String::new(),
                is_merge: false,
            });
        } else if t.starts_with("Signature") {
            if let Some(c) = out.last_mut() {
                c.signature = value(t);
            }
        } else if t.starts_with("Merge") {
            if let Some(c) = out.last_mut() {
                c.is_merge = true;
            }
        } else if t.starts_with("Date") {
            if let Some(c) = out.last_mut() {
                c.date = value(t);
            }
        }
        // "Branch" and blank lines are ignored.
    }
    if let Some(last) = out.last_mut() {
        last.message = msg.join("\n");
    }
    out
}

#[tauri::command(async)]
pub fn lore_history(repo: String) -> Result<Vec<Commit>, String> {
    let raw = run_lore(&repo, &["history"])?;
    Ok(parse_history(raw))
}

/// Parse a list of "A/M/D path" lines (used by status sections and revision diff).
fn parse_change_list(raw: &str) -> Vec<FileChange> {
    let mut v = Vec::new();
    for line in raw.lines() {
        let t = line.trim_end();
        let marked = t.len() >= 2
            && matches!(&t[0..1], "A" | "M" | "D")
            && t[1..2].chars().all(|c| c.is_whitespace());
        if marked {
            v.push(FileChange {
                status: t[0..1].to_string(),
                path: t[1..].trim().to_string(),
            });
        }
    }
    v
}

/// Discard working-tree changes for the given files (`lore reset --purge`).
/// `--purge` also removes brand-new (untracked) files, scoped to the given
/// paths only - other untracked files are left alone.
#[tauri::command(async)]
pub fn lore_discard(repo: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return Err("Nothing picked to discard.".to_string());
    }
    let mut args: Vec<&str> = vec!["reset", "--purge"];
    for f in &files {
        args.push(f.as_str());
    }
    run_lore(&repo, &args)
}

/// Files changed in a commit: diff its parent revision against the commit.
#[tauri::command(async)]
pub fn lore_commit_files(
    repo: String,
    source: String,
    target: String,
) -> Result<Vec<FileChange>, String> {
    let raw = run_lore(&repo, &["revision", "diff", &source, "--target", &target])?;
    Ok(parse_change_list(&raw))
}

/// Line-level diff of one file between two revisions.
#[tauri::command(async)]
pub fn lore_commit_file_diff(
    repo: String,
    source: String,
    target: String,
    path: String,
) -> Result<String, String> {
    let out = run_lore(
        &repo,
        &["diff", "--source", &source, "--target", &target, &path],
    )?;
    if out.trim().is_empty() {
        return Ok("No line changes to show for this file.".to_string());
    }
    Ok(out)
}

/// Revert a commit by making an inverse commit (safe, like `git revert`).
#[tauri::command(async)]
pub fn lore_revert_commit(
    repo: String,
    revision: String,
    message: String,
) -> Result<String, String> {
    let msg = if message.trim().is_empty() {
        "Revert commit".to_string()
    } else {
        message
    };
    run_lore(&repo, &["revision", "revert", &revision, "--message", &msg])
}

/// Undo the latest commit by moving the branch pointer back to `revision`
/// (the parent). This removes the commit and resets the working tree to it.
#[tauri::command(async)]
pub fn lore_undo_commit(repo: String, revision: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "reset", &revision])
}

/// Result of a raw console command.
#[derive(Serialize)]
pub struct RunResult {
    pub output: String,
    /// True when no "[Error]" line was printed and the process exited success.
    pub ok: bool,
}

/// Ensure a global flag is present (prepended so it sits before the subcommand).
fn ensure_flag(args: &mut Vec<String>, flag: &str) {
    if !args.iter().any(|a| a == flag) {
        args.insert(0, flag.to_string());
    }
}

/// Run any `lore` command for the Console view. Returns the raw combined output
/// whether it succeeds or fails (the console shows errors rather than hiding
/// them). `repo` may be empty for commands that need no working tree
/// (clone, repository create, login, completions, --version, ...).
///
/// stdin is closed and prompts are disabled so a command that would wait for
/// input fails fast instead of hanging the window.
#[tauri::command(async)]
pub fn lore_run(repo: String, mut args: Vec<String>) -> Result<RunResult, String> {
    if args.is_empty() {
        return Err("Type a command.".to_string());
    }
    ensure_flag(&mut args, "--no-pager");
    ensure_flag(&mut args, "--non-interactive");

    // Prepend the global flags from Settings.
    let mut full = globals();
    full.extend(args);

    let mut cmd = Command::new("lore");
    cmd.args(&full).stdin(Stdio::null());
    if !repo.trim().is_empty() {
        cmd.current_dir(&repo);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Could not run lore: {e}. Is the lore CLI on your PATH?"))?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    let has_error = combined
        .lines()
        .any(|l| l.trim_start().starts_with("[Error]"));
    let ok = output.status.success() && !has_error;

    if combined.trim().is_empty() {
        combined = if ok {
            "(done, no output)".to_string()
        } else {
            format!("(no output, exit status {})", output.status)
        };
    }
    Ok(RunResult { output: combined, ok })
}

/// Quick check that the chosen folder is really a lore working tree.
#[tauri::command(async)]
pub fn lore_is_repo(repo: String) -> bool {
    std::path::Path::new(&repo).join(".lore").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim output captured from real `lore 0.8.3` runs.

    #[test]
    fn parses_mixed_status() {
        let raw = "\
Repository 019ed7404c5b78728401b6dc4d7d3e55
On branch main revision 1 -> e99c04944fc13bbb4e72ea75e815c6b690f27a56f96d6cbec82083d07fbcd43d
Remote revision 1 -> e99c04944fc13bbb4e72ea75e815c6b690f27a56f96d6cbec82083d07fbcd43d
Local branch in sync with remote
Changes not staged for commit:
M hello.txt
D notes.txt
Untracked files:
A fresh.txt
Tracked changes: 1 added, 1 modified, 1 deleted
";
        let s = parse_status(raw.to_string());
        assert_eq!(s.repository, "019ed7404c5b78728401b6dc4d7d3e55");
        assert_eq!(s.branch, "main");
        assert_eq!(s.local_revision, "1");
        assert_eq!(s.sync_state, "in sync with remote");
        assert_eq!(s.unstaged.len(), 2);
        assert_eq!(s.unstaged[0].status, "M");
        assert_eq!(s.unstaged[0].path, "hello.txt");
        assert_eq!(s.unstaged[1].status, "D");
        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "fresh.txt");
        assert!(s.staged.is_empty());
    }

    #[test]
    fn parses_staged_status() {
        // Staged lines carry a trailing space in real output.
        let raw = "\
Repository 019ed7404c5b78728401b6dc4d7d3e55
On branch main revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Remote revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Local branch in sync with remote
Changes staged for commit:
A hello.txt
A notes.txt
";
        let s = parse_status(raw.to_string());
        assert_eq!(s.staged.len(), 2);
        assert_eq!(s.staged[0].status, "A");
        assert_eq!(s.staged[0].path, "hello.txt");
        assert_eq!(s.local_revision, "0");
    }

    #[test]
    fn parses_branch_list() {
        let raw = "\
Local branches:
  main
* feature-x
Remote branches:
  main
";
        let b = parse_branches(raw.to_string());
        assert_eq!(b.local.len(), 2);
        assert_eq!(b.local[0].name, "main");
        assert!(!b.local[0].current);
        assert_eq!(b.local[1].name, "feature-x");
        assert!(b.local[1].current);
        assert_eq!(b.remote.len(), 1);
        assert_eq!(b.remote[0].name, "main");
    }
}
