// Saving (stage + commit), Get-latest (sync), Push, and discarding working-tree
// changes. The Push handler carries the careful error handling for Lore's two
// awkward states (diverged, "missing fragments").

import { invoke } from "@tauri-apps/api/core";
import { $, call, showToast } from "./dom";
import { S } from "./state";
import { clearDetail } from "./detail";
import { pickedFiles, refreshStatus } from "./status";
import { refreshAll } from "./project";

export async function save() {
  const files = pickedFiles();
  const msg = ($("commit-msg") as HTMLInputElement).value.trim();
  if (files.length === 0 || !msg) return;
  if ((await call<string>("lore_stage", { repo: S.repoPath, files })) === null) return;
  if ((await call<string>("lore_commit", { repo: S.repoPath, message: msg })) === null) return;
  ($("commit-msg") as HTMLInputElement).value = "";
  clearDetail();
  await refreshAll();
}

export async function syncAction() {
  const out = await call<string>("lore_sync", { repo: S.repoPath });
  if (out !== null) await refreshAll();
}

export async function pushAction() {
  try {
    const out = await invoke<string>("lore_push", { repo: S.repoPath });
    await refreshAll();
    showToast(/already pushed|already at remote|remote latest|up to date|up-to-date|nothing to push/i.test(out || "")
      ? "Already up to date" : "Pushed to remote");
  } catch (e) {
    const msg = String(e);
    // Diverged: the remote moved on too. Offer to Get latest (merge) then push.
    if (/diverg|sync/i.test(msg)) {
      if (confirm("Can't push - the remote has commits you don't have yet. Get latest to merge them first, then push again?\n\nGet latest now?")) {
        const s = await call<string>("lore_sync", { repo: S.repoPath });
        if (s !== null) await refreshAll();
      }
      return;
    }
    // "Missing fragments": this project's local store thinks its file data is
    // already on the server, so push sends nothing, but the server doesn't have
    // it. The server itself is fine (other projects push). No in-app retry fixes
    // this stale state - the project has to be re-created.
    if (/missing fragments/i.test(msg)) {
      alert(
        "Can't push - this project thinks its files are already on the server, so it sends " +
        "nothing, but the server doesn't have them.\n\n" +
        "The server itself is working (other projects push fine) - this is this project's own " +
        "upload record being out of sync, which a push can't repair.\n\n" +
        "Fix: re-create the project - close it, delete its .lore folder, then use Create to make " +
        "a fresh one on the server and commit + push again."
      );
      return;
    }
    alert(msg);
  }
}

// ---- Discard ----
export async function discardFiles(files: string[]) {
  if (files.length === 0) return;
  const what = files.length === 1 ? `"${files[0]}"` : `${files.length} files`;
  if (!confirm(`Discard changes to ${what}? This cannot be undone.`)) return;
  const out = await call<string>("lore_discard", { repo: S.repoPath, files });
  if (out !== null) { clearDetail(); await refreshStatus(); }
}

export async function discardAll() {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>(".file-check"))
    .map((b) => b.dataset.path!)
    .filter(Boolean);
  await discardFiles(all);
}
