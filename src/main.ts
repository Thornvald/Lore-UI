import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { mountPreview, previewKind, extOf } from "./preview";

// ---- Types mirror the Rust serde structs ----
interface FileChange { status: "A" | "M" | "D"; path: string; }
interface StatusInfo {
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
interface Branch { name: string; current: boolean; }
interface BranchList { local: Branch[]; remote: Branch[]; raw: string; }
interface RunResult { output: string; ok: boolean; }
interface FileMeta { size: number; exists: boolean; }
interface Commit {
  revision: string;
  signature: string;
  branch: string;
  date: string;
  message: string;
  is_merge: boolean;
}

// One file row in the changes list, before it is folded into the folder tree.
interface FileRow { change: FileChange; staged: boolean; }

// A node in the folder tree we build from flat file paths.
interface TreeNode {
  name: string;
  full: string;
  dir: boolean;
  children: Map<string, TreeNode>;
  payload?: unknown;
}

const STATUS_LABEL: Record<string, string> = { A: "New", M: "Changed", D: "Removed" };

const LORE_COMMANDS: { cmd: string; desc: string }[] = [
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

// ---- State ----
let repoPath = "";
let history: Commit[] = [];
let consoleOn = false;
// Cleanup for the live preview (image object URL / three.js context), if any.
let previewCleanup: (() => void) | null = null;
// This machine's LAN IP, fetched once for the server setup share line.
let setupLanIp: string | null | undefined = undefined;
// Last status, kept so sort/filter can re-render the list without re-fetching.
let lastStatus: StatusInfo | null = null;
let fileSort: "name" | "type" = "name";
let fileFilter = "";
// The repo's configured identity (email or name), for author avatars. One per
// repo - Lore records no per-commit author.
let repoIdentity = "";
// Cached avatar URL for the repo identity (GitHub or Gravatar), resolved once.
let avatarUrl: string | null = null;
// Optional GitHub username for this repo (UI-only, stored locally) - the most
// reliable way to show a real profile picture.
let repoGithubUser = "";
const ghUserKey = (repo: string) => "ghUser:" + repo;
// Diff display mode + the last diff text, so the toggle can re-render in place.
let diffMode: "unified" | "split" = localStorage.getItem("diffMode") === "split" ? "split" : "unified";
let lastDiffText = "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Invoke a Rust command; on error pop an alert and return null.
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  document.body.style.cursor = "progress";
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    alert(String(e));
    return null;
  } finally {
    document.body.style.cursor = "default";
  }
}

// ---- Project open / create ----
async function openProject() {
  closeAllPopovers();
  const picked = await open({ directory: true, title: "Open a Lore project folder" });
  if (!picked || typeof picked !== "string") return;
  const isRepo = await invoke<boolean>("lore_is_repo", { repo: picked });
  if (!isRepo) {
    alert("That folder is not a Lore project.\nPick a folder that has a .lore folder inside.");
    return;
  }
  await enterProject(picked);
}

async function createProject() {
  closeAllPopovers();
  const picked = await open({ directory: true, title: "Pick an empty folder for the new project" });
  if (!picked || typeof picked !== "string") return;
  if (await invoke<boolean>("lore_is_repo", { repo: picked })) {
    alert("That folder is already a Lore project. Use Open instead.");
    return;
  }
  const name = repoName(picked);
  const url = await askText(
    "Server address for the new project",
    "lore://HOST:PORT/name  -  the name (after the last /) must have no spaces",
    `${getServerAddr()}/${name}`
  );
  if (!url) return;
  try {
    await invoke<string>("lore_create_repo", { path: picked, url: url.trim() });
    await enterProject(picked);
  } catch (e) {
    alert("Could not create the project.\n\n" + String(e));
  }
}

// ---- Known (recent) projects ----
const RECENT_KEY = "recentProjects";
function recentProjects(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}
function addRecentProject(path: string) {
  const list = recentProjects().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
}
function renderRecent() {
  const ul = $("recent-list") as HTMLUListElement;
  ul.innerHTML = "";
  const list = recentProjects();
  ul.classList.toggle("hidden", list.length === 0);
  for (const p of list) {
    const li = document.createElement("li");
    li.className = "recent-item" + (p === repoPath ? " current" : "");
    li.title = p;
    const nm = document.createElement("span"); nm.className = "recent-name"; nm.textContent = baseName(p);
    const pa = document.createElement("span"); pa.className = "recent-path"; pa.textContent = p;
    li.append(nm, pa);
    li.addEventListener("click", () => { closeAllPopovers(); openKnownProject(p); });
    ul.appendChild(li);
  }
}
async function openKnownProject(path: string) {
  if (path === repoPath) return;
  const ok = await invoke<boolean>("lore_is_repo", { repo: path }).catch(() => false);
  if (!ok) {
    alert("That project is not available (folder missing or not a Lore project). Removing it from the list.");
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects().filter((p) => p !== path)));
    renderRecent();
    return;
  }
  await enterProject(path);
}

async function enterProject(path: string) {
  repoPath = path;
  localStorage.setItem("repoPath", repoPath);
  addRecentProject(path);
  repoIdentity = await invoke<string>("lore_identity", { repo: path }).catch(() => "");
  repoGithubUser = localStorage.getItem(ghUserKey(path)) || "";
  avatarUrl = null; // re-resolve the avatar for this repo's identity
  $("proj-name").textContent = baseName(path);
  $("proj-path").textContent = path;
  $("empty").classList.add("hidden");
  $("app").classList.remove("hidden");
  clearDetail();
  await refreshAll();
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "my-project";
}
function repoName(p: string): string {
  const cleaned = baseName(p).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "my-project";
}

// ---- Refresh ----
async function refreshAll() {
  await refreshStatus();
  await refreshBranches();
  if (!$("pane-history").classList.contains("hidden")) await loadHistory();
}

async function refreshStatus() {
  const s = await call<StatusInfo>("lore_status", { repo: repoPath });
  if (s) { lastStatus = s; renderStatus(s); }
}

// ---- Folder tree (shared by Changes and commit file lists) ----
// Fork-style: fold flat "a/b/file" paths into collapsible folders.
function buildTree(items: { path: string; payload: unknown }[]): TreeNode {
  const root: TreeNode = { name: "", full: "", dir: true, children: new Map() };
  for (const it of items) {
    const parts = it.path.split(/[\\/]/).filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, full: parts.slice(0, i + 1).join("/"), dir: !leaf, children: new Map() };
        node.children.set(part, child);
      }
      if (leaf) { child.dir = false; child.payload = it.payload; }
      node = child;
    });
  }
  return root;
}

function sortKids(node: TreeNode): TreeNode[] {
  // Folders first, then files - by name, or by extension when "type" is picked.
  return [...node.children.values()].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (fileSort === "type" && !a.dir && !b.dir) {
      const ea = extOf(a.name), eb = extOf(b.name);
      if (ea !== eb) return ea.localeCompare(eb);
    }
    return a.name.localeCompare(b.name);
  });
}

const indent = (depth: number) => depth * 14 + 8 + "px";

function renderTree(
  parent: HTMLElement,
  node: TreeNode,
  depth: number,
  fileRow: (n: TreeNode, depth: number) => HTMLElement,
) {
  for (const k of sortKids(node)) {
    if (!k.dir) { parent.appendChild(fileRow(k, depth)); continue; }
    const row = document.createElement("div");
    row.className = "tree-folder";
    row.style.paddingLeft = indent(depth);
    const caret = document.createElement("span"); caret.className = "tree-caret"; caret.textContent = "▾";
    const name = document.createElement("span"); name.className = "tree-folder-name"; name.textContent = k.name;
    row.append(caret, name);
    const box = document.createElement("div"); box.className = "tree-children";
    row.addEventListener("click", () => {
      const collapsed = row.classList.toggle("collapsed");
      box.classList.toggle("hidden", collapsed);
      caret.textContent = collapsed ? "▸" : "▾";
    });
    parent.append(row, box);
    renderTree(box, k, depth + 1, fileRow);
  }
}

function statusTag(status: string): HTMLSpanElement {
  const tag = document.createElement("span");
  tag.className = "tag tag-" + status;
  tag.title = STATUS_LABEL[status] ?? status;
  tag.textContent = status;
  return tag;
}

