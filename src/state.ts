// Shared mutable app state + constants + tiny pure helpers.
//
// All cross-module mutable state lives on the single `S` object so any module
// can read and write the same value (ES module `let` exports can't be reassigned
// by importers, an object field can). Module-local state (caches, timers) stays
// in its own module.

import type { Commit, StatusInfo } from "./types";

export const S = {
  repoPath: "",
  history: [] as Commit[],
  // Parallel to `history` (the flattened display order, this branch plus any
  // merged-in branch commits): the real parent to diff each row against, and
  // which lane it sits in (0 = this branch, 1 = a merged-in branch).
  histParents: [] as (Commit | undefined)[],
  histLanes: [] as number[],
  consoleOn: false,
  // Cleanup for the live preview (image object URL / three.js context), if any.
  previewCleanup: null as (() => void) | null,
  // This machine's LAN IP, fetched once for the server setup share line.
  setupLanIp: undefined as string | null | undefined,
  // This machine's Tailscale (100.x) IP, if on a tailnet.
  setupTsIp: undefined as string | null | undefined,
  // Last status, kept so sort/filter can re-render the list without re-fetching.
  lastStatus: null as StatusInfo | null,
  fileSort: "name" as "name" | "type",
  fileFilter: "",
  // The repo's configured identity (email or name), for author avatars.
  repoIdentity: "",
  // The open repo's remote server URL + whether it is a remote (non-localhost)
  // server, so the top bar can read "Remote" for a cloned project, not "Local".
  repoRemoteUrl: "",
  repoIsRemote: false,
  // Optional GitHub username for this repo (UI-only, stored locally) - drives
  // the avatar PICTURE only.
  repoGithubUser: "",
  // Optional display name shown in History (separate from the GitHub username).
  repoAuthorName: "",
  // Diff display mode + the last diff text, so the toggle can re-render in place.
  diffMode: (localStorage.getItem("diffMode") === "split" ? "split" : "unified") as "unified" | "split",
  lastDiffText: "",
  // In-progress merge: the conflicted paths still to resolve + the merge message.
  mergeConflicts: [] as string[],
  mergeMessage: "",
  // Target branch awaiting the dirty-tree switch guard.
  switchTargetName: "",
};

export const STATUS_LABEL: Record<string, string> = { A: "New", M: "Changed", D: "Removed" };

// localStorage keys.
export const RECENT_KEY = "recentProjects";
export const SET_KEY = "loreSettings";
export const ghUserKey = (repo: string) => "ghUser:" + repo;
export const authorNameKey = (repo: string) => "authorName:" + repo;

export const DEFAULT_SERVER = "lore://127.0.0.1:41337";

// Settings window: checkbox flags and text flags, mapped to their lore CLI flag.
export const SET_CHECKS = ["set-offline", "set-force", "set-dryrun", "set-cache", "set-gc", "set-syncdata", "set-searchnearest"];
export const SET_TEXTS = ["set-identity", "set-loglevel", "set-maxconn", "set-filecount", "set-filesize", "set-compress", "set-searchlimit"];
export const FLAG_OF: Record<string, string> = {
  "set-offline": "--offline", "set-force": "--force", "set-dryrun": "--dry-run",
  "set-cache": "--cache", "set-gc": "--gc", "set-syncdata": "--sync-data", "set-searchnearest": "--search-nearest",
  "set-identity": "--identity", "set-loglevel": "--log-level", "set-maxconn": "--max-connections",
  "set-filecount": "--file-count-limit", "set-filesize": "--file-size-limit",
  "set-compress": "--compress-limit", "set-searchlimit": "--search-limit",
};

export const LORE_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "repository", desc: "Repository commands" },
  { cmd: "branch", desc: "Branch commands" },
  { cmd: "revision", desc: "Revision commands" },
  { cmd: "file", desc: "File commands" },
  { cmd: "auth", desc: "Authentication commands" },
  { cmd: "layer", desc: "Layer commands" },
  { cmd: "logfile", desc: "Logfile commands" },
  { cmd: "login", desc: "Authenticate the CLI" },
  { cmd: "link", desc: "Link commands" },
  { cmd: "status", desc: "Show current repository status" },
  { cmd: "clone", desc: "Clone a remote repository into a path" },
  { cmd: "stage", desc: "Stage changes for commit" },
  { cmd: "dirty", desc: "Mark files as dirty so they show in status" },
  { cmd: "unstage", desc: "Unstage changes to a file or directory" },
  { cmd: "reset", desc: "Reset changes to a file or directory" },
  { cmd: "diff", desc: "Show differences between two revisions" },
  { cmd: "history", desc: "List revisions of a repository" },
  { cmd: "commit", desc: "Commit the staged revision" },
  { cmd: "sync", desc: "Synchronize to a repository state" },
  { cmd: "push", desc: "Push commits to remote" },
  { cmd: "lock", desc: "Lock file" },
  { cmd: "service", desc: "Manage the repository in a service process" },
  { cmd: "notification", desc: "Notifications" },
  { cmd: "completions", desc: "Generate terminal autocompletions" },
  { cmd: "shared-store", desc: "Manage the shared store" },
];

// ---- Pure helpers ----

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "my-project";
}

export function repoName(p: string): string {
  const cleaned = baseName(p).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "my-project";
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function shortDate(d: string): string {
  // "Wed, 17 Jun 2026 21:13:57 +0000" -> "17 Jun 2026"
  const m = d.match(/(\d{1,2} \w{3} \d{4})/);
  return m ? m[1] : d;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isLocalAddr(a: string): boolean {
  return a.includes("127.0.0.1") || a.includes("localhost");
}

export function portOf(addr: string): string {
  const m = addr.match(/:(\d+)/);
  return m ? m[1] : "";
}

export function getServerAddr(): string {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  const a = (saved.serveraddr as string) || "";
  return a.trim() || DEFAULT_SERVER;
}

// Persistent loreserver config dir (empty = temp/ephemeral storage).
export function getServerConfigDir(): string {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  return ((saved.serverConfigDir as string) || "").trim();
}
