// Types mirror the Rust serde structs (see src-tauri/src/lore/model.rs) plus a
// few UI-only shapes used while folding flat file lists into the folder tree.

export interface FileChange { status: "A" | "M" | "D"; path: string; }

export interface StatusInfo {
  repository: string;
  branch: string;
  local_revision: string;
  sync_state: string;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicts: FileChange[];
  raw: string;
}

export interface Branch { name: string; current: boolean; }
export interface BranchList { local: Branch[]; remote: Branch[]; raw: string; }
export interface RunResult { output: string; ok: boolean; }
export interface FileMeta { size: number; exists: boolean; }

export interface Commit {
  revision: string;
  signature: string;
  branch: string;
  merge_parent: string;
  date: string;
  message: string;
  is_merge: boolean;
  author: string; // committer email for THIS commit, "" when Lore did not retain it
}

// One file row in the changes list, before it is folded into the folder tree.
export interface FileRow { change: FileChange; staged: boolean; }

// A node in the folder tree we build from flat file paths.
export interface TreeNode {
  name: string;
  full: string;
  dir: boolean;
  children: Map<string, TreeNode>;
  payload?: unknown;
}

// One entry in a right-click context menu.
export interface CtxItem { label?: string; danger?: boolean; sep?: boolean; run?: () => void; }

// One aligned row in the side-by-side diff.
export interface SbsRow {
  type: "ctx" | "add" | "del" | "chg" | "meta";
  oldNum?: number; newNum?: number; oldText?: string; newText?: string;
}

// One row of a parsed merge-conflict file (context line or conflict pair).
export type ConflictRow = { meta?: string; left?: string; right?: string; conflict?: boolean };