// A file row inside the Changes tree: checkbox, status tag, name, discard.
function changesFileRow(node: TreeNode, depth: number): HTMLElement {
  const r = node.payload as FileRow;
  const row = document.createElement("div");
  row.className = "tree-file";
  row.dataset.path = r.change.path;
  row.style.paddingLeft = indent(depth);

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "file-check";
  cb.dataset.path = r.change.path;
  cb.checked = true; // select everything by default so commit is one click
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", onFileCheckChange);

  const nm = document.createElement("span");
  nm.className = "tree-file-name";
  nm.textContent = node.name;
  nm.title = r.change.path;

  const discard = document.createElement("button");
  discard.className = "row-x";
  discard.title = "Discard changes to this file";
  discard.textContent = "⨯";
  discard.addEventListener("click", (e) => { e.stopPropagation(); discardFiles([r.change.path]); });

  row.append(cb, statusTag(r.change.status), fileVisual(r.change.path), nm, discard);

  row.addEventListener("click", () => showWorkingFile(r.change.path));
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, fileMenu(r.change.path)); });
  return row;
}

// Leading visual for a file row: a real thumbnail for pictures and Unreal
// assets, a small kind glyph for everything else - so every file shows
// something next to its name.
function fileVisual(path: string): HTMLElement {
  const kind = previewKind(path);
  if (kind === "image") { const img = thumbImg(); attachThumb(img, path); return img; }
  if (kind === "uasset") { const img = thumbImg(); attachUassetThumb(img, path); return img; }
  const ic = document.createElement("span");
  ic.className = "row-icon";
  ic.textContent = kindGlyph(kind);
  return ic;
}
function thumbImg(): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "row-thumb";
  return img;
}
function kindGlyph(kind: string): string {
  switch (kind) {
    case "model": return "◈";
    case "audio": return "♪";
    case "texture": return "▦";
    case "blend": return "◆";
    case "binary": return "▥";
    default: return "≡";
  }
}
// Load a small inline thumbnail for an image row (skips big/missing files so a
// 4K texture does not get read just to draw a 20px square).
async function attachThumb(img: HTMLImageElement, path: string) {
  try {
    const meta = await invoke<FileMeta>("file_meta", { repo: repoPath, path });
    if (!meta.exists || meta.size > 4 * 1024 * 1024) return;
    const buf = await invoke<ArrayBuffer>("read_file_bytes", { repo: repoPath, path });
    const url = URL.createObjectURL(new Blob([buf]));
    img.onload = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    img.classList.add("loaded");
  } catch { /* no thumbnail - leave the placeholder */ }
}
// Same idea for an Unreal .uasset/.umap: use its extracted embedded thumbnail.
async function attachUassetThumb(img: HTMLImageElement, path: string) {
  try {
    const meta = await invoke<FileMeta>("file_meta", { repo: repoPath, path });
    if (!meta.exists || meta.size > 64 * 1024 * 1024) return;
    const buf = await invoke<ArrayBuffer>("read_uasset_thumb", { repo: repoPath, path });
    const url = URL.createObjectURL(new Blob([buf]));
    img.onload = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    img.classList.add("loaded");
  } catch { /* no embedded thumbnail */ }
}

// Keep the master checkbox honest: checked only when every file is checked,
// indeterminate when some are.
function onFileCheckChange() { updateCommitButton(); syncMasterCheck(); }
function syncMasterCheck() {
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#file-list .file-check")];
  const checked = boxes.filter((b) => b.checked).length;
  const master = $("check-all") as HTMLInputElement;
  master.checked = boxes.length > 0 && checked === boxes.length;
  master.indeterminate = checked > 0 && checked < boxes.length;
}

// A file row inside a commit's changed-files tree (no checkbox/discard).
// Clicking shows the line diff, or a preview for pictures/models still on disk.
function commitFileRow(f: FileChange, name: string, depth: number, source: string, target: string, box: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "tree-file";
  row.dataset.path = f.path;
  row.style.paddingLeft = indent(depth);
  const nm = document.createElement("span");
  nm.className = "tree-file-name";
  nm.textContent = name;
  nm.title = f.path;
  row.append(statusTag(f.status), fileVisual(f.path), nm);
  row.addEventListener("click", async () => {
    box.querySelectorAll(".tree-file").forEach((r) => r.classList.remove("active"));
    row.classList.add("active");
    // A deleted file has nothing to preview; previewable files that still exist
    // on disk get a real preview (of the current file, labelled as such).
    const k = previewKind(f.path);
    const previewable = k === "image" || k === "texture" || k === "model" || k === "audio" || k === "uasset" || k === "blend";
    if (previewable && f.status !== "D") {
      const meta = await call<FileMeta>("file_meta", { repo: repoPath, path: f.path });
      if (meta && meta.exists) {
        if (k === "uasset") await showUassetPreview(f.path);
        else if (k === "blend") await showBlendPreview(f.path);
        else await showPreview(f.path, "current file on disk");
        return;
      }
    }
    showDiffView();
    const text = await call<string>("lore_commit_file_diff", { repo: repoPath, source, target, path: f.path });
    renderDiff(text ?? "Could not load diff.");
  });
  return row;
}

function renderStatus(s: StatusInfo) {
  // sync button
  const sync = s.sync_state || "";
  const title = $("sync-title");
  const sub = $("sync-sub");
  if (sync.includes("ahead")) { title.textContent = "Push"; sub.textContent = "send your commits"; }
  else if (sync.includes("behind")) { title.textContent = "Get latest"; sub.textContent = "behind remote"; }
  else { title.textContent = "Get latest"; sub.textContent = "up to date"; }

  $("commit-branch").textContent = s.branch || "main";

  // Conflict banner appears while a merge is mid-resolution.
  const banner = $("conflict-banner");
  if (s.conflicts.length > 0) {
    banner.classList.remove("hidden");
    banner.innerHTML = "";
    const txt = document.createElement("span");
    txt.textContent = `${s.conflicts.length} conflict${s.conflicts.length > 1 ? "s" : ""} to resolve`;
    const btn = document.createElement("button");
    btn.className = "primary small"; btn.textContent = "Resolve";
    btn.addEventListener("click", openResolve);
    banner.append(txt, btn);
  } else {
    banner.classList.add("hidden");
  }

  const rows: FileRow[] = [];
  for (const c of s.staged) rows.push({ change: c, staged: true });
  for (const c of s.unstaged) rows.push({ change: c, staged: false });
  for (const c of s.untracked) rows.push({ change: c, staged: false });

  const tokens = fileFilter.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const shown = rows.filter((r) => passesFilter(r.change.path, tokens));

  const list = $("file-list");
  list.innerHTML = "";
  const tree = buildTree(shown.map((r) => ({ path: r.change.path, payload: r })));
  renderTree(list, tree, 0, changesFileRow);

  const total = rows.length;
  let label: string;
  if (total === 0) label = "No changes";
  else if (shown.length === total) label = `${total} changed file${total > 1 ? "s" : ""}`;
  else label = `${shown.length} of ${total} shown`;
  $("changes-count").textContent = label;

  const navCount = $("nav-changes-count");
  navCount.textContent = String(total);
  navCount.classList.toggle("hidden", total === 0);

  updateCommitButton();
  syncMasterCheck();
}

// A path passes when there is no filter, or its extension equals one of the
// tokens, or the path simply contains a token (so "char" or ".uasset" both work).
function passesFilter(path: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const ext = extOf(path);
  const low = path.toLowerCase();
  return tokens.some((t) => {
    const clean = t.startsWith(".") ? t.slice(1) : t;
    return ext === clean || low.includes(t);
  });
}

// Re-render the changes list from the last fetched status (sort/filter changed).
function rerenderChanges() {
  if (lastStatus) renderStatus(lastStatus);
}

function pickedFiles(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(".file-check:checked"))
    .map((b) => b.dataset.path!)
    .filter(Boolean);
}

function updateCommitButton() {
  const has = pickedFiles().length > 0;
  const msg = ($("commit-msg") as HTMLInputElement).value.trim().length > 0;
  ($("save-btn") as HTMLButtonElement).disabled = !(has && msg);
}

