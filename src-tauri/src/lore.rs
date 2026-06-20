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
    /// Files left conflicted by an in-progress merge (best-effort parse).
    pub conflicts: Vec<FileChange>,
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
    // A GUI never wants the CLI to block on an interactive prompt (e.g. per-link
    // commit messages during merge/cherry-pick/revert), so force non-interactive.
    if !full.iter().any(|a| a == "--non-interactive") {
        full.push("--non-interactive".to_string());
    }
    full.extend(args.iter().map(|a| a.to_string()));
    let output = Command::new("lore")
        .args(&full)
        .current_dir(repo)
        .stdin(Stdio::null())
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
        conflicts: Vec::new(),
        raw: raw.clone(),
    };

    // Which file-list section are we currently inside.
    #[derive(PartialEq)]
    enum Section {
        None,
        Staged,
        Unstaged,
        Untracked,
        Conflicts,
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
        // Best-effort: a header mentioning "conflict" starts a conflicts list.
        // (Exact Lore wording needs checking against a real conflict.)
        let lower = trimmed.trim().to_lowercase();
        if (lower.contains("conflict") || lower.starts_with("unmerged")) && trimmed.trim_end().ends_with(':') {
            section = Section::Conflicts;
            continue;
        }
        if trimmed.starts_with("Tracked changes") {
            section = Section::None;
            continue;
        }

        // Conflicts can be marked differently (C/U/UU/...) or bare paths, so be
        // lenient here and take whatever path the line carries.
        if section == Section::Conflicts {
            let t = trimmed.trim();
            if !t.is_empty() {
                let mut chars = t.chars();
                let first = chars.next().unwrap();
                let marked = matches!(chars.next(), Some(c) if c.is_whitespace());
                let (status, path) = if marked {
                    (first.to_string(), t[first.len_utf8()..].trim().to_string())
                } else {
                    ("C".to_string(), t.to_string())
                };
                info.conflicts.push(FileChange { status, path });
            }
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
                Section::Conflicts | Section::None => {}
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

/// Start a merge that may leave conflicts for the user to resolve in the UI.
#[tauri::command(async)]
pub fn lore_merge_start(repo: String, source: String) -> Result<String, String> {
    if source.trim().is_empty() {
        return Err("Pick a branch to merge from.".to_string());
    }
    run_lore(&repo, &["branch", "merge", "start", &source])
}

/// Resolve conflicts using one side: `side` is "mine" or "theirs". With no
/// paths, resolves all conflicts that way.
#[tauri::command(async)]
pub fn lore_merge_resolve(repo: String, side: String, paths: Vec<String>) -> Result<String, String> {
    if side != "mine" && side != "theirs" {
        return Err("Side must be 'mine' or 'theirs'.".to_string());
    }
    let mut args: Vec<&str> = vec!["branch", "merge", "resolve", &side];
    for p in &paths {
        args.push(p.as_str());
    }
    run_lore(&repo, &args)
}

/// Finalize the merge once all conflicts are resolved.
#[tauri::command(async)]
pub fn lore_merge_finish(repo: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "merge", "resolve"])
}

/// Abort an in-progress merge.
#[tauri::command(async)]
pub fn lore_merge_abort(repo: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "merge", "abort"])
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
    /// Branch id this revision sits on (used to colour the history graph).
    pub branch: String,
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
                branch: String::new(),
                date: String::new(),
                message: String::new(),
                is_merge: false,
            });
        } else if t.starts_with("Signature") {
            if let Some(c) = out.last_mut() {
                c.signature = value(t);
            }
        } else if t.starts_with("Branch") {
            if let Some(c) = out.last_mut() {
                c.branch = value(t);
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
        // Blank lines are ignored.
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

// ---- Revision operations (commit context menu) ----

/// Synchronize the working tree to a revision (`lore revision sync <rev>`).
#[tauri::command(async)]
pub fn lore_revision_sync(repo: String, revision: String) -> Result<String, String> {
    run_lore(&repo, &["revision", "sync", &revision])
}

/// Cherry-pick a revision onto the currently synced revision.
#[tauri::command(async)]
pub fn lore_revision_cherry_pick(repo: String, revision: String) -> Result<String, String> {
    run_lore(&repo, &["revision", "cherry-pick", &revision])
}

/// Amend the latest commit's message.
#[tauri::command(async)]
pub fn lore_revision_amend(repo: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Type a new message.".to_string());
    }
    run_lore(&repo, &["revision", "amend", &message])
}

/// Text info about a revision (`lore revision info <rev>`).
#[tauri::command(async)]
pub fn lore_revision_info(repo: String, revision: String) -> Result<String, String> {
    run_lore(&repo, &["revision", "info", &revision])
}

// ---- Branch operations (branch context menu) ----

/// Reset the current branch's local latest pointer to `revision`.
#[tauri::command(async)]
pub fn lore_branch_reset(repo: String, revision: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "reset", &revision])
}

