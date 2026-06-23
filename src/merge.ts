// Merge flow: the merge modal, starting a merge, and the conflict-resolve view.
//
// A conflict is whatever `lore status` lists under "Changes in conflict:" - the
// app already parses that into S.lastStatus.conflicts. Picking a side strips the
// markers and stages that file; once none remain, a plain commit finalises the
// merge (Lore has no separate "merge finish" step).

import { invoke } from "@tauri-apps/api/core";
import { $, tryInvoke, showToast, closeAllPopovers, firstError } from "./dom";
import { S, baseName } from "./state";
import { clearDetail, showDetail, showDiffView } from "./detail";
import { looksBinary, buildConflictGrid } from "./diff";
import { refreshAll } from "./project";
import { loadHistory } from "./history";

export function openMergeModal() {
  closeAllPopovers();
  $("merge-target").textContent = $("branch-name").textContent || "";
  ($("merge-msg") as HTMLInputElement).value = "";
  $("merge-overlay").classList.remove("hidden");
}

export function openMergeFor(name: string) {
  openMergeModal();
  const sel = $("merge-source") as HTMLSelectElement;
  if ([...sel.options].some((o) => o.value === name)) sel.value = name;
}

export async function doMerge() {
  const source = ($("merge-source") as HTMLSelectElement).value;
  const msg = ($("merge-msg") as HTMLInputElement).value.trim();
  if (!source) { showToast("No other branch to merge from."); return; }
  if (source === ($("branch-name").textContent || "").trim()) { showToast("Pick another branch - that's the current one."); return; }
  if (!msg) { showToast("Write a short message for the merge."); return; }
  $("merge-overlay").classList.add("hidden");
  S.mergeMessage = msg;
  // "branch merge start" pauses on conflicts (writes diff3 markers into the files
  // and lists them under "Changes in conflict:" in status) and auto-commits when
  // the merge is clean.
  const start = await tryInvoke("lore_merge_start", { repo: S.repoPath, source, message: msg });
  clearDetail();
  await refreshAll();
  S.mergeConflicts = currentConflicts();
  if (S.mergeConflicts.length > 0) { openResolve(); return; }
  // No conflicts: a clean merge that start already committed, nothing to merge,
  // or a real failure. Tell the user softly either way.
  if (/nothing to merge|already up to date|up-to-date|0 merged, 0 conflicted|no merge/i.test(start.out))
    showToast(`Nothing to merge from ${source}`);
  else if (!start.ok)
    showToast(`Merge failed: ${firstError(start.out)}`);
  else {
    showToast(`Merged ${source}`);
    if (!$("pane-history").classList.contains("hidden")) loadHistory();
  }
}

function currentConflicts(): string[] {
  return (S.lastStatus?.conflicts ?? []).map((c) => c.path);
}

export function openResolve() { renderResolve(); $("resolve-overlay").classList.remove("hidden"); }

// Cap rendered rows so a merge with thousands of conflicts cannot freeze the UI.
// The bulk buttons still act on every file, not just the visible ones.
const RESOLVE_RENDER_CAP = 400;
function renderResolve() {
  const list = $("resolve-list");
  list.innerHTML = "";
  const head = document.getElementById("resolve-count");
  if (head) head.textContent = S.mergeConflicts.length === 0
    ? "No conflicts left"
    : `${S.mergeConflicts.length} file${S.mergeConflicts.length === 1 ? "" : "s"} in conflict`;
  if (S.mergeConflicts.length === 0) {
    list.innerHTML = `<div class="muted small">No conflicted files left - click Finish merge.</div>`;
    return;
  }
  for (const path of S.mergeConflicts.slice(0, RESOLVE_RENDER_CAP)) {
    const row = document.createElement("div");
    row.className = "resolve-row";
    const nm = document.createElement("span");
    nm.className = "resolve-name link"; nm.textContent = path; nm.title = "View the conflict";
    nm.addEventListener("click", () => showConflictFile(path));
    const mine = document.createElement("button");
    mine.className = "ghost small"; mine.textContent = "Use mine";
    mine.addEventListener("click", () => resolveSide("mine", path));
    const theirs = document.createElement("button");
    theirs.className = "ghost small"; theirs.textContent = "Use theirs";
    theirs.addEventListener("click", () => resolveSide("theirs", path));
    const acts = document.createElement("div");
    acts.className = "resolve-acts"; acts.append(mine, theirs);
    row.append(nm, acts);
    list.appendChild(row);
  }
  if (S.mergeConflicts.length > RESOLVE_RENDER_CAP) {
    const more = document.createElement("div");
    more.className = "muted small"; more.style.padding = "0.4rem 0.75rem";
    more.textContent = `+ ${S.mergeConflicts.length - RESOLVE_RENDER_CAP} more - use the bulk buttons, or resolve in batches.`;
    list.appendChild(more);
  }
}