// ---- Branches ----
async function refreshBranches() {
  const bl = await call<BranchList>("lore_branches", { repo: repoPath });
  if (!bl) return;
  const current = bl.local.find((b) => b.current);
  $("branch-name").textContent = current ? current.name : "—";

  // branch popover list
  const ul = $("branch-list-menu") as HTMLUListElement;
  ul.innerHTML = "";
  for (const b of bl.local) {
    const li = document.createElement("li");
    li.className = "popover-list-item" + (b.current ? " current" : "");
    li.textContent = b.name;
    li.addEventListener("click", () => { closeAllPopovers(); if (!b.current) switchBranch(b.name); });
    ul.appendChild(li);
  }

  // merge source options (other branches)
  const merge = $("merge-source") as HTMLSelectElement;
  merge.innerHTML = "";
  for (const b of bl.local.filter((x) => !x.current)) {
    const opt = document.createElement("option");
    opt.value = b.name; opt.textContent = b.name;
    merge.appendChild(opt);
  }

  // Left nav: local branches (click = switch, right-click = operations).
  const navB = $("nav-branches") as HTMLUListElement;
  navB.innerHTML = "";
  for (const b of bl.local) {
    const li = document.createElement("li");
    li.className = "nav-list-item" + (b.current ? " current" : "");
    li.textContent = b.name;
    li.title = b.name;
    li.addEventListener("click", () => { if (!b.current) switchBranch(b.name); });
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, branchMenu(b)); });
    navB.appendChild(li);
  }

  // Left nav: remote branches (display only - Lore tracks these on the server).
  const navR = $("nav-remotes") as HTMLUListElement;
  navR.innerHTML = "";
  for (const b of bl.remote) {
    const li = document.createElement("li");
    li.className = "nav-list-item remote";
    li.textContent = b.name;
    li.title = b.name;
    navR.appendChild(li);
  }
  if (bl.remote.length === 0) {
    const li = document.createElement("li");
    li.className = "nav-empty muted small";
    li.textContent = "none";
    navR.appendChild(li);
  }
}

async function switchBranch(name: string) {
  const out = await call<string>("lore_switch_branch", { repo: repoPath, name });
  if (out !== null) { clearDetail(); await refreshAll(); }
}

async function newBranch() {
  closeAllPopovers();
  const name = await askText("Name for the new branch", "Letters, numbers, dashes.");
  if (!name) return;
  const out = await call<string>("lore_create_branch", { repo: repoPath, name: name.trim() });
  if (out !== null) await refreshBranches();
}

// ---- Commit / sync ----
async function save() {
  const files = pickedFiles();
  const msg = ($("commit-msg") as HTMLInputElement).value.trim();
  if (files.length === 0 || !msg) return;
  if ((await call<string>("lore_stage", { repo: repoPath, files })) === null) return;
  if ((await call<string>("lore_commit", { repo: repoPath, message: msg })) === null) return;
  ($("commit-msg") as HTMLInputElement).value = "";
  clearDetail();
  await refreshAll();
}

async function syncAction() {
  const title = $("sync-title").textContent || "";
  const cmd = title === "Push" ? "lore_push" : "lore_sync";
  const out = await call<string>(cmd, { repo: repoPath });
  if (out !== null) await refreshAll();
}

// ---- Discard ----
async function discardFiles(files: string[]) {
  if (files.length === 0) return;
  const what = files.length === 1 ? `"${files[0]}"` : `${files.length} files`;
  if (!confirm(`Discard changes to ${what}? This cannot be undone.`)) return;
  const out = await call<string>("lore_discard", { repo: repoPath, files });
  if (out !== null) { clearDetail(); await refreshStatus(); }
}

async function discardAll() {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>(".file-check"))
    .map((b) => b.dataset.path!)
    .filter(Boolean);
  await discardFiles(all);
}

// ---- Working file view (Changes tab): preview or text diff ----
async function showWorkingFile(path: string) {
  showDetail(baseName(path), "Working changes");
  $("detail-files").classList.add("hidden");
  highlightFile(path);
  const kind = previewKind(path);
  // Unreal assets try their embedded thumbnail; other binaries get an info card;
  // text files keep the line diff (unless lore reports it is binary); pictures,
  // HDR textures, models and audio get a real preview.
  if (kind === "uasset") { await showUassetPreview(path); return; }
  if (kind === "blend") { await showBlendPreview(path); return; }
  if (kind === "binary") { await showInfoCard(path); return; }
  if (kind === "other") {
    const text = await call<string>("lore_diff", { repo: repoPath, path });
    if (text && /binary files differ/i.test(text)) { await showInfoCard(path); return; }
    showDiffView();
    renderDiff(text ?? "Could not load changes.");
    return;
  }
  await showPreview(path);
}

// Unreal .uasset/.umap: show the embedded editor thumbnail if the asset has one,
// otherwise fall back to the info card. Real mesh/texture rendering needs the
// engine, which a web view cannot do.
async function showUassetPreview(path: string) {
  disposePreview();
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  const host = $("detail-preview");
  host.classList.remove("hidden");
  host.innerHTML = `<div class="preview-msg muted">Reading asset…</div>`;
  const caption = $("preview-caption");
  caption.classList.remove("hidden");
  caption.textContent = "Loading…";

  let bytes: ArrayBuffer | null = null;
  try { bytes = await invoke<ArrayBuffer>("read_uasset_thumb", { repo: repoPath, path }); } catch { bytes = null; }
  if (bytes && bytes.byteLength > 0) {
    host.innerHTML = "";
    const res = await mountPreview(host, bytes, "thumbnail.png");
    previewCleanup = res.cleanup;
    caption.textContent = ["Unreal asset - embedded thumbnail", res.info].filter(Boolean).join("  ·  ");
    return;
  }
  await showInfoCard(path);
}

// Cache converted glb per .blend (by path + size) so re-opening is instant.
const glbCache = new Map<string, ArrayBuffer>();
// .blend: convert to glb with a headless Blender, then show it in the same 3D
// viewer as an FBX (real geometry). The first conversion takes a few seconds.
async function showBlendPreview(path: string) {
  disposePreview();
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  const host = $("detail-preview");
  host.classList.remove("hidden");
  const caption = $("preview-caption");
  caption.classList.remove("hidden");

  const meta = await call<FileMeta>("file_meta", { repo: repoPath, path });
  const key = path + ":" + (meta?.size ?? 0);
  let glb = glbCache.get(key);
  if (!glb) {
    host.innerHTML = `<div class="preview-msg muted">Converting with Blender…<br><span class="small">first time can take a few seconds</span></div>`;
    caption.textContent = "Converting…";
    try {
      glb = await invoke<ArrayBuffer>("blend_to_glb", { repo: repoPath, path });
      glbCache.set(key, glb);
    } catch (e) {
      host.innerHTML = `<div class="preview-msg muted">Could not show this .blend in 3D.<br><span class="small">${String(e)}</span></div>`;
      caption.classList.add("hidden");
      return;
    }
  }
  host.innerHTML = "";
  const res = await mountPreview(host, glb, "model.glb");
  previewCleanup = res.cleanup;
  caption.textContent = [res.info, humanSize(glb.byteLength)].filter(Boolean).join("  ·  ");
}

// Honest fallback for binary files we cannot draw (Unreal .uasset, .blend, ...).
async function showInfoCard(path: string) {
  disposePreview();
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  const host = $("detail-preview");
  host.classList.remove("hidden");
  const caption = $("preview-caption");
  caption.classList.remove("hidden");
  caption.textContent = path;
  const meta = await call<FileMeta>("file_meta", { repo: repoPath, path });
  const ext = (extOf(path) || "file").toUpperCase();
  host.innerHTML =
    `<div class="preview-msg muted"><div class="info-ext">${ext}</div>` +
    `${humanSize(meta?.size ?? 0)}<br><span class="small">${engineHint(extOf(path))}</span></div>`;
}
function engineHint(ext: string): string {
  if (ext === "uasset" || ext === "umap") return "Unreal asset - inline preview needs the editor (thumbnail extraction is a possible future step).";
  if (ext === "blend") return "Blender file - no inline preview in a web view.";
  if (ext === "spine") return "Spine project - no inline preview yet.";
  return "No inline preview for this file type yet.";
}

