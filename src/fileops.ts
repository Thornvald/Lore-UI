// Right-click file operations in the Changes list: reveal in Explorer, lock /
// unlock / lock-status, discard, copy path.

import { invoke } from "@tauri-apps/api/core";
import { call, closeAllPopovers } from "./dom";
import { S } from "./state";
import { showTextDetail } from "./detail";
import { discardFiles } from "./commit";
import type { CtxItem } from "./types";

export function fileMenu(path: string): CtxItem[] {
  return [
    { label: "Reveal in Explorer", run: () => revealInExplorer(path) },
    { label: "Lock file", run: () => lockFile(path, true) },
    { label: "Unlock file", run: () => lockFile(path, false) },
    { label: "Lock status", run: () => lockStatus(path) },
    { sep: true },
    { label: "Discard changes", danger: true, run: () => discardFiles([path]) },
    { label: "Copy path", run: () => navigator.clipboard?.writeText(path) },
  ];
}

// Open the OS file browser with the file selected, or the repo folder if no path.
export async function revealInExplorer(path = "") {
  closeAllPopovers();
  await invoke("reveal_in_explorer", { repo: S.repoPath, path }).catch((e) => alert(String(e)));
}

async function lockFile(path: string, lock: boolean) {
  const out = await call<string>(lock ? "lore_lock_acquire" : "lore_lock_release", { repo: S.repoPath, path });
  if (out !== null) alert(out.trim() || (lock ? "Locked." : "Unlocked."));
}

async function lockStatus(path: string) {
  const out = await call<string>("lore_lock_status", { repo: S.repoPath, path });
  if (out !== null) showTextDetail("Lock status", path, out.trim() || "No lock information.");
}