/// Create a branch, optionally pointing its latest at `revision` ("branch here").
/// Lore's `branch create` makes the branch at the current latest, so when a
/// revision is given we move the new branch's pointer to it with `branch reset`.
#[tauri::command(async)]
pub fn lore_branch_create_at(repo: String, name: String, revision: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Type a name for the new branch.".to_string());
    }
    let made = run_lore(&repo, &["branch", "create", &name])?;
    if revision.trim().is_empty() {
        return Ok(made);
    }
    let moved = run_lore(&repo, &["branch", "reset", &revision, "--branch", &name])?;
    Ok(format!("{made}\n{moved}"))
}

/// Push a branch to remote (current branch if `name` is empty).
#[tauri::command(async)]
pub fn lore_branch_push(repo: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return run_lore(&repo, &["branch", "push"]);
    }
    run_lore(&repo, &["branch", "push", &name])
}

/// Text info about a branch (current branch if `name` is empty).
#[tauri::command(async)]
pub fn lore_branch_info(repo: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return run_lore(&repo, &["branch", "info"]);
    }
    run_lore(&repo, &["branch", "info", &name])
}

/// Archive (remove) a branch.
#[tauri::command(async)]
pub fn lore_branch_archive(repo: String, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("No branch given.".to_string());
    }
    run_lore(&repo, &["branch", "archive", &name])
}

/// Protect or unprotect a branch from direct pushes.
#[tauri::command(async)]
pub fn lore_branch_protect(repo: String, name: String, protect: bool) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("No branch given.".to_string());
    }
    let sub = if protect { "protect" } else { "unprotect" };
    run_lore(&repo, &["branch", sub, &name])
}

// ---- File locking (important for binary art assets that cannot be merged) ----

/// Acquire a lock on a file (`lore lock acquire <path>`).
#[tauri::command(async)]
pub fn lore_lock_acquire(repo: String, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("No file given.".to_string());
    }
    run_lore(&repo, &["lock", "acquire", &path])
}

/// Release a lock on a file (`lore lock release <path>`).
#[tauri::command(async)]
pub fn lore_lock_release(repo: String, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("No file given.".to_string());
    }
    run_lore(&repo, &["lock", "release", &path])
}

/// Lock status of a file (`lore lock status <path>`).
#[tauri::command(async)]
pub fn lore_lock_status(repo: String, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("No file given.".to_string());
    }
    run_lore(&repo, &["lock", "status", &path])
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

// ---- File preview support ----

/// Size + existence of a working-tree file, for the preview info card.
#[derive(Serialize)]
pub struct FileMeta {
    pub size: u64,
    pub exists: bool,
}

#[tauri::command(async)]
pub fn file_meta(repo: String, path: String) -> FileMeta {
    match std::fs::metadata(std::path::Path::new(&repo).join(&path)) {
        Ok(m) => FileMeta { size: m.len(), exists: m.is_file() },
        Err(_) => FileMeta { size: 0, exists: false },
    }
}