// Show an image / 3D model preview of a working-tree file.
async function showPreview(path: string, captionExtra = "") {
  disposePreview();
  const host = $("detail-preview");
  const caption = $("preview-caption");
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  host.classList.remove("hidden");
  host.innerHTML = `<div class="preview-msg muted">Loading preview…</div>`;
  caption.classList.remove("hidden");
  caption.textContent = "Loading…";

  let bytes: ArrayBuffer;
  try {
    bytes = await invoke<ArrayBuffer>("read_file_bytes", { repo: repoPath, path });
  } catch (e) {
    host.innerHTML = `<div class="preview-msg muted">No preview.<br><span class="small">${String(e)}</span></div>`;
    caption.classList.add("hidden");
    return;
  }
  host.innerHTML = "";
  const res = await mountPreview(host, bytes, path);
  previewCleanup = res.cleanup;
  const parts = [res.info, humanSize(bytes.byteLength)];
  if (captionExtra) parts.push(captionExtra);
  caption.textContent = parts.filter(Boolean).join("  ·  ");
}

function showDiffView() {
  disposePreview();
  $("detail-preview").classList.add("hidden");
  $("preview-caption").classList.add("hidden");
  $("detail-diff").classList.remove("hidden");
}

function disposePreview() {
  if (previewCleanup) { try { previewCleanup(); } catch { /* ignore cleanup errors */ } previewCleanup = null; }
  $("detail-preview").innerHTML = "";
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- History ----
async function loadHistory() {
  const h = await call<Commit[]>("lore_history", { repo: repoPath });
  if (!h) return;
  history = h;
  const box = $("history-list");
  box.innerHTML = "";
  $("history-head").textContent = h.length ? `History · ${h.length} revisions` : "History";
  h.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "gh-commit";
    row.dataset.idx = String(i);

    // Graph rail: a dot on a single lane, with a connecting line drawn in CSS.
    const rail = document.createElement("div");
    rail.className = "commit-rail";
    const dot = document.createElement("span");
    dot.className = "commit-dot" + (c.is_merge ? " merge" : "");
    const col = branchColor(c.branch);
    if (c.is_merge) dot.style.borderColor = col; else dot.style.background = col;
    rail.appendChild(dot);

    const body = document.createElement("div");
    body.className = "commit-body";
    const subject = document.createElement("div");
    subject.className = "gh-commit-subject";
    subject.textContent = c.message.split("\n")[0] || "(no message)";
    const meta = document.createElement("div");
    meta.className = "gh-commit-meta muted small";
    meta.append(authorAvatar(), document.createTextNode(
      `${c.is_merge ? "merge · " : ""}rev ${c.revision} · ${shortDate(c.date)}`
    ));
    body.append(subject, meta);

    row.append(rail, body);
    row.addEventListener("click", () => showCommit(i));
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, commitMenu(c, i)); });
    box.appendChild(row);
  });
}

