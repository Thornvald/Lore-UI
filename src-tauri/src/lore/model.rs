// Serde structs shared across the lore bridge: the parsed shapes the frontend
// consumes (status, branches, history) plus the small preview payloads.

use serde::Serialize;

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

/// One entry from `lore history`.
#[derive(Serialize)]
pub struct Commit {
    pub revision: String,
    pub signature: String,
    /// Branch id this revision sits on (used to colour the history graph).
    pub branch: String,
    /// For a merge commit, the signature of the merged-in revision (its second
    /// parent), so the UI can draw the merge line.
    pub merge_parent: String,
    pub date: String,
    pub message: String,
    pub is_merge: bool,
    /// Committer identity (email) for THIS revision, when Lore exposes it. Empty
    /// for commits whose author Lore did not retain (e.g. synced through an
    /// auth-disabled server), so the UI can show "unknown" instead of faking it.
    pub author: String,
}

/// Result of a raw console command.
#[derive(Serialize)]
pub struct RunResult {
    pub output: String,
    /// True when no "[Error]" line was printed and the process exited success.
    pub ok: bool,
}

/// Size + existence of a working-tree file, for the preview info card.
#[derive(Serialize)]
pub struct FileMeta {
    pub size: u64,
    pub exists: bool,
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