/// Read a working-tree file's raw bytes for previewing (images, 3D models, ...).
/// Returns the bytes over Tauri's binary IPC, so the frontend gets an ArrayBuffer
/// directly - big textures and models never go through a JSON number array.
/// Capped so a stray huge file can't blow up memory.
#[tauri::command(async)]
pub fn read_file_bytes(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    // 256 MB is far above normal art assets; it only guards against accidents.
    const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "File is too big to preview ({} MB).",
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Find a byte pattern in `data`, returning the start index.
fn find_pattern(data: &[u8], pat: &[u8]) -> Option<usize> {
    if pat.is_empty() || data.len() < pat.len() {
        return None;
    }
    data.windows(pat.len()).position(|w| w == pat)
}

/// Pull the largest embedded PNG out of `data`, if any.
/// Unreal editor assets store the content-browser thumbnail PNG-compressed
/// inside the package, so scanning for a complete PNG (signature .. IEND) gets
/// us that thumbnail without parsing the whole UE package format.
fn extract_png(data: &[u8]) -> Option<Vec<u8>> {
    const SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const IEND: [u8; 8] = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
    let mut best: Option<Vec<u8>> = None;
    let mut i = 0usize;
    while i + SIG.len() <= data.len() {
        if data[i..i + SIG.len()] == SIG {
            if let Some(rel) = find_pattern(&data[i..], &IEND) {
                let end = i + rel + IEND.len();
                let candidate = &data[i..end];
                if best.as_ref().map_or(true, |b| candidate.len() > b.len()) {
                    best = Some(candidate.to_vec());
                }
                i = end;
                continue;
            }
            break; // PNG start with no end - give up
        }
        i += 1;
    }
    best
}

/// Pull the largest embedded JPEG out of `data` (fallback for assets that store
/// a JPEG thumbnail instead of a PNG).
fn extract_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    const START: [u8; 3] = [0xFF, 0xD8, 0xFF];
    const END: [u8; 2] = [0xFF, 0xD9];
    let start = find_pattern(data, &START)?;
    let rel_end = find_pattern(&data[start..], &END)?;
    let end = start + rel_end + END.len();
    Some(data[start..end].to_vec())
}

/// Best-effort thumbnail for an Unreal `.uasset`/`.umap`: extract the embedded
/// editor thumbnail image. Returns an error if the asset carries no thumbnail
/// (e.g. cooked assets), so the UI can fall back to an info card.
#[tauri::command(async)]
pub fn read_uasset_thumb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX_SCAN_BYTES: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX_SCAN_BYTES {
        return Err("Asset is too big to scan for a thumbnail.".to_string());
    }
    let data = std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?;
    if let Some(png) = extract_png(&data) {
        return Ok(tauri::ipc::Response::new(png));
    }
    if let Some(jpg) = extract_jpeg(&data) {
        return Ok(tauri::ipc::Response::new(jpg));
    }
    Err("No embedded thumbnail in this asset.".to_string())
}

fn read_u32(b: &[u8], little_endian: bool) -> u32 {
    let arr = [b[0], b[1], b[2], b[3]];
    if little_endian { u32::from_le_bytes(arr) } else { u32::from_be_bytes(arr) }
}

/// Decompress a `.blend` saved with compression (gzip, older; zstd, Blender 3.0+);
/// otherwise return the bytes unchanged.
fn maybe_decompress(data: Vec<u8>) -> Vec<u8> {
    use std::io::Read;
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        let mut out = Vec::new();
        if flate2::read::GzDecoder::new(&data[..]).read_to_end(&mut out).is_ok() {
            return out;
        }
    } else if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
        // Blender writes the .blend as many concatenated zstd frames, so decode
        // frame by frame until the whole input is consumed.
        let mut cursor = std::io::Cursor::new(&data[..]);
        let mut out = Vec::new();
        let mut last = 0u64;
        while (cursor.position() as usize) < data.len() {
            match ruzstd::StreamingDecoder::new(&mut cursor) {
                Ok(mut dec) => {
                    if dec.read_to_end(&mut out).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
            if cursor.position() == last {
                break; // no progress - avoid an infinite loop
            }
            last = cursor.position();
        }
        if !out.is_empty() {
            return out;
        }
    }
    data
}

fn read_u64(b: &[u8], little_endian: bool) -> u64 {
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&b[0..8]);
    if little_endian { u64::from_le_bytes(arr) } else { u64::from_be_bytes(arr) }
}

/// Parsed `.blend` header. Handles the classic 12-byte header and the new
/// "BLENDER17-01v0501" large-file header (Blender 4.0+/5.x) whose file-block
/// headers carry a 64-bit length.
struct BlendHeader {
    little_endian: bool,
    block_header_len: usize,
    new_format: bool,
    data_start: usize,
}