// A consistent avatar for the repo's committer. Lore records no per-commit
// author, so every commit shows the same repo identity (no more random colour
// per commit). With an email identity we pull a Gravatar - which serves its own
// identicon when there is no photo; otherwise a local initials chip.
function authorAvatar(): HTMLElement {
  const el = document.createElement("span");
  el.className = "avatar";
  const id = repoIdentity.trim();
  const gh = repoGithubUser.trim();
  const seed = gh || id || "anonymous";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  el.style.background = `hsl(${hash % 360} 30% 38%)`;
  el.textContent = (gh || id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  // A GitHub username is the most reliable photo; else try the email's avatar.
  if (gh) {
    setAvatarImage(el, `https://github.com/${encodeURIComponent(gh)}.png?size=48`);
  } else if (id.includes("@")) {
    resolveAvatarUrl(id).then((url) => setAvatarImage(el, url)).catch(() => {});
  }
  return el;
}
function setAvatarImage(el: HTMLElement, url: string) {
  const probe = new Image();
  probe.onload = () => { el.style.backgroundImage = `url(${url})`; el.style.backgroundSize = "cover"; el.textContent = ""; };
  probe.src = url; // on error, keep the initials chip
}
// Pick the avatar URL for an email, once per repo (cached). Prefer a GitHub
// account with that public email; fall back to Gravatar (which serves its own
// identicon when there is no photo).
async function resolveAvatarUrl(email: string): Promise<string> {
  if (avatarUrl) return avatarUrl;
  try {
    const res = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const data = await res.json();
      const url: string | undefined = data?.items?.[0]?.avatar_url;
      if (url) { avatarUrl = url + (url.includes("?") ? "&" : "?") + "s=48"; return avatarUrl; }
    }
  } catch { /* offline or rate-limited - fall through to Gravatar */ }
  avatarUrl = await gravatarUrl(email);
  return avatarUrl;
}
async function gravatarUrl(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `https://www.gravatar.com/avatar/${hex}?d=identicon&s=48`;
}
// Steady colour per branch id, to tell branches apart in the history graph.
function branchColor(branch: string): string {
  if (!branch) return "var(--ink-2)";
  let h = 0;
  for (let i = 0; i < branch.length; i++) h = (h * 31 + branch.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 58%)`;
}

async function showCommit(i: number) {
  const c = history[i];
  const parent = history[i + 1]; // older commit, or undefined for the first
  document.querySelectorAll(".gh-commit").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.idx === String(i))
  );

  showDetail(c.message.split("\n")[0] || "(no message)", `rev ${c.revision} · ${c.date}`);

  // actions: Revert (quick) + More… (full revision/branch operations menu).
  const actions = $("detail-actions");
  actions.innerHTML = "";
  const revert = document.createElement("button");
  revert.className = "ghost small";
  revert.textContent = "Revert";
  revert.addEventListener("click", () => revertCommit(c));
  const more = document.createElement("button");
  more.className = "ghost small";
  more.textContent = "More…";
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 4, commitMenu(c, i));
  });
  actions.append(revert, more);

  // changed files in this commit (needs a parent to diff against)
  const filesBox = $("detail-files");
  $("detail-diff").textContent = "";
  if (!parent) {
    filesBox.classList.remove("hidden");
    filesBox.innerHTML = `<div class="muted small">First commit - base revision, file list not shown.</div>`;
    return;
  }
  filesBox.classList.remove("hidden");
  filesBox.innerHTML = `<div class="muted small">Loading changed files…</div>`;
  const files = await call<FileChange[]>("lore_commit_files", {
    repo: repoPath, source: parent.signature, target: c.signature,
  });
  filesBox.innerHTML = "";
  if (!files || files.length === 0) {
    filesBox.innerHTML = `<div class="muted small">No file changes.</div>`;
    return;
  }
  const tree = buildTree(files.map((f) => ({ path: f.path, payload: f })));
  renderTree(filesBox, tree, 0, (node, depth) =>
    commitFileRow(node.payload as FileChange, node.name, depth, parent.signature, c.signature, filesBox)
  );
}

async function revertCommit(c: Commit) {
  const subject = c.message.split("\n")[0];
  if (!confirm(`Revert commit "${subject}"?\nThis adds a new commit that undoes it.`)) return;
  const out = await call<string>("lore_revert_commit", {
    repo: repoPath, revision: c.signature, message: `Revert: ${subject}`,
  });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

async function undoCommit(parent: Commit) {
  if (!confirm("Undo the latest commit? It is removed and the working tree resets to the previous commit.")) return;
  const out = await call<string>("lore_undo_commit", { repo: repoPath, revision: parent.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

// ---- Context menu (commits + branches) ----
interface CtxItem { label?: string; danger?: boolean; sep?: boolean; run?: () => void; }

function openContextMenu(x: number, y: number, items: CtxItem[]) {
  closeAllPopovers();
  const menu = $("ctx-menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "popover-divider";
      menu.appendChild(d);
      continue;
    }
    const b = document.createElement("button");
    b.className = "popover-item" + (it.danger ? " danger" : "");
    b.textContent = it.label ?? "";
    b.addEventListener("click", () => { closeAllPopovers(); it.run?.(); });
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  // Keep the menu inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}

function commitMenu(c: Commit, i: number): CtxItem[] {
  const isLatest = i === 0;
  const parent = history[i + 1];
  const items: CtxItem[] = [
    { label: "Sync working tree to here", run: () => syncToRevision(c) },
    { label: "Create branch here…", run: () => createBranchAt(c) },
    { label: "Reset current branch to here", danger: true, run: () => resetBranchTo(c) },
    { sep: true },
    { label: "Cherry-pick onto current", run: () => cherryPick(c) },
    { label: "Revert this revision", run: () => revertCommit(c) },
  ];
  if (isLatest) items.push({ label: "Amend message…", run: () => amendLatest(c) });
  if (isLatest && parent) items.push({ label: "Undo (remove this commit)", danger: true, run: () => undoCommit(parent) });
  items.push({ sep: true });
  items.push({ label: "Revision info", run: () => revisionInfo(c) });
  items.push({ label: "Copy revision id", run: () => navigator.clipboard?.writeText(c.signature) });
  return items;
}

function branchMenu(b: Branch): CtxItem[] {
  const items: CtxItem[] = [];
  if (!b.current) {
    items.push({ label: "Switch to this branch", run: () => switchBranch(b.name) });
    items.push({ label: "Merge into current…", run: () => openMergeFor(b.name) });
  }
  items.push({ label: "Push branch", run: () => branchPush(b.name) });
  items.push({ label: "Branch info", run: () => branchInfo(b.name) });
  items.push({ sep: true });
  items.push({ label: "Protect", run: () => branchProtect(b.name, true) });
  items.push({ label: "Unprotect", run: () => branchProtect(b.name, false) });
  if (!b.current) {
    items.push({ sep: true });
    items.push({ label: "Archive (remove) branch", danger: true, run: () => branchArchive(b.name) });
  }
  return items;
}

// ---- Revision ops ----
async function syncToRevision(c: Commit) {
  if (!confirm(`Sync the working tree to revision ${c.revision}? Local changes may be affected.`)) return;
  const out = await call<string>("lore_revision_sync", { repo: repoPath, revision: c.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}
async function createBranchAt(c: Commit) {
  const name = await askText("New branch name", "The branch is created at the selected revision.");
  if (!name) return;
  const out = await call<string>("lore_branch_create_at", { repo: repoPath, name: name.trim(), revision: c.signature });
  if (out !== null) await refreshBranches();
}
async function resetBranchTo(c: Commit) {
  if (!confirm(`Move the current branch to revision ${c.revision}? This rewrites local history after it.`)) return;
  const out = await call<string>("lore_branch_reset", { repo: repoPath, revision: c.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}
async function cherryPick(c: Commit) {
  if (!confirm(`Cherry-pick revision ${c.revision} onto the current revision?`)) return;
  const out = await call<string>("lore_revision_cherry_pick", { repo: repoPath, revision: c.signature });
  if (out !== null) { warnIfConflict(out); clearDetail(); await refreshAll(); await loadHistory(); }
}
async function amendLatest(c: Commit) {
  const msg = await askText("New message for the latest commit", "", c.message.split("\n")[0]);
  if (!msg) return;
  const out = await call<string>("lore_revision_amend", { repo: repoPath, message: msg.trim() });
  if (out !== null) { await refreshAll(); await loadHistory(); }
}
async function revisionInfo(c: Commit) {
  const out = await call<string>("lore_revision_info", { repo: repoPath, revision: c.signature });
  if (out !== null) showTextDetail(`Revision ${c.revision}`, c.signature, out);
}

// ---- Branch ops ----
async function branchPush(name: string) {
  const out = await call<string>("lore_branch_push", { repo: repoPath, name });
  if (out !== null) await refreshAll();
}
async function branchInfo(name: string) {
  const out = await call<string>("lore_branch_info", { repo: repoPath, name });
  if (out !== null) showTextDetail(`Branch ${name}`, "", out);
}
async function branchProtect(name: string, on: boolean) {
  const out = await call<string>("lore_branch_protect", { repo: repoPath, name, protect: on });
  if (out !== null) await refreshBranches();
}
async function branchArchive(name: string) {
  if (!confirm(`Archive (remove) branch "${name}"? This cannot be undone here.`)) return;
  const out = await call<string>("lore_branch_archive", { repo: repoPath, name });
  if (out !== null) { await refreshBranches(); if (!$("pane-history").classList.contains("hidden")) loadHistory(); }
}
function openMergeFor(name: string) {
  openMergeModal();
  const sel = $("merge-source") as HTMLSelectElement;
  if ([...sel.options].some((o) => o.value === name)) sel.value = name;
}
function warnIfConflict(out: string) {
  if (/conflict/i.test(out)) {
    alert("This left conflicts. For now, resolve or abort it from the Console (the resolve / abort subcommands).");
  }
}

// Show plain command text (revision / branch info / lock status) in the detail pane.
function showTextDetail(title: string, sub: string, text: string) {
  showDetail(title, sub);
  $("detail-files").classList.add("hidden");
  showDiffView();
  $("diff-toolbar").classList.add("hidden");
  const out = $("detail-diff");
  out.classList.remove("split");
  out.textContent = text;
}

// ---- File ops (right-click a changed file) ----
function fileMenu(path: string): CtxItem[] {
  return [
    { label: "Lock file", run: () => lockFile(path, true) },
    { label: "Unlock file", run: () => lockFile(path, false) },
    { label: "Lock status", run: () => lockStatus(path) },
    { sep: true },
    { label: "Discard changes", danger: true, run: () => discardFiles([path]) },
    { label: "Copy path", run: () => navigator.clipboard?.writeText(path) },
  ];
}
async function lockFile(path: string, lock: boolean) {
  const out = await call<string>(lock ? "lore_lock_acquire" : "lore_lock_release", { repo: repoPath, path });
  if (out !== null) alert(out.trim() || (lock ? "Locked." : "Unlocked."));
}
async function lockStatus(path: string) {
  const out = await call<string>("lore_lock_status", { repo: repoPath, path });
  if (out !== null) showTextDetail("Lock status", path, out.trim() || "No lock information.");
}

function shortDate(d: string): string {
  // "Wed, 17 Jun 2026 21:13:57 +0000" -> "17 Jun 2026"
  const m = d.match(/(\d{1,2} \w{3} \d{4})/);
  return m ? m[1] : d;
}

// ---- Detail pane helpers ----
function showDetail(title: string, sub: string) {
  $("detail-empty").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("detail-title").textContent = title;
  $("detail-sub").textContent = sub;
  $("detail-actions").innerHTML = "";
}
function clearDetail() {
  disposePreview();
  $("detail").classList.add("hidden");
  $("detail-empty").classList.remove("hidden");
  $("detail-diff").textContent = "";
  $("detail-diff").classList.remove("hidden", "split");
  $("detail-files").classList.add("hidden");
  $("detail-preview").classList.add("hidden");
  $("preview-caption").classList.add("hidden");
  $("diff-toolbar").classList.add("hidden");
}
function highlightFile(path: string) {
  document.querySelectorAll("#file-list .tree-file").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.path === path)
  );
}
// Render the diff in the current mode (unified or side-by-side) and reveal the
// toggle. Keeps the text so the toggle can re-render without re-fetching.
function renderDiff(text: string) {
  lastDiffText = text;
  $("diff-toolbar").classList.remove("hidden");
  ($("diff-mode") as HTMLElement).textContent = diffMode === "split" ? "Unified" : "Side by side";
  if (diffMode === "split") renderDiffSplit(text);
  else renderDiffUnified(text);
}
function renderDiffUnified(text: string) {
  const out = $("detail-diff") as HTMLPreElement;
  out.classList.remove("split");
  out.innerHTML = "";
  for (const line of text.split("\n")) {
    const span = document.createElement("span");
    span.className = "dl " + diffLineClass(line);
    span.textContent = line + "\n";
    out.appendChild(span);
  }
}
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "dl-meta";
  if (line.startsWith("+")) return "dl-add";
  if (line.startsWith("-")) return "dl-del";
  return "dl-ctx";
}

// ---- Side-by-side diff ----
interface SbsRow { type: "ctx" | "add" | "del" | "chg" | "meta"; oldNum?: number; newNum?: number; oldText?: string; newText?: string; }
// Turn a unified diff into aligned old/new rows. Runs of removals and additions
// are paired so a change shows old on the left, new on the right.
function parseSideBySide(text: string): SbsRow[] {
  const rows: SbsRow[] = [];
  const lines = text.split("\n");
  let oldN = 0, newN = 0, i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldN = parseInt(m[1], 10); newN = parseInt(m[2], 10); }
      rows.push({ type: "meta", oldText: line });
      i++; continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      rows.push({ type: "meta", oldText: line }); i++; continue;
    }
    if ((line.startsWith("-") && !line.startsWith("---")) || (line.startsWith("+") && !line.startsWith("+++"))) {
      const dels: string[] = [], adds: string[] = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) { dels.push(lines[i].slice(1)); i++; }
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) { adds.push(lines[i].slice(1)); i++; }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k], a = adds[k];
        const row: SbsRow = { type: d !== undefined && a !== undefined ? "chg" : d !== undefined ? "del" : "add" };
        if (d !== undefined) { row.oldText = d; row.oldNum = oldN++; }
        if (a !== undefined) { row.newText = a; row.newNum = newN++; }
        rows.push(row);
      }
      continue;
    }
    const t = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ type: "ctx", oldText: t, newText: t, oldNum: oldN++, newNum: newN++ });
    i++;
  }
  return rows;
}
function renderDiffSplit(text: string) {
  const out = $("detail-diff") as HTMLPreElement;
  out.classList.add("split");
  out.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "diff-split";
  for (const row of parseSideBySide(text)) {
    if (row.type === "meta") {
      const m = document.createElement("div");
      m.className = "dmeta"; m.textContent = row.oldText ?? "";
      grid.appendChild(m);
      continue;
    }
    const leftCls = row.type === "del" || row.type === "chg" ? "dl-del" : row.type === "ctx" ? "dl-ctx" : "";
    const rightCls = row.type === "add" || row.type === "chg" ? "dl-add" : row.type === "ctx" ? "dl-ctx" : "";
    grid.append(
      sbsCell(row.oldNum, "dn"),
      sbsCell(row.oldText, "dc " + leftCls),
      sbsCell(row.newNum, "dn"),
      sbsCell(row.newText, "dc " + rightCls),
    );
  }
  out.appendChild(grid);
}
function sbsCell(val: string | number | undefined, cls: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = val === undefined ? "" : String(val);
  return d;
}

// ---- Left nav (Changes / History) ----
function selectNav(name: "changes" | "history") {
  const ch = name === "changes";
  $("pane-changes").classList.toggle("hidden", !ch);
  $("pane-history").classList.toggle("hidden", ch);
  $("nav-changes").classList.toggle("active", ch);
  $("nav-history").classList.toggle("active", !ch);
  clearDetail();
  if (ch) refreshStatus();
  else loadHistory();
}

// Re-scan when the user comes back to the window (e.g. after editing files).
function refreshOnFocus() {
  if (!repoPath || $("app").classList.contains("hidden")) return;
  if (!$("pane-history").classList.contains("hidden")) loadHistory();
  else refreshStatus();
}

// Drag the splitter to resize the changes/history panel - lets the user widen it
// to read long file names, or shrink it for more preview room. Width is saved.
function setupSplitter() {
  const splitter = $("side-splitter");
  const side = document.querySelector(".gh-side") as HTMLElement;
  const saved = localStorage.getItem("sideWidth");
  if (saved) side.style.width = saved + "px";
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    splitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const left = side.getBoundingClientRect().left;
    const w = Math.max(220, Math.min(760, e.clientX - left));
    side.style.width = w + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("sideWidth", String(Math.round(side.getBoundingClientRect().width)));
  });
}

// ---- Console ----
function toggleConsole() {
  consoleOn = !consoleOn;
  document.querySelector(".gh-body")!.classList.toggle("hidden", consoleOn);
  $("view-console").classList.toggle("hidden", !consoleOn);
  $("console-toggle").textContent = consoleOn ? "Workspace" : "Console";
}
function buildCommandList() {
  const ul = $("cmd-list") as HTMLUListElement;
  ul.innerHTML = "";
  for (const { cmd, desc } of LORE_COMMANDS) {
    const li = document.createElement("li");
    li.className = "cmd-item";
    li.title = desc;
    const name = document.createElement("span");
    name.className = "cmd-name"; name.textContent = cmd;
    const d = document.createElement("span");
    d.className = "cmd-desc"; d.textContent = desc;
    li.append(name, d);
    li.addEventListener("click", () => {
      ($("cmd-input") as HTMLInputElement).value = cmd + " ";
      ($("cmd-input") as HTMLInputElement).focus();
      runConsole([cmd, "--help"], `lore ${cmd} --help`);
    });
    ul.appendChild(li);
  }
}
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
async function runConsole(args?: string[], echo?: string) {
  const input = $("cmd-input") as HTMLInputElement;
  const finalArgs = args ?? tokenize(input.value.trim());
  if (finalArgs.length === 0) return;
  const shown = echo ?? "lore " + input.value.trim();
  const out = $("cmd-out") as HTMLPreElement;
  out.classList.remove("muted");
  const res = await call<RunResult>("lore_run", { repo: repoPath, args: finalArgs });
  const head = document.createElement("div");
  head.className = "cmd-echo"; head.textContent = "> " + shown;
  const body = document.createElement("div");
  body.className = "cmd-result " + (res && res.ok ? "ok" : "bad");
  body.textContent = res ? res.output.trimEnd() : "(failed)";
  out.append(head, body);
  out.scrollTop = out.scrollHeight;
  if (repoPath) { refreshStatus(); refreshBranches(); }
}

// ---- Popovers ----
function openPopover(menu: HTMLElement, btn: HTMLElement) {
  const showing = !menu.classList.contains("hidden");
  closeAllPopovers();
  if (showing) return;
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + "px";
  menu.style.left = r.left + "px";
  menu.classList.remove("hidden");
}
function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach((p) => p.classList.add("hidden"));
}

// ---- Ask + merge modals ----
function askText(title: string, hint = "", def = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = $("ask-overlay");
    const input = $("ask-input") as HTMLInputElement;
    $("ask-title").textContent = title;
    $("ask-hint").textContent = hint;
    $("ask-hint").classList.toggle("hidden", !hint);
    input.value = def;
    overlay.classList.remove("hidden");
    input.focus(); input.select();
    const close = (val: string | null) => { overlay.classList.add("hidden"); input.onkeydown = null; resolve(val); };
    ($("ask-ok") as HTMLButtonElement).onclick = () => close(input.value.trim());
    ($("ask-cancel") as HTMLButtonElement).onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    input.onkeydown = (e) => { if (e.key === "Enter") close(input.value.trim()); if (e.key === "Escape") close(null); };
  });
}

function openMergeModal() {
  closeAllPopovers();
  $("merge-target").textContent = $("branch-name").textContent || "";
  ($("merge-msg") as HTMLInputElement).value = "";
  $("merge-overlay").classList.remove("hidden");
}
async function doMerge() {
  const source = ($("merge-source") as HTMLSelectElement).value;
  const msg = ($("merge-msg") as HTMLInputElement).value.trim();
  if (!source) { alert("No other branch to merge from."); return; }
  if (!msg) { alert("Write a short message for the merge."); return; }
  $("merge-overlay").classList.add("hidden");
  const out = await call<string>("lore_merge_branch", { repo: repoPath, source, message: msg });
  if (out === null) return;
  clearDetail();
  await refreshAll();
  // Conflicts left behind? Open the resolve panel.
  if ((lastStatus?.conflicts.length ?? 0) > 0 || /conflict/i.test(out)) openResolve();
}

// ---- Merge conflict resolve ----
function openResolve() {
  renderResolve();
  $("resolve-overlay").classList.remove("hidden");
}
function renderResolve() {
  const list = $("resolve-list");
  list.innerHTML = "";
  const conflicts = lastStatus?.conflicts ?? [];
  if (conflicts.length === 0) {
    list.innerHTML = `<div class="muted small">No conflicted files detected. If Lore still reports a merge in progress, use Finish or Abort.</div>`;
    return;
  }
  for (const c of conflicts) {
    const row = document.createElement("div");
    row.className = "resolve-row";
    const nm = document.createElement("span");
    nm.className = "resolve-name"; nm.textContent = c.path; nm.title = c.path;
    const mine = document.createElement("button");
    mine.className = "ghost small"; mine.textContent = "Use mine";
    mine.addEventListener("click", () => resolveSide("mine", c.path));
    const theirs = document.createElement("button");
    theirs.className = "ghost small"; theirs.textContent = "Use theirs";
    theirs.addEventListener("click", () => resolveSide("theirs", c.path));
    const acts = document.createElement("div");
    acts.className = "resolve-acts"; acts.append(mine, theirs);
    row.append(nm, acts);
    list.appendChild(row);
  }
}
async function resolveSide(side: "mine" | "theirs", path?: string) {
  const paths = path ? [path] : [];
  const out = await call<string>("lore_merge_resolve", { repo: repoPath, side, paths });
  if (out === null) return;
  await refreshStatus();
  renderResolve();
}
async function finishMerge() {
  const out = await call<string>("lore_merge_finish", { repo: repoPath });
  if (out === null) return;
  if (/conflict/i.test(out)) {
    alert("Still conflicts to resolve:\n\n" + out.trim());
    await refreshStatus(); renderResolve(); return;
  }
  $("resolve-overlay").classList.add("hidden");
  clearDetail();
  await refreshAll();
  if (!$("pane-history").classList.contains("hidden")) loadHistory();
}
async function abortMerge() {
  if (!confirm("Abort the merge and discard the in-progress merge state?")) return;
  const out = await call<string>("lore_merge_abort", { repo: repoPath });
  if (out === null) return;
  $("resolve-overlay").classList.add("hidden");
  clearDetail();
  await refreshAll();
}

// ---- Settings (global lore flags) ----
const SET_KEY = "loreSettings";
const SET_CHECKS = ["set-offline", "set-force", "set-dryrun", "set-cache", "set-gc", "set-syncdata", "set-searchnearest"];
const SET_TEXTS = ["set-identity", "set-loglevel", "set-maxconn", "set-filecount", "set-filesize", "set-compress", "set-searchlimit"];
const FLAG_OF: Record<string, string> = {
  "set-offline": "--offline", "set-force": "--force", "set-dryrun": "--dry-run",
  "set-cache": "--cache", "set-gc": "--gc", "set-syncdata": "--sync-data", "set-searchnearest": "--search-nearest",
  "set-identity": "--identity", "set-loglevel": "--log-level", "set-maxconn": "--max-connections",
  "set-filecount": "--file-count-limit", "set-filesize": "--file-size-limit",
  "set-compress": "--compress-limit", "set-searchlimit": "--search-limit",
};

function settingsToObject(): Record<string, unknown> {
  const o: Record<string, unknown> = {
    source: (document.querySelector('input[name="source"]:checked') as HTMLInputElement)?.value ?? "",
    serveraddr: ($("set-serveraddr") as HTMLInputElement).value.trim(),
  };
  for (const id of SET_CHECKS) o[id] = ($(id) as HTMLInputElement).checked;
  for (const id of SET_TEXTS) o[id] = ($(id) as HTMLInputElement).value;
  return o;
}
function objectToSettings(o: Record<string, unknown>) {
  const src = (o.source as string) ?? "";
  document.querySelectorAll<HTMLInputElement>('input[name="source"]').forEach((r) => (r.checked = r.value === src));
  ($("set-serveraddr") as HTMLInputElement).value = (o.serveraddr as string) ?? "";
  for (const id of SET_CHECKS) ($(id) as HTMLInputElement).checked = !!o[id];
  for (const id of SET_TEXTS) ($(id) as HTMLInputElement).value = (o[id] as string) ?? "";
}

const DEFAULT_SERVER = "lore://127.0.0.1:41337";
function getServerAddr(): string {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  const a = (saved.serveraddr as string) || "";
  return a.trim() || DEFAULT_SERVER;
}
function isLocalAddr(a: string): boolean {
  return a.includes("127.0.0.1") || a.includes("localhost");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Server control ----
function setServerState(up: boolean) {
  const addr = getServerAddr();
  const local = isLocalAddr(addr);
  const type = local ? "Local" : "Remote";

  const dot = $("server-dot");
  dot.classList.toggle("up", up);
  dot.classList.toggle("down", !up);

  // Top bar shows the type so you know which server you are driving.
  $("server-label").textContent = type;
  $("server-addr-display").textContent = addr;
  $("server-type-line").textContent = `Type: ${type} server`;
  $("server-status-line").textContent = up ? "Status: running" : "Status: not running";

  // Start only when down + local; Stop only when up + local; neither for remote.
  $("server-start").classList.toggle("hidden", up || !local);
  $("server-stop").classList.toggle("hidden", !up || !local);
  $("server-remote-note").classList.toggle("hidden", local);
}
async function refreshServerStatus(): Promise<boolean> {
  const addr = getServerAddr();
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: addr }); } catch { up = false; }
  setServerState(up);
  return up;
}
// Start a local server if the address is local and nothing is answering.
async function ensureServer() {
  const addr = getServerAddr();
  if (await refreshServerStatus()) return;
  if (!isLocalAddr(addr)) return; // remote: connect-only, do not start
  try { await invoke("lore_start_server"); } catch (e) { console.error(e); return; }
  for (let i = 0; i < 15; i++) { await sleep(1000); if (await refreshServerStatus()) break; }
}
async function startServerClicked() {
  closeAllPopovers();
  await invoke("lore_start_server").catch((e) => alert(String(e)));
  for (let i = 0; i < 15; i++) { await sleep(1000); if (await refreshServerStatus()) break; }
}
async function stopServerClicked() {
  closeAllPopovers();
  const out = await call<string>("lore_stop_server");
  if (out !== null) await refreshServerStatus();
}

// ---- Server setup wizard ----
function portOf(addr: string): string {
  const m = addr.match(/:(\d+)/);
  return m ? m[1] : "";
}
function setSetupMode(mode: "host" | "connect") {
  document.querySelectorAll<HTMLInputElement>('input[name="setupmode"]').forEach((r) => (r.checked = r.value === mode));
  $("setup-host").classList.toggle("hidden", mode !== "host");
  $("setup-connect").classList.toggle("hidden", mode !== "connect");
  document.querySelectorAll(".setup-card").forEach((c) => {
    const r = c.querySelector("input") as HTMLInputElement;
    c.classList.toggle("selected", r.checked);
  });
}
// Build the shareable address from this PC's LAN IP (fetched once) + the port.
async function refreshSetupShare() {
  const port = ($("setup-port") as HTMLInputElement).value.trim() || "41337";
  if (setupLanIp === undefined) {
    try { setupLanIp = await invoke<string | null>("local_ip"); } catch { setupLanIp = null; }
  }
  if (setupLanIp) {
    $("setup-share-url").textContent = `lore://${setupLanIp}:${port}`;
    $("setup-host-note").textContent = "loreserver listens on all interfaces by default, so teammates on your LAN or VPN can reach this once your firewall allows port 41337 (TCP+UDP). On Tailscale, share your 100.x address. Note: the quick local server stores data in a temp folder - run loreserver with a --config for a persistent team server.";
  } else {
    $("setup-share-url").textContent = `lore://127.0.0.1:${port}`;
    $("setup-host-note").textContent = "No LAN address found - others can only reach you over a shared LAN or VPN (e.g. Tailscale).";
  }
}
async function refreshSetupServerState() {
  const local = "lore://127.0.0.1:" + (($("setup-port") as HTMLInputElement).value.trim() || "41337");
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: local }); } catch { up = false; }
  $("setup-server-state").textContent = up ? "Status: running" : "Status: not running";
  const toggle = $("setup-server-toggle") as HTMLButtonElement;
  toggle.textContent = up ? "Stop server" : "Start server";
  toggle.dataset.up = up ? "1" : "0";
}
async function toggleSetupServer() {
  const toggle = $("setup-server-toggle") as HTMLButtonElement;
  const wasUp = toggle.dataset.up === "1";
  toggle.disabled = true;
  try {
    if (wasUp) await invoke("lore_stop_server");
    else await invoke("lore_start_server");
  } catch (e) { alert(String(e)); }
  for (let i = 0; i < 8; i++) {
    await sleep(800);
    await refreshSetupServerState();
    if ((toggle.dataset.up === "1") !== wasUp) break;
  }
  toggle.disabled = false;
  refreshServerStatus();
}
async function testSetupConnection() {
  const addr = ($("setup-addr") as HTMLInputElement).value.trim();
  const state = $("setup-test-state");
  if (!addr) { state.textContent = "Type an address first."; return; }
  state.textContent = "Checking…";
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: addr }); } catch { up = false; }
  state.textContent = up ? "Connected ✓" : "No answer ✗";
}
function openSetup() {
  closeAllPopovers();
  const addr = getServerAddr();
  const local = isLocalAddr(addr);
  ($("setup-port") as HTMLInputElement).value = portOf(addr) || "41337";
  ($("setup-addr") as HTMLInputElement).value = local ? "" : addr;
  $("setup-test-state").textContent = "";
  setSetupMode(local ? "host" : "connect");
  refreshSetupShare();
  refreshSetupServerState();
  $("setup-overlay").classList.remove("hidden");
}
async function saveSetup() {
  const mode = (document.querySelector('input[name="setupmode"]:checked') as HTMLInputElement)?.value || "host";
  let addr: string;
  if (mode === "host") {
    const port = ($("setup-port") as HTMLInputElement).value.trim() || "41337";
    // The app drives a local server over loopback; the LAN address is only for sharing.
    addr = `lore://127.0.0.1:${port}`;
  } else {
    addr = ($("setup-addr") as HTMLInputElement).value.trim();
    if (!addr) { alert("Type the server address to connect to."); return; }
  }
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  saved.serveraddr = addr;
  localStorage.setItem(SET_KEY, JSON.stringify(saved));
  ($("set-serveraddr") as HTMLInputElement).value = addr;
  $("setup-overlay").classList.add("hidden");
  await ensureServer();
}

