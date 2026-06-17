import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
  raw: string;
}
interface Branch { name: string; current: boolean; }
interface BranchList { local: Branch[]; remote: Branch[]; raw: string; }
interface RunResult { output: string; ok: boolean; }
interface Commit {
  revision: string;
  signature: string;
  date: string;
  message: string;
  is_merge: boolean;
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

async function enterProject(path: string) {
  repoPath = path;
  localStorage.setItem("repoPath", repoPath);
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
  if (s) renderStatus(s);
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

  // file rows
  const rows: { change: FileChange; staged: boolean }[] = [];
  for (const c of s.staged) rows.push({ change: c, staged: true });
  for (const c of s.unstaged) rows.push({ change: c, staged: false });
  for (const c of s.untracked) rows.push({ change: c, staged: false });

  const list = $("file-list") as HTMLUListElement;
  list.innerHTML = "";
  for (const { change, staged } of rows) {
    const li = document.createElement("li");
    li.className = "gh-file";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "file-check";
    cb.dataset.path = change.path;
    cb.checked = staged;
    cb.addEventListener("change", updateCommitButton);

    const tag = document.createElement("span");
    tag.className = "tag tag-" + change.status;
    tag.title = STATUS_LABEL[change.status] ?? change.status;
    tag.textContent = change.status;

    const name = document.createElement("span");
    name.className = "gh-file-name";
    name.textContent = change.path;
    name.title = change.path;
    name.addEventListener("click", () => showWorkingDiff(change.path));

    const discard = document.createElement("button");
    discard.className = "row-x";
    discard.title = "Discard changes to this file";
    discard.textContent = "⨯";
    discard.addEventListener("click", (e) => { e.stopPropagation(); discardFiles([change.path]); });

    li.append(cb, tag, name, discard);
    list.appendChild(li);
  }

  $("changes-count").textContent =
    rows.length === 0 ? "No changes" : `${rows.length} changed file${rows.length > 1 ? "s" : ""}`;
  ($("check-all") as HTMLInputElement).checked = rows.length > 0;
  updateCommitButton();
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

// ---- Working diff (Changes tab) ----
async function showWorkingDiff(path: string) {
  showDetail(path, "working changes");
  $("detail-files").classList.add("hidden");
  highlightFile(path);
  const text = await call<string>("lore_diff", { repo: repoPath, path });
  renderDiff(text ?? "Could not load changes.");
}

// ---- History ----
async function loadHistory() {
  const h = await call<Commit[]>("lore_history", { repo: repoPath });
  if (!h) return;
  history = h;
  const ul = $("history-list") as HTMLUListElement;
  ul.innerHTML = "";
  h.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "gh-commit";
    li.dataset.idx = String(i);
    const subject = c.message.split("\n")[0] || "(no message)";
    const top = document.createElement("div");
    top.className = "gh-commit-subject";
    top.textContent = (c.is_merge ? "⛙ " : "") + subject;
    const meta = document.createElement("div");
    meta.className = "gh-commit-meta muted small";
    meta.textContent = `rev ${c.revision} · ${shortDate(c.date)}`;
    li.append(top, meta);
    li.addEventListener("click", () => showCommit(i));
    ul.appendChild(li);
  });
}

async function showCommit(i: number) {
  const c = history[i];
  const parent = history[i + 1]; // older commit, or undefined for the first
  document.querySelectorAll(".gh-commit").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.idx === String(i))
  );

  showDetail(c.message.split("\n")[0] || "(no message)", `rev ${c.revision} · ${c.date}`);

  // actions: Revert (any), Undo (latest only)
  const actions = $("detail-actions");
  actions.innerHTML = "";
  const revert = document.createElement("button");
  revert.className = "ghost small";
  revert.textContent = "Revert this commit";
  revert.addEventListener("click", () => revertCommit(c));
  actions.appendChild(revert);
  if (i === 0 && parent) {
    const undo = document.createElement("button");
    undo.className = "ghost small";
    undo.textContent = "Undo (remove this commit)";
    undo.addEventListener("click", () => undoCommit(parent));
    actions.appendChild(undo);
  }

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
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "detail-file-row";
    const tag = document.createElement("span");
    tag.className = "tag tag-" + f.status;
    tag.textContent = f.status;
    const name = document.createElement("span");
    name.className = "gh-file-name";
    name.textContent = f.path;
    row.append(tag, name);
    row.addEventListener("click", async () => {
      filesBox.querySelectorAll(".detail-file-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
      const text = await call<string>("lore_commit_file_diff", {
        repo: repoPath, source: parent.signature, target: c.signature, path: f.path,
      });
      renderDiff(text ?? "Could not load diff.");
    });
    filesBox.appendChild(row);
  }
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
  $("detail").classList.add("hidden");
  $("detail-empty").classList.remove("hidden");
  $("detail-diff").textContent = "";
  $("detail-files").classList.add("hidden");
}
function highlightFile(path: string) {
  document.querySelectorAll("#file-list .gh-file").forEach((li) => {
    const cb = li.querySelector(".file-check") as HTMLInputElement;
    li.classList.toggle("active", cb?.dataset.path === path);
  });
}
function renderDiff(text: string) {
  const out = $("detail-diff") as HTMLPreElement;
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

// ---- Tabs ----
function showTab(name: "changes" | "history") {
  const ch = name === "changes";
  $("pane-changes").classList.toggle("hidden", !ch);
  $("pane-history").classList.toggle("hidden", ch);
  $("tab-changes").classList.toggle("active", ch);
  $("tab-history").classList.toggle("active", !ch);
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
  if (out !== null) {
    if (/[1-9]\d* conflicted/.test(out) || /conflict/i.test(out)) {
      alert("This merge has conflicts. v1 cannot resolve those here - use the Console or ask your programmer.");
    }
    clearDetail(); await refreshAll();
  }
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
  updateSettingsPreview();
  $("settings-overlay").classList.remove("hidden");
}
async function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settingsToObject()));
  await invoke("lore_set_globals", { globals: buildGlobals() });
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

  $("proj-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("proj-menu"), $("proj-btn")); });
  $("branch-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("branch-menu"), $("branch-btn")); });
  $("sync-btn").addEventListener("click", syncAction);
  $("newbranch-btn").addEventListener("click", newBranch);
  $("merge-open-btn").addEventListener("click", openMergeModal);
  $("merge-ok").addEventListener("click", doMerge);
  $("merge-cancel").addEventListener("click", () => $("merge-overlay").classList.add("hidden"));
  $("merge-overlay").addEventListener("click", (e) => { if (e.target === $("merge-overlay")) $("merge-overlay").classList.add("hidden"); });

  $("tab-changes").addEventListener("click", () => showTab("changes"));
  $("tab-history").addEventListener("click", () => showTab("history"));

  $("save-btn").addEventListener("click", save);
  $("commit-msg").addEventListener("input", updateCommitButton);
  $("discard-all").addEventListener("click", discardAll);
  $("refresh-changes").addEventListener("click", () => { if (repoPath) refreshStatus(); });
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOnFocus(); });
  $("check-all").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    document.querySelectorAll<HTMLInputElement>(".file-check").forEach((b) => (b.checked = on));
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
  document.querySelectorAll("#settings-overlay input, #settings-overlay select")
    .forEach((el) => el.addEventListener("change", updateSettingsPreview));
  applySavedGlobals();
  $("cmd-run").addEventListener("click", () => runConsole());
  $("cmd-input").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runConsole(); });
  buildCommandList();

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
