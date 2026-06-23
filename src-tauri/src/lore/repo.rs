// The day-to-day repository commands: status, stage, commit, push, sync,
// branches, diff, merge, history, revision and lock operations. These are thin
// wrappers over the `lore` CLI runner plus the text parsers.

use super::model::{BranchList, Commit, FileChange, StatusInfo};
use super::parse::{parse_branches, parse_change_list, parse_history, parse_status};
use super::process::{run_lore, run_lore_full, run_lore_raw};

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
pub fn lore_switch_branch(repo: String, name: String, reset: bool) -> Result<String, String> {
    // --reset overwrites local modified files to match the incoming revision.
    if reset {
        return run_lore(&repo, &["branch", "switch", &name, "--reset"]);
    }
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
/// `message` is used to commit when the merge is clean (no conflicts).
#[tauri::command(async)]
pub fn lore_merge_start(repo: String, source: String, message: String) -> Result<String, String> {
    if source.trim().is_empty() {
        return Err("Pick a branch to merge from.".to_string());
    }
    if message.trim().is_empty() {
        return run_lore_full(&repo, &["branch", "merge", "start", &source]);
    }
    run_lore_full(&repo, &["branch", "merge", "start", &source, "--message", &message])
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
    run_lore_full(&repo, &args)
}

/// Finalize the merge once all conflicts are resolved.
#[tauri::command(async)]
pub fn lore_merge_finish(repo: String) -> Result<String, String> {
    run_lore_full(&repo, &["branch", "merge", "resolve"])
}

/// Abort an in-progress merge.
#[tauri::command(async)]
pub fn lore_merge_abort(repo: String) -> Result<String, String> {
    run_lore(&repo, &["branch", "merge", "abort"])
}

#[tauri::command(async)]
pub fn lore_history(repo: String) -> Result<Vec<Commit>, String> {
    let raw = run_lore(&repo, &["history"])?;
    Ok(parse_history(raw))
}

/// History starting at a specific revision and stopping at its branch point
/// (`--only-branch`). Used to pull a merged-in branch's own commits so the
/// history view can draw them as a separate lane joined at the merge commit.
#[tauri::command(async)]
pub fn lore_history_from(repo: String, revision: String) -> Result<Vec<Commit>, String> {
    if revision.trim().is_empty() {
        return Err("No revision given.".to_string());
    }
    let raw = run_lore(&repo, &["history", "--revision", &revision, "--only-branch"])?;
    Ok(parse_history(raw))
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
    // Archive succeeds (exit 0) yet still prints a benign "[Error] Not found"
    // when the branch was never pushed, so there is no remote copy to archive.
    // The exit code is reliable here, so trust it rather than the text scan.
    // A real failure (e.g. archiving the current branch) exits non-zero, and we
    // surface its "[Error]" line.
    let (success, out) = run_lore_raw(&repo, &["branch", "archive", &name])?;
    if success {
        return Ok(out);
    }
    if let Some(line) = out.lines().find(|l| l.trim_start().starts_with("[Error]")) {
        return Err(line.trim().to_string());
    }
    Err("Could not archive the branch.".to_string())
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