function buildGlobals(): string[] {
  const g: string[] = [];
  const source = (document.querySelector('input[name="source"]:checked') as HTMLInputElement)?.value;
  if (source) g.push(source);
  for (const id of SET_CHECKS) if (($(id) as HTMLInputElement).checked) g.push(FLAG_OF[id]);
  for (const id of SET_TEXTS) {
    const v = ($(id) as HTMLInputElement).value.trim();
    if (v) g.push(FLAG_OF[id], v);
  }
  return g;
}
function updateSettingsPreview() {
  const g = buildGlobals();
  $("settings-preview").textContent = g.length ? "lore " + g.join(" ") + " …" : "lore … (no extra flags)";
}
function openSettings() {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  objectToSettings(saved);
  // Per-repo identity lives in the project's config, not the global settings.
  ($("set-repoidentity") as HTMLInputElement).value = repoIdentity;
  ($("set-repoidentity") as HTMLInputElement).disabled = !repoPath;
  ($("set-ghuser") as HTMLInputElement).value = repoGithubUser;
  ($("set-ghuser") as HTMLInputElement).disabled = !repoPath;
  updateSettingsPreview();
  $("settings-overlay").classList.remove("hidden");
}
async function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settingsToObject()));
  await invoke("lore_set_globals", { globals: buildGlobals() });
  if (repoPath) {
    let avatarChanged = false;
    const newGh = ($("set-ghuser") as HTMLInputElement).value.trim();
    if (newGh !== repoGithubUser) {
      repoGithubUser = newGh;
      if (newGh) localStorage.setItem(ghUserKey(repoPath), newGh);
      else localStorage.removeItem(ghUserKey(repoPath));
      avatarChanged = true;
    }
    const newId = ($("set-repoidentity") as HTMLInputElement).value.trim();
    if (newId !== repoIdentity) {
      const out = await invoke<string>("lore_set_identity", { repo: repoPath, identity: newId }).catch((e) => { alert(String(e)); return null; });
      if (out !== null) { repoIdentity = newId; avatarChanged = true; }
    }
    if (avatarChanged) {
      avatarUrl = null;
      if (!$("pane-history").classList.contains("hidden")) loadHistory();
    }
  }
  $("settings-overlay").classList.add("hidden");
  if (repoPath) refreshAll();
}
// Push saved settings to the backend at startup.
async function applySavedGlobals() {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  objectToSettings(saved);
  await invoke("lore_set_globals", { globals: buildGlobals() });
}

