// Low-level `lore` CLI runner plus the global-flags state.
//
// The `lore` CLI has no JSON output, so the bridge shells out to the binary and
// parses its human-readable text. Note: `lore` sometimes exits 0 even on failure
// (a gRPC error prints "[Error] ..." yet returns exit code 0). So we never trust
// the exit code alone - we combine stdout+stderr and scan for an "[Error]" line.

use std::process::{Command, Stdio};
use std::sync::Mutex;

use super::model::RunResult;

/// Apply CREATE_NO_WINDOW so spawning a CLI process does not flash a console
/// window on Windows. Without it the app's constant `lore` calls (status polling,
/// history, branch list, ...) pop a cmd window each time. No-op off Windows.
pub(crate) fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Global lore flags (e.g. --offline, --force, --identity X) set from the
/// Settings window. Prepended to every command, before the subcommand.
static GLOBALS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(crate) fn globals() -> Vec<String> {
    GLOBALS.lock().unwrap().clone()
}

/// Replace the active global flags.
#[tauri::command(async)]
pub fn lore_set_globals(globals: Vec<String>) {
    *GLOBALS.lock().unwrap() = globals;
}

/// Launch `lore <args>` inside `repo` and hand back whether the process exited
/// cleanly plus its combined stdout+stderr. This is the low-level runner; pick
/// the failure policy at the call site (strict text scan vs. trust the exit
/// code) since the two disagree for commands that print benign "[Error]" noise.
pub(crate) fn run_lore_raw(repo: &str, args: &[&str]) -> Result<(bool, String), String> {
    // Global flags from Settings go first, then the command's own args.
    let mut full = globals();
    // A GUI never wants the CLI to block on an interactive prompt (e.g. per-link
    // commit messages during merge/cherry-pick/revert), so force non-interactive.
    if !full.iter().any(|a| a == "--non-interactive") {
        full.push("--non-interactive".to_string());
    }
    full.extend(args.iter().map(|a| a.to_string()));
    let mut cmd = Command::new("lore");
    cmd.args(&full).current_dir(repo).stdin(Stdio::null());
    no_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Could not run lore: {e}. Is the lore CLI on your PATH?"))?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), combined))
}

/// Run `lore <args>` inside `repo` and return combined stdout+stderr.
/// Returns Err with the captured text if the binary fails to launch or the
/// output contains a "[Error]" line. Most commands use this strict scan.
pub(crate) fn run_lore(repo: &str, args: &[&str]) -> Result<String, String> {
    let (success, combined) = run_lore_raw(repo, args)?;

    // lore's exit code is unreliable for many commands, so scan the text for an
    // error marker. Commands where the exit code IS reliable (e.g. archive) use
    // run_lore_raw directly instead, so they are not tripped up by benign noise.
    if let Some(line) = combined.lines().find(|l| l.trim_start().starts_with("[Error]")) {
        return Err(line.trim().to_string());
    }
    if !success && combined.trim().is_empty() {
        return Err("lore exited with an error (no output).".to_string());
    }
    Ok(combined)
}

/// Run a command and return the FULL combined output either way - the exit code
/// alone decides Ok vs Err. Merge commands need this: a conflict prints one
/// "[Error] ... <file>" line per clashing file, and run_lore's strict scan would
/// throw away all but the first, hiding files from the resolve list.
pub(crate) fn run_lore_full(repo: &str, args: &[&str]) -> Result<String, String> {
    let (success, combined) = run_lore_raw(repo, args)?;
    if success {
        return Ok(combined);
    }
    Err(combined)
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
    no_window(&mut cmd);

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