// Pick a side for one file, or (no path) every conflicted file at once.
export async function resolveSide(side: "mine" | "theirs", path?: string) {
  const paths = path ? [path] : S.mergeConflicts.slice();
  if (paths.length === 0) return;
  const res = await tryInvoke("lore_merge_resolve", { repo: S.repoPath, side, paths });
  if (!res.ok) showToast(`Could not pick ${side}: ${firstError(res.out)}`);
  await refreshAll();
  S.mergeConflicts = currentConflicts();
  if (S.mergeConflicts.length > 0) { renderResolve(); return; }
  await finalizeMerge();
}

// No conflicts left - commit the staged merge to complete it.
async function finalizeMerge() {
  const res = await tryInvoke("lore_commit", { repo: S.repoPath, message: S.mergeMessage || "Merge" });
  $("resolve-overlay").classList.add("hidden");
  S.mergeConflicts = [];
  clearDetail();
  await refreshAll();
  if (!$("pane-history").classList.contains("hidden")) loadHistory();
  showToast(res.ok ? "Merge completed" : `Could not finish merge: ${firstError(res.out)}`);
}

export async function finishMerge() {
  await refreshAll();
  S.mergeConflicts = currentConflicts();
  if (S.mergeConflicts.length > 0) { renderResolve(); showToast("Resolve the remaining files first."); return; }
  await finalizeMerge();
}

export async function abortMerge() {
  if (!confirm("Abort the merge and discard the in-progress merge state?")) return;
  const res = await tryInvoke("lore_merge_abort", { repo: S.repoPath });
  S.mergeConflicts = [];
  $("resolve-overlay").classList.add("hidden");
  clearDetail();
  await refreshAll();
  showToast(res.ok ? "Merge aborted" : `Abort failed: ${firstError(res.out)}`);
}

// Show a conflicted file as a side-by-side comparison: left is yours (mine),
// right is the incoming change (theirs), parsed from Lore's <<<< ==== >>>>
// markers. A bar on top lets the user pick a side without going back to the list.
async function showConflictFile(path: string) {
  $("resolve-overlay").classList.add("hidden");
  showDetail(baseName(path), "Conflict - left is yours (mine), right is incoming (theirs)");
  $("detail-files").classList.add("hidden");
  showDiffView();
  $("diff-toolbar").classList.add("hidden");
  const out = $("detail-diff") as HTMLElement;
  try {
    const buf = await invoke<ArrayBuffer>("read_file_bytes", { repo: S.repoPath, path });
    const bytes = new Uint8Array(buf);
    out.classList.remove("split");
    out.innerHTML = "";
    out.appendChild(conflictActionBar(path));
    // Binary art (.fbx, textures, ...) cannot be merged or shown as text - the
    // user simply picks which whole file wins.
    if (looksBinary(bytes)) {
      const m = document.createElement("div");
      m.className = "muted small"; m.style.padding = "1rem";
      m.textContent = "Binary file - no text comparison. Use 'Use mine' or 'Use theirs' above to keep one side.";
      out.appendChild(m);
      return;
    }
    const text = new TextDecoder().decode(bytes);
    if (/^<{4,}/m.test(text)) {
      out.classList.add("split");
      out.appendChild(buildConflictGrid(text));
      return;
    }
    // No markers left (already resolved) - just show the file plainly.
    for (const line of text.split("\n")) {
      const span = document.createElement("span");
      span.className = "dl dl-ctx"; span.textContent = line + "\n";
      out.appendChild(span);
    }
  } catch (e) { out.textContent = String(e); }
}

// Top bar over a conflict view: which side is which, plus quick side-pick.
function conflictActionBar(path: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "conflict-bar";
  const label = document.createElement("span");
  label.className = "muted small";
  label.textContent = "◀ mine (yours)     theirs (incoming) ▶";
  const mine = document.createElement("button");
  mine.className = "ghost small"; mine.textContent = "Use mine";
  mine.addEventListener("click", () => resolveSide("mine", path));
  const theirs = document.createElement("button");
  theirs.className = "ghost small"; theirs.textContent = "Use theirs";
  theirs.addEventListener("click", () => resolveSide("theirs", path));
  const back = document.createElement("button");
  back.className = "ghost small"; back.textContent = "Back to list";
  back.addEventListener("click", () => openResolve());
  const acts = document.createElement("div");
  acts.className = "resolve-acts"; acts.append(mine, theirs, back);
  bar.append(label, acts);
  return bar;
}