fn parse_blend_header(data: &[u8]) -> Option<BlendHeader> {
    if data.len() < 12 || &data[0..7] != b"BLENDER" {
        return None;
    }
    let b7 = data[7];
    // Classic: byte 7 is the pointer-size marker ('-' = 8, '_' = 4).
    if b7 == b'-' || b7 == b'_' {
        let ptr = if b7 == b'-' { 8 } else { 4 };
        return Some(BlendHeader {
            little_endian: data[8] == b'v',
            block_header_len: 4 + 4 + ptr + 4 + 4,
            new_format: false,
            data_start: 12,
        });
    }
    // New: "BLENDER" + 2 digits (header size) + ptr + 2 digits (format ver) +
    // endian + version. Block headers become: code[4] pad[4] len:u64 old sdna nr.
    if b7.is_ascii_digit() && data.len() >= 17 {
        let hsize = (b7 - b'0') as usize * 10 + (data[8] - b'0') as usize;
        let ptr = if data[9] == b'-' { 8 } else { 4 };
        return Some(BlendHeader {
            little_endian: data[12] == b'v',
            block_header_len: 4 + 4 + 8 + ptr + 4 + 4,
            new_format: true,
            data_start: hsize,
        });
    }
    None
}

/// The byte length of the block whose header starts at `off`.
fn blend_block_len(data: &[u8], off: usize, h: &BlendHeader) -> usize {
    if h.new_format {
        read_u64(&data[off + 8..off + 16], h.little_endian) as usize
    } else {
        read_u32(&data[off + 4..off + 8], h.little_endian) as usize
    }
}

/// Best-effort thumbnail for a Blender `.blend`: walk the file-block list to the
/// "TEST" block, which holds the saved preview image (int32 width, int32 height,
/// then RGBA pixels). Returns `[u32 width][u32 height][rgba...]` (all little-
/// endian) for the UI to paint, or an error when the file is compressed or has
/// no saved preview.
#[tauri::command(async)]
pub fn read_blend_thumb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX {
        return Err("File too large to scan.".to_string());
    }
    let data = maybe_decompress(std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?);
    let h = parse_blend_header(&data).ok_or("Could not read this .blend.".to_string())?;
    let le = h.little_endian;
    let mut off = h.data_start;
    while off + h.block_header_len <= data.len() {
        let code = &data[off..off + 4];
        if code == b"ENDB" {
            break;
        }
        let size = blend_block_len(&data, off, &h);
        let body = off + h.block_header_len;
        if body + size > data.len() {
            break;
        }
        if code == b"TEST" && size >= 8 {
            let w = read_u32(&data[body..body + 4], le);
            let hgt = read_u32(&data[body + 4..body + 8], le);
            let want = (w as usize).saturating_mul(hgt as usize).saturating_mul(4);
            let take = want.min(size - 8);
            let mut out = Vec::with_capacity(8 + take);
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&hgt.to_le_bytes());
            out.extend_from_slice(&data[body + 8..body + 8 + take]);
            return Ok(tauri::ipc::Response::new(out));
        }
        off = body + size;
    }
    Err("No saved preview in this .blend.".to_string())
}

/// A summary of what is inside a `.blend`: thumbnail size and a count of each
/// datablock kind (objects, meshes, materials, ...).
#[derive(Serialize)]
pub struct BlendInfo {
    pub width: u32,
    pub height: u32,
    pub has_thumb: bool,
    pub datablocks: Vec<(String, u32)>,
}

fn blend_id_label(c0: u8, c1: u8) -> &'static str {
    match (c0, c1) {
        (b'O', b'B') => "Objects",
        (b'M', b'E') => "Meshes",
        (b'M', b'A') => "Materials",
        (b'I', b'M') => "Images",
        (b'T', b'E') => "Textures",
        (b'C', b'A') => "Cameras",
        (b'L', b'A') => "Lights",
        (b'A', b'R') => "Armatures",
        (b'A', b'C') => "Actions",
        (b'C', b'U') => "Curves",
        (b'W', b'O') => "Worlds",
        (b'S', b'C') => "Scenes",
        (b'G', b'R') => "Collections",
        (b'N', b'T') => "Node trees",
        (b'B', b'R') => "Brushes",
        (b'P', b'A') => "Particle systems",
        (b'G', b'D') => "Grease pencil",
        (b'V', b'F') => "Fonts",
        (b'S', b'O') => "Sounds",
        (b'T', b'X') => "Texts",
        (b'L', b'T') => "Lattices",
        (b'M', b'B') => "Metaballs",
        _ => "Other data",
    }
}