// ---- Wire up ----
window.addEventListener("DOMContentLoaded", () => {
  $("open-btn").addEventListener("click", openProject);
  $("open-btn-2").addEventListener("click", openProject);
  $("create-btn").addEventListener("click", createProject);
  $("create-btn-2").addEventListener("click", createProject);

  $("proj-btn").addEventListener("click", (e) => { e.stopPropagation(); renderRecent(); openPopover($("proj-menu"), $("proj-btn")); });
  $("branch-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("branch-menu"), $("branch-btn")); });
  $("sync-btn").addEventListener("click", syncAction);
  $("newbranch-btn").addEventListener("click", newBranch);
  $("merge-open-btn").addEventListener("click", openMergeModal);
  $("merge-ok").addEventListener("click", doMerge);
  $("merge-cancel").addEventListener("click", () => $("merge-overlay").classList.add("hidden"));
  $("merge-overlay").addEventListener("click", (e) => { if (e.target === $("merge-overlay")) $("merge-overlay").classList.add("hidden"); });

  // Merge conflict resolve.
  $("merge-finish").addEventListener("click", finishMerge);
  $("merge-abort").addEventListener("click", abortMerge);
  $("resolve-all-mine").addEventListener("click", () => resolveSide("mine"));
  $("resolve-all-theirs").addEventListener("click", () => resolveSide("theirs"));

  // Don't let the webview remember/autofill text inputs (e.g. commit messages).
  document.querySelectorAll("input").forEach((i) => i.setAttribute("autocomplete", "off"));

  $("nav-changes").addEventListener("click", () => selectNav("changes"));
  $("nav-history").addEventListener("click", () => selectNav("history"));
  $("nav-newbranch").addEventListener("click", (e) => { e.stopPropagation(); newBranch(); });
  $("sort-mode").addEventListener("change", (e) => { fileSort = (e.target as HTMLSelectElement).value as "name" | "type"; rerenderChanges(); });
  $("filter-ext").addEventListener("input", (e) => { fileFilter = (e.target as HTMLInputElement).value; rerenderChanges(); });

  $("save-btn").addEventListener("click", save);
  $("commit-msg").addEventListener("input", updateCommitButton);
  $("discard-all").addEventListener("click", discardAll);
  $("refresh-changes").addEventListener("click", () => { if (repoPath) refreshStatus(); });
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOnFocus(); });
  $("check-all").addEventListener("change", (e) => {
    const master = e.target as HTMLInputElement;
    master.indeterminate = false;
    document.querySelectorAll<HTMLInputElement>("#file-list .file-check").forEach((b) => (b.checked = master.checked));
    updateCommitButton();
  });

  $("console-toggle").addEventListener("click", toggleConsole);
  $("server-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("server-menu"), $("server-btn")); });
  $("server-start").addEventListener("click", startServerClicked);
  $("server-stop").addEventListener("click", stopServerClicked);
  $("settings-btn").addEventListener("click", openSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-cancel").addEventListener("click", () => $("settings-overlay").classList.add("hidden"));
  $("settings-overlay").addEventListener("click", (e) => { if (e.target === $("settings-overlay")) $("settings-overlay").classList.add("hidden"); });

  // Server setup wizard.
  $("setup-btn-2").addEventListener("click", openSetup);
  $("server-setup").addEventListener("click", openSetup);
  $("setup-cancel").addEventListener("click", () => $("setup-overlay").classList.add("hidden"));
  $("setup-overlay").addEventListener("click", (e) => { if (e.target === $("setup-overlay")) $("setup-overlay").classList.add("hidden"); });
  $("setup-save").addEventListener("click", saveSetup);
  $("setup-copy").addEventListener("click", () => navigator.clipboard?.writeText($("setup-share-url").textContent || ""));
  $("setup-server-toggle").addEventListener("click", toggleSetupServer);
  $("setup-test").addEventListener("click", testSetupConnection);
  $("setup-port").addEventListener("input", () => { refreshSetupShare(); refreshSetupServerState(); });
  document.querySelectorAll('input[name="setupmode"]').forEach((r) =>
    r.addEventListener("change", () => setSetupMode((r as HTMLInputElement).value as "host" | "connect"))
  );
  document.querySelectorAll("#settings-overlay input, #settings-overlay select")
    .forEach((el) => el.addEventListener("change", updateSettingsPreview));
  applySavedGlobals();
  $("cmd-run").addEventListener("click", () => runConsole());
  $("cmd-input").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runConsole(); });
  buildCommandList();
  setupSplitter();
  $("diff-mode").addEventListener("click", () => {
    diffMode = diffMode === "split" ? "unified" : "split";
    localStorage.setItem("diffMode", diffMode);
    if (lastDiffText) renderDiff(lastDiffText);
  });

  // Close popovers on outside click / Escape.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".popover") && !t.closest(".gh-dd")) closeAllPopovers();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllPopovers(); });

  // Bring the server up (auto-start local), then keep the status dot fresh.
  ensureServer();
  setInterval(refreshServerStatus, 6000);

  // Re-open last project.
  const last = localStorage.getItem("repoPath");
  if (last) invoke<boolean>("lore_is_repo", { repo: last }).then((ok) => { if (ok) enterProject(last); });
});
