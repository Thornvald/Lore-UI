// Opening, creating, cloning and entering a project; the recent-projects list;
// the working-tree watcher hookup; and the cross-pane refresh orchestration.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { $, askText, showToast, closeAllPopovers } from "./dom";
import { S, RECENT_KEY, ghUserKey, authorNameKey, baseName, repoName, getServerAddr, isLocalAddr } from "./state";
import { refreshStatus } from "./status";
import { refreshBranches } from "./branches";
import { loadHistory } from "./history";
import { clearDetail } from "./detail";

// ---- Project open / create ----
export async function openProject() {
  closeAllPopovers();
  const picked = await open({ directory: true, title: "Open a Lore project folder" });
  if (!picked || typeof picked !== "string") return;
  const isRepo = await invoke<boolean>("lore_is_repo", { repo: picked });
  if (!isRepo) {
    // A plain folder is not a repo yet. Rather than dead-ending, offer to make it
    // one - that is what the user usually means by "open a new project here".
    if (confirm(`"${baseName(picked)}" is not a Lore project yet.\n\nCreate a new Lore project in this folder?`)) {
      await createProjectAt(picked);
    }
    return;
  }
  await enterProject(picked);
}

export async function createProject() {
  closeAllPopovers();
  const picked = await open({ directory: true, title: "Pick a folder for the new project" });
  if (!picked || typeof picked !== "string") return;
  await createProjectAt(picked);
}

// Clone an existing repo from any Lore server (localhost, LAN, VPS, Tailscale,
// VLAN - just a lore://host:port/name URL) into a chosen folder, then open it.
export async function cloneProject() {
  closeAllPopovers();
  const url = await askText(
    "Repository URL to clone",
    "lore://HOST:PORT/name  -  the server address (your friend's VPS / Tailscale 100.x / LAN IP) and the repo name",
    `${getServerAddr()}/`
  );
  if (!url) return;
  const parent = await open({ directory: true, title: "Pick a folder to clone the project into" });
  if (!parent || typeof parent !== "string") return;
  try {
    const dest = await invoke<string>("lore_clone", { url: url.trim(), parent });
    await enterProject(dest);
  } catch (e) {
    alert("Could not clone the project.\n\n" + String(e));
  }
}

// Create a Lore repo in an existing folder, then open it. Shared by the Create
// button and by Open-on-a-plain-folder.
async function createProjectAt(picked: string) {
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
function recentProjects(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}

function addRecentProject(path: string) {
  const list = recentProjects().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
}

export function renderRecent() {
  const ul = $("recent-list") as HTMLUListElement;
  ul.innerHTML = "";
  const list = recentProjects();
  ul.classList.toggle("hidden", list.length === 0);
  for (const p of list) {
    const li = document.createElement("li");
    li.className = "recent-item" + (p === S.repoPath ? " current" : "");
    li.title = p;
    const nm = document.createElement("span"); nm.className = "recent-name"; nm.textContent = baseName(p);
    const pa = document.createElement("span"); pa.className = "recent-path"; pa.textContent = p;
    li.append(nm, pa);
    li.addEventListener("click", () => { closeAllPopovers(); openKnownProject(p); });
    ul.appendChild(li);
  }
}

async function openKnownProject(path: string) {
  if (path === S.repoPath) return;
  const ok = await invoke<boolean>("lore_is_repo", { repo: path }).catch(() => false);
  if (!ok) {
    alert("That project is not available (folder missing or not a Lore project). Removing it from the list.");
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects().filter((p) => p !== path)));
    renderRecent();
    return;
  }
  await enterProject(path);
}

export async function enterProject(path: string) {
  S.repoPath = path;
  localStorage.setItem("repoPath", S.repoPath);
  addRecentProject(path);
  S.repoIdentity = await invoke<string>("lore_identity", { repo: path }).catch(() => "");
  S.repoRemoteUrl = await invoke<string>("lore_repo_remote", { repo: path }).catch(() => "");
  S.repoIsRemote = S.repoRemoteUrl !== "" && !isLocalAddr(S.repoRemoteUrl);
  S.repoGithubUser = localStorage.getItem(ghUserKey(path)) || "";
  S.repoAuthorName = localStorage.getItem(authorNameKey(path)) || "";
  $("proj-name").textContent = baseName(path);
  $("proj-path").textContent = path;
  $("empty").classList.add("hidden");
  $("app").classList.remove("hidden");
  clearDetail();
  // First time an Unreal project is opened, set up its .loreignore + store cap so
  // the first scan below already skips the derived folders. Idempotent: it does
  // nothing on later opens, so we never reconfigure an already-set-up project.
  const unrealAdded = await invoke<boolean>("ensure_unreal_setup", { repo: path }).catch(() => false);
  // Watch the working tree so changes show without a manual Refresh.
  invoke("start_repo_watch", { repo: path }).catch(() => {});
  await refreshAll();
  if (unrealAdded) showToast("Unreal project - added .loreignore and raised the store size");
}

// ---- Refresh ----
export async function refreshAll() {
  await refreshStatus();
  await refreshBranches();
  if (!$("pane-history").classList.contains("hidden")) await loadHistory();
}

// Auto-refresh the Changes list when the watcher reports a working-tree change.
// Debounced so a burst of file events triggers a single scan.
let watchDebounce = 0;
export function startChangeWatcher() {
  listen("repo-changed", () => {
    clearTimeout(watchDebounce);
    watchDebounce = window.setTimeout(() => { if (S.repoPath) refreshStatus(); }, 600);
  });
}

// ---- Left nav (Changes / History) ----
// Both panes are shown side by side now, so the nav buttons no longer switch -
// they just refresh and scroll to the side you clicked.
export function selectNav(name: "changes" | "history") {
  $("nav-changes").classList.add("active");
  $("nav-history").classList.add("active");
  if (name === "changes") { refreshStatus(); $("pane-changes").scrollIntoView({ block: "nearest", inline: "start" }); }
  else { loadHistory(); $("pane-history").scrollIntoView({ block: "nearest", inline: "end" }); }
}

// Re-scan when the user comes back to the window (e.g. after editing files).
export function refreshOnFocus() {
  if (!S.repoPath || $("app").classList.contains("hidden")) return;
  refreshBranches(); // keep the branch nav truthful if branches changed via the CLI
  if (!$("pane-history").classList.contains("hidden")) loadHistory();
  else refreshStatus();
}

// Drag the splitter to resize the changes/history panel - lets the user widen it
// to read long file names, or shrink it for more preview room. Width is saved.
export function setupSplitter() {
  const splitter = $("side-splitter");
  const side = document.querySelector(".gh-side") as HTMLElement;
  // Two columns (Changes + History) need room, so never start narrower than 440
  // even if an older single-column width was saved.
  const saved = localStorage.getItem("sideWidth");
  if (saved) side.style.width = Math.max(440, Number(saved) || 0) + "px";
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
    const w = Math.max(440, Math.min(1200, e.clientX - left));
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
