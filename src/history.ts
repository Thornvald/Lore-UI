// The History pane: load + flatten revisions (weaving merged-in branch lanes),
// draw the commit graph + merge curves, per-commit author avatars, the commit
// detail view, and the revision right-click operations.

import { invoke } from "@tauri-apps/api/core";
import { $, call, askText, openContextMenu } from "./dom";
import { S, shortDate } from "./state";
import { showDetail, clearDetail, showTextDetail } from "./detail";
import { buildTree, renderTree, commitFileRow } from "./tree";
import { refreshAll } from "./project";
import { refreshBranches } from "./branches";
import type { Commit, CtxItem, FileChange } from "./types";

export async function loadHistory() {
  const h = await call<Commit[]>("lore_history", { repo: S.repoPath });
  if (!h) return;
  const mainSigs = new Set(h.map((c) => c.signature));
  // For a merge whose second parent lives on another branch, pull that branch's
  // own commits (`history --revision <sig> --only-branch`) so we can show them as
  // a second lane instead of a dead-end merge dot.
  const subBySig = new Map<string, Commit[]>();
  await Promise.all(
    h.filter((c) => c.is_merge && c.merge_parent && !mainSigs.has(c.merge_parent)).map(async (c) => {
      // Use invoke + catch (not call) so a missing command on an older build, or
      // an unreachable revision, just skips the sub-lane instead of popping an alert.
      const sub = await invoke<Commit[]>("lore_history_from", { repo: S.repoPath, revision: c.merge_parent }).catch(() => null);
      if (sub && sub.length) subBySig.set(c.signature, sub);
    })
  );
  // Flatten into display order: this branch in lane 0, each merged-in branch's
  // unique commits in lane 1 right under the merge that brought them in.
  const flat: Commit[] = [];
  const parents: (Commit | undefined)[] = [];
  const lanes: number[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < h.length; k++) {
    const c = h[k];
    if (!seen.has(c.signature)) {
      seen.add(c.signature);
      flat.push(c); parents.push(h[k + 1]); lanes.push(0);
    }
    const sub = subBySig.get(c.signature);
    if (!sub) continue;
    const fresh = sub.filter((s) => !mainSigs.has(s.signature));
    const base = sub.find((s) => mainSigs.has(s.signature)); // shared fork point
    for (let m = 0; m < fresh.length; m++) {
      const s = fresh[m];
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      flat.push(s); parents.push(fresh[m + 1] ?? base); lanes.push(1);
    }
  }
  S.history = flat;
  S.histParents = parents;
  S.histLanes = lanes;

  const box = $("history-list");
  box.innerHTML = "";
  $("history-head").textContent = h.length ? `History · ${h.length} revisions` : "History";
  S.history.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "gh-commit" + (S.histLanes[i] ? " lane-sub" : "");
    row.dataset.idx = String(i);
    row.dataset.sig = c.signature;

    // Graph rail: a dot on its lane, with a connecting line drawn in CSS.
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
    // Show the actual committer of THIS commit (when Lore retained it), not the
    // local identity - otherwise everyone sees their own name on all commits.
    const author = (c.author || "").trim();
    meta.append(authorAvatar(author));
    const name = document.createElement("span");
    name.className = "commit-author";
    name.textContent = authorName(author);
    name.title = author || "author not recorded by the server";
    meta.append(name);
    meta.append(document.createTextNode(
      `${c.is_merge ? " merge · " : " "}rev ${c.revision} · ${shortDate(c.date)}`
    ));
    body.append(subject, meta);

    row.append(rail, body);
    row.addEventListener("click", () => showCommit(i));
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, commitMenu(c, i)); });
    box.appendChild(row);
  });
  requestAnimationFrame(() => drawMergeLines(box));
}

// How far the merged-in lane is pushed right from the main lane (keep in sync
// with the .lane-sub rail padding in CSS).
const LANE_INDENT = 16;
// Draw a curved connector from each merge commit to the revision it merged in
// (its second parent). With a merged-in branch woven in, that revision is now a
// real row in lane 1, so the curve reaches the actual merged commit.
function drawMergeLines(box: HTMLElement) {
  box.querySelector(".merge-svg")?.remove();
  const rows = [...box.querySelectorAll<HTMLElement>(".gh-commit")];
  if (rows.length === 0) return;
  const sigToIdx = new Map(S.history.map((c, i) => [c.signature, i]));
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "merge-svg");
  svg.style.cssText = `position:absolute;left:0;top:0;width:60px;height:${box.scrollHeight}px;pointer-events:none;`;
  const dotY = (el: HTMLElement) => el.offsetTop + el.offsetHeight / 2;
  const laneX = (i: number) => 13 + (S.histLanes[i] ? LANE_INDENT : 0);
  let drew = false;
  S.history.forEach((c, i) => {
    if (!c.is_merge || !c.merge_parent) return;
    const j = sigToIdx.get(c.merge_parent);
    if (j === undefined || j === i || !rows[j]) return;
    const x1 = laneX(i), x2 = laneX(j), y1 = dotY(rows[i]), y2 = dotY(rows[j]);
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", branchColor(c.branch));
    path.setAttribute("stroke-width", "2");
    path.setAttribute("opacity", "0.85");
    svg.appendChild(path);
    drew = true;
  });
  if (drew) { box.style.position = "relative"; box.insertBefore(svg, box.firstChild); }
}

