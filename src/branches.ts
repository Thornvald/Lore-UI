// The branch nav + branch operations: list/switch (with a dirty-tree guard),
// create, push, info, protect, archive, and the branch right-click menu.

import { invoke } from "@tauri-apps/api/core";
import { $, call, askText, showToast, openContextMenu, closeAllPopovers } from "./dom";
import { S } from "./state";
import { clearDetail, showTextDetail } from "./detail";
import { updatePushButton } from "./status";
import { refreshAll } from "./project";
import { loadHistory } from "./history";
import { openMergeFor } from "./merge";
import type { Branch, BranchList, CtxItem } from "./types";

export async function refreshBranches() {
  const bl = await call<BranchList>("lore_branches", { repo: S.repoPath });
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
  // Branch list just changed - the Push button depends on whether the current
  // branch has a remote copy, so re-evaluate it now that we know.
  updatePushButton();
}

export function dirtyCount(): number {
  const s = S.lastStatus;
  if (!s) return 0;
  return s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length;
}

export async function switchBranch(name: string) {
  const n = dirtyCount();
  if (n > 0) { openSwitchGuard(name, n); return; }
  await doSwitch(name, false);
}

export async function doSwitch(name: string, reset: boolean) {
  const out = await call<string>("lore_switch_branch", { repo: S.repoPath, name, reset });
  if (out !== null) { clearDetail(); await refreshAll(); }
  else { await refreshBranches(); } // switch failed (e.g. stale branch) - re-sync the nav
}

function openSwitchGuard(name: string, n: number) {
  S.switchTargetName = name;
  $("switch-target").textContent = name;
  $("switch-count").textContent = String(n);
  $("switch-overlay").classList.remove("hidden");
}

export async function newBranch() {
  closeAllPopovers();
  const name = await askText("Name for the new branch", "Letters, numbers, dashes.");
  if (!name) return;
  const out = await call<string>("lore_create_branch", { repo: S.repoPath, name: name.trim() });
  if (out !== null) await refreshBranches();
}

// Create a new branch starting at another branch's latest revision (works for
// the current branch too).
async function createBranchFrom(b: Branch) {
  const name = await askText(`New branch from "${b.name}"`, "Letters, numbers, dashes.");
  if (!name) return;
  const info = await call<string>("lore_branch_info", { repo: S.repoPath, name: b.name });
  if (info === null) return;
  const m = info.match(/Latest\s*:\s*([0-9a-f]+)/i);
  const out = await call<string>("lore_branch_create_at", { repo: S.repoPath, name: name.trim(), revision: m ? m[1] : "" });
  if (out !== null) await refreshBranches();
}

export function branchMenu(b: Branch): CtxItem[] {
  const items: CtxItem[] = [];
  items.push({ label: "Create branch from this…", run: () => createBranchFrom(b) });
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
    items.push({ label: "Delete branch (archive)", danger: true, run: () => branchArchive(b.name) });
  }
  return items;
}

async function branchPush(name: string) {
  const out = await call<string>("lore_branch_push", { repo: S.repoPath, name });
  if (out !== null) await refreshAll();
}

async function branchInfo(name: string) {
  const out = await call<string>("lore_branch_info", { repo: S.repoPath, name });
  if (out !== null) showTextDetail(`Branch ${name}`, "", out);
}

async function branchProtect(name: string, on: boolean) {
  const out = await call<string>("lore_branch_protect", { repo: S.repoPath, name, protect: on });
  if (out !== null) await refreshBranches();
}

async function branchArchive(name: string) {
  if (!confirm(`Delete branch "${name}" (archive it)? Lore has no undo for this.`)) return;
  try {
    await invoke<string>("lore_branch_archive", { repo: S.repoPath, name });
    showToast(`Archived "${name}"`);
  } catch (e) {
    // Lore returns "[Error] ... not found" when the branch is already gone from
    // its view (e.g. a stale nav entry left over after another client removed it).
    // That is not a real failure for the user - the branch is no longer there - so
    // drop it quietly with a toast instead of a scary error dialog. Any other
    // error is genuine and still surfaced.
    if (/not found/i.test(String(e))) showToast(`Branch "${name}" was already gone`);
    else alert(String(e));
  }
  // Refresh either way so the nav reflects Lore's real branch list, success or not.
  await refreshBranches();
  if (!$("pane-history").classList.contains("hidden")) loadHistory();
}