/// Walk a `.blend`'s block list and tally its datablocks, so the UI can show
/// what the file contains (not just a thumbnail).
#[tauri::command(async)]
pub fn read_blend_info(repo: String, path: String) -> Result<BlendInfo, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX {
        return Err("File too large to scan.".to_string());
    }
    let data = maybe_decompress(std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?);
    if data.len() < 12 || &data[0..7] != b"BLENDER" {
        return Err("Could not read this .blend (unsupported compression?).".to_string());
    }
    let h = parse_blend_header(&data).ok_or("Could not read this .blend.".to_string())?;
    let le = h.little_endian;

    use std::collections::BTreeMap;
    let mut counts: BTreeMap<&'static str, u32> = BTreeMap::new();
    let mut width = 0u32;
    let mut height = 0u32;
    let mut has_thumb = false;

    let mut off = h.data_start;
    while off + h.block_header_len <= data.len() {
        let code = &data[off..off + 4];
        if code == b"ENDB" {
            break;
        }
        let size = blend_block_len(&data, off, &h);
        let body = off + h.block_header_len;
        if body + size > data.len() {
            break;
        }
        // ID datablocks use a 2-letter code with the last two bytes null;
        // structural blocks (DATA, DNA1, TEST, REND, GLOB, ...) do not.
        if code[2] == 0 && code[3] == 0 {
            *counts.entry(blend_id_label(code[0], code[1])).or_insert(0) += 1;
        } else if code == b"TEST" && size >= 8 {
            width = read_u32(&data[body..body + 4], le);
            height = read_u32(&data[body + 4..body + 8], le);
            has_thumb = width > 0 && height > 0;
        }
        off = body + size;
    }

    let mut datablocks: Vec<(String, u32)> =
        counts.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    datablocks.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(BlendInfo { width, height, has_thumb, datablocks })
}

/// Locate a Blender executable: `BLENDER_PATH` env, then common install paths,
/// then `blender` on PATH.
fn find_blender() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Ok(p) = std::env::var("BLENDER_PATH") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return pb;
        }
    }
    let candidates = [
        r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe",
        r"C:\Program Files\Steam\steamapps\common\Blender\blender.exe",
    ];
    for c in candidates {
        let pb = PathBuf::from(c);
        if pb.is_file() {
            return pb;
        }
    }
    if let Ok(entries) = std::fs::read_dir(r"C:\Program Files\Blender Foundation") {
        for e in entries.flatten() {
            let exe = e.path().join("blender.exe");
            if exe.is_file() {
                return exe;
            }
        }
    }
    PathBuf::from("blender") // last resort: rely on PATH
}

/// Convert a `.blend` to glTF-binary (glb) with a headless Blender and return
/// the glb bytes for the 3D viewer - so a `.blend` previews like an FBX. Needs
/// Blender installed (found via `find_blender`).
#[tauri::command(async)]
pub fn blend_to_glb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let input = std::path::Path::new(&repo).join(&path);
    if !input.is_file() {
        return Err("File not found.".to_string());
    }
    let blender = find_blender();

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("loreui_blend_{nanos}.glb"));
    let out_py = out.to_string_lossy().replace('\\', "/");

    // Load the .blend in background mode and export the scene to glb.
    let script = format!(
        "import bpy\ntry:\n import addon_utils; addon_utils.enable('io_scene_gltf2')\nexcept Exception:\n pass\nbpy.ops.export_scene.gltf(filepath='{out_py}', export_format='GLB')\n"
    );

    let mut cmd = Command::new(&blender);
    cmd.arg("-b")
        .arg(&input)
        .arg("--python-expr")
        .arg(&script)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Could not run Blender ({}): {e}", blender.display()))?;

    if !out.is_file() {
        let log = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
        return Err(format!(
            "Blender did not produce a model. Is Blender installed? {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        ));
    }
    let bytes = std::fs::read(&out).map_err(|e| format!("Cannot read converted model: {e}"))?;
    let _ = std::fs::remove_file(&out);
    Ok(tauri::ipc::Response::new(bytes))
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

// ---- Server setup support ----

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
