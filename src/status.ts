// The Changes pane: fetch + render the working-tree status, the file filter /
// sort, the commit-button gating, the Push/Get-latest buttons, and the
// click-through to a working file's preview or text diff.

import { previewKind, extOf } from "./preview";
import { $, call } from "./dom";
import { S, baseName } from "./state";
import { buildTree, renderTree, changesFileRow, syncMasterCheck } from "./tree";
import { showDetail, highlightFile, showPreview, showUassetPreview, showBlendPreview, showInfoCard, showDiffView } from "./detail";
import { renderDiff } from "./diff";
import { openResolve } from "./merge";
import type { FileRow, StatusInfo } from "./types";

export async function refreshStatus() {
  const s = await call<StatusInfo>("lore_status", { repo: S.repoPath });
  if (s) { S.lastStatus = s; renderStatus(s); }
}

// The Push button shows when there is something to send: the branch is ahead /
// diverged, OR it has no copy on the remote yet. A freshly created or switched
// branch that was never pushed is reported by lore as "in sync", so without this
// the button would never appear and the user could not push it up.
export function updatePushButton() {
  const s = S.lastStatus;
  const sync = (s?.sync_state || "").toLowerCase();
  // Drive Push off the sync state from THIS status call - it is authoritative and
  // never stale. "in sync" means the commit already reached the server (Lore is
  // centralized), so showing Push then is wrong. Only a genuinely ahead/diverged
  // branch has anything to send.
  const ahead = sync.includes("ahead") || sync.includes("diverged");
  $("push-btn").classList.toggle("hidden", !ahead);
  if (ahead) $("push-sub").textContent = "send your commits";
}

function renderStatus(s: StatusInfo) {
  const sync = (s.sync_state || "").toLowerCase();
  const behind = sync.includes("behind") || sync.includes("diverged");
  // Show Get latest ONLY when the remote actually has changes to pull. Showing it
  // when up to date is error-prone (a pointless pull). Lore is centralized, so
  // status reflects the real remote - "behind"/"diverged" means there is something.
  $("sync-btn").classList.toggle("hidden", !behind);
  $("sync-sub").textContent = behind ? "remote has changes" : "up to date";
  updatePushButton();

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

  const tokens = S.fileFilter.toLowerCase().split(/[\s,]+/).filter(Boolean);
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
export function rerenderChanges() {
  if (S.lastStatus) renderStatus(S.lastStatus);
}

export function pickedFiles(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(".file-check:checked"))
    .map((b) => b.dataset.path!)
    .filter(Boolean);
}

export function updateCommitButton() {
  const has = pickedFiles().length > 0;
  const msg = ($("commit-msg") as HTMLInputElement).value.trim().length > 0;
  ($("save-btn") as HTMLButtonElement).disabled = !(has && msg);
}

// ---- Working file view (Changes tab): preview or text diff ----
export async function showWorkingFile(path: string, status = "M") {
  showDetail(baseName(path), status === "D" ? "Deleted - last committed content" : "Working changes");
  $("detail-files").classList.add("hidden");
  highlightFile(path);
  // A deleted file is gone from disk, so we can't render it - but `lore diff`
  // still shows its removed content. Route deletes to the diff instead of a dead
  // "No preview".
  if (status === "D") {
    const text = await call<string>("lore_diff", { repo: S.repoPath, path });
    if (text && /binary files differ/i.test(text)) { await showInfoCard(path); return; }
    showDiffView();
    renderDiff(text ?? "Could not load the removed content.");
    return;
  }
  const kind = previewKind(path);
  // Unreal assets try their embedded thumbnail; other binaries get an info card;
  // text files keep the line diff (unless lore reports it is binary); pictures,
  // HDR textures, models and audio get a real preview.
  if (kind === "uasset") { await showUassetPreview(path); return; }
  if (kind === "blend") { await showBlendPreview(path); return; }
  if (kind === "binary") { await showInfoCard(path); return; }
  if (kind === "other") {
    const text = await call<string>("lore_diff", { repo: S.repoPath, path });
    if (text && /binary files differ/i.test(text)) { await showInfoCard(path); return; }
    showDiffView();
    renderDiff(text ?? "Could not load changes.");
    return;
  }
  await showPreview(path);
}