// Per-commit avatar: initials + a stable colour derived from THAT commit's
// author email, with their GitHub/Gravatar photo when the email resolves. An
// empty email (Lore did not retain the author) shows a neutral "?" chip - we do
// NOT fall back to the local identity, which would mislabel everyone's commits.
const avatarByEmail = new Map<string, string>(); // email -> confirmed-loadable url
function authorAvatar(email: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "avatar";
  const seed = email || "unknown";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  el.style.background = `hsl(${hash % 360} 30% 38%)`;
  el.textContent = (email || "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  if (email.includes("@")) {
    resolveAvatarForEmail(email).then((url) => paintAvatar(el, url)).catch(() => {});
  }
  return el;
}

// Resolve one email to an avatar URL (GitHub account by public email, else
// Gravatar), cached per email so different committers keep distinct pictures.
async function resolveAvatarForEmail(email: string): Promise<string> {
  const hit = avatarByEmail.get(email);
  if (hit) return hit;
  let url = "";
  try {
    const res = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const u: string | undefined = (await res.json())?.items?.[0]?.avatar_url;
      if (u) url = u + (u.includes("?") ? "&" : "?") + "s=48";
    }
  } catch { /* offline or rate-limited - fall through to Gravatar */ }
  if (!url) url = await gravatarUrl(email);
  avatarByEmail.set(email, url);
  return url;
}

function paintAvatar(el: HTMLElement, url: string) {
  const probe = new Image();
  probe.onload = () => { el.style.backgroundImage = `url(${url})`; el.style.backgroundSize = "cover"; el.textContent = ""; };
  probe.src = url; // on error keep the initials chip
}

// A friendly name for a committer email ("a@b.com" -> "a"), or "unknown".
function authorName(email: string): string {
  if (!email) return "unknown";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
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

export function clearAvatarCache() { avatarByEmail.clear(); }

async function showCommit(i: number) {
  const c = S.history[i];
  const parent = S.histParents[i]; // real parent for this row (handles woven lanes)
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
    repo: S.repoPath, source: parent.signature, target: c.signature,
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
    repo: S.repoPath, revision: c.signature, message: `Revert: ${subject}`,
  });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

async function undoCommit(parent: Commit) {
  if (!confirm("Undo the latest commit? It is removed and the working tree resets to the previous commit.")) return;
  const out = await call<string>("lore_undo_commit", { repo: S.repoPath, revision: parent.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

function commitMenu(c: Commit, i: number): CtxItem[] {
  const isLatest = i === 0;
  const parent = S.histParents[i];
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

// ---- Revision ops ----
async function syncToRevision(c: Commit) {
  if (!confirm(`Sync the working tree to revision ${c.revision}? Local changes may be affected.`)) return;
  const out = await call<string>("lore_revision_sync", { repo: S.repoPath, revision: c.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

async function createBranchAt(c: Commit) {
  const name = await askText("New branch name", "The branch is created at the selected revision.");
  if (!name) return;
  const out = await call<string>("lore_branch_create_at", { repo: S.repoPath, name: name.trim(), revision: c.signature });
  if (out !== null) await refreshBranches();
}

async function resetBranchTo(c: Commit) {
  if (!confirm(`Move the current branch to revision ${c.revision}? This rewrites local history after it.`)) return;
  const out = await call<string>("lore_branch_reset", { repo: S.repoPath, revision: c.signature });
  if (out !== null) { clearDetail(); await refreshAll(); await loadHistory(); }
}

async function cherryPick(c: Commit) {
  if (!confirm(`Cherry-pick revision ${c.revision} onto the current revision?`)) return;
  const out = await call<string>("lore_revision_cherry_pick", { repo: S.repoPath, revision: c.signature });
  if (out !== null) { warnIfConflict(out); clearDetail(); await refreshAll(); await loadHistory(); }
}

async function amendLatest(c: Commit) {
  const msg = await askText("New message for the latest commit", "", c.message.split("\n")[0]);
  if (!msg) return;
  const out = await call<string>("lore_revision_amend", { repo: S.repoPath, message: msg.trim() });
  if (out !== null) { await refreshAll(); await loadHistory(); }
}

async function revisionInfo(c: Commit) {
  const out = await call<string>("lore_revision_info", { repo: S.repoPath, revision: c.signature });
  if (out !== null) showTextDetail(`Revision ${c.revision}`, c.signature, out);
}

function warnIfConflict(out: string) {
  if (/conflict/i.test(out)) {
    alert("This left conflicts. For now, resolve or abort it from the Console (the resolve / abort subcommands).");
  }
}
