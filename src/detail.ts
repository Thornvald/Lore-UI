// The right-hand detail pane: its header, the live file preview (image / 3D /
// Unreal thumbnail / blend / honest info card) and the show/clear plumbing that
// every view routes through.

import { invoke } from "@tauri-apps/api/core";
import { mountPreview, previewKind, extOf } from "./preview";
import { $, call } from "./dom";
import { S, humanSize } from "./state";
import { readFileBytesCached } from "./tree";
import { rerenderChanges } from "./status";
import type { FileMeta } from "./types";

export function showDetail(title: string, sub: string) {
  $("detail-empty").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("detail-title").textContent = title;
  $("detail-sub").textContent = sub;
  $("detail-actions").innerHTML = "";
}

export function clearDetail() {
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

export function highlightFile(path: string) {
  document.querySelectorAll("#file-list .tree-file").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.path === path)
  );
}

// Show plain command text (revision / branch info / lock status) in the detail pane.
export function showTextDetail(title: string, sub: string, text: string) {
  showDetail(title, sub);
  $("detail-files").classList.add("hidden");
  showDiffView();
  $("diff-toolbar").classList.add("hidden");
  const out = $("detail-diff");
  out.classList.remove("split");
  out.textContent = text;
}

export function showDiffView() {
  disposePreview();
  $("detail-preview").classList.add("hidden");
  $("preview-caption").classList.add("hidden");
  $("detail-diff").classList.remove("hidden");
}

export function disposePreview() {
  if (S.previewCleanup) { try { S.previewCleanup(); } catch { /* ignore cleanup errors */ } S.previewCleanup = null; }
  $("detail-preview").innerHTML = "";
}

// Unreal .uasset/.umap: show the embedded editor thumbnail if the asset has one,
// otherwise fall back to the info card. Real mesh/texture rendering needs the
// engine, which a web view cannot do.
export async function showUassetPreview(path: string) {
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
  try { bytes = await invoke<ArrayBuffer>("read_uasset_thumb", { repo: S.repoPath, path }); } catch { bytes = null; }
  if (bytes && bytes.byteLength > 0) {
    host.innerHTML = "";
    const res = await mountPreview(host, bytes, "thumbnail.png");
    S.previewCleanup = res.cleanup;
    caption.textContent = ["Unreal asset - embedded thumbnail", res.info].filter(Boolean).join("  ·  ");
    return;
  }
  await showInfoCard(path);
}

// Cache converted glb per .blend (by path + size) so re-opening is instant.
const glbCache = new Map<string, ArrayBuffer>();
// .blend: convert to glb with a headless Blender, then show it in the same 3D
// viewer as an FBX (real geometry). The first conversion takes a few seconds.
export async function showBlendPreview(path: string) {
  disposePreview();
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  const host = $("detail-preview");
  host.classList.remove("hidden");
  const caption = $("preview-caption");
  caption.classList.remove("hidden");

  const meta = await call<FileMeta>("file_meta", { repo: S.repoPath, path });
  const key = path + ":" + (meta?.size ?? 0);
  let glb = glbCache.get(key);
  if (!glb) {
    host.innerHTML = `<div class="preview-msg muted">Converting with Blender…<br><span class="small">first time can take a few seconds</span></div>`;
    caption.textContent = "Converting…";
    try {
      glb = await invoke<ArrayBuffer>("blend_to_glb", { repo: S.repoPath, path });
      glbCache.set(key, glb);
    } catch (e) {
      host.innerHTML = `<div class="preview-msg muted">Could not show this .blend in 3D.<br><span class="small">${String(e)}</span></div>`;
      caption.classList.add("hidden");
      return;
    }
  }
  host.innerHTML = "";
  const res = await mountPreview(host, glb, "model.glb");
  S.previewCleanup = res.cleanup;
  caption.textContent = [res.info, humanSize(glb.byteLength)].filter(Boolean).join("  ·  ");
  // The file now has a cached glb, so its row can show a 3D thumbnail.
  if (!$("pane-changes").classList.contains("hidden")) rerenderChanges();
}

// Honest fallback for binary files we cannot draw (Unreal .uasset, .blend, ...).
export async function showInfoCard(path: string) {
  disposePreview();
  $("detail-diff").classList.add("hidden");
  $("detail-diff").textContent = "";
  $("diff-toolbar").classList.add("hidden");
  const host = $("detail-preview");
  host.classList.remove("hidden");
  const caption = $("preview-caption");
  caption.classList.remove("hidden");
  caption.textContent = path;
  const meta = await call<FileMeta>("file_meta", { repo: S.repoPath, path });
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
export async function showPreview(path: string, captionExtra = "") {
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
    const meta = await call<FileMeta>("file_meta", { repo: S.repoPath, path });
    bytes = await readFileBytesCached(path, meta?.size ?? 0);
  } catch (e) {
    host.innerHTML = `<div class="preview-msg muted">No preview.<br><span class="small">${String(e)}</span></div>`;
    caption.classList.add("hidden");
    return;
  }
  host.innerHTML = "";
  const res = await mountPreview(host, bytes, path);
  S.previewCleanup = res.cleanup;
  const parts = [res.info, humanSize(bytes.byteLength)];
  if (captionExtra) parts.push(captionExtra);
  caption.textContent = parts.filter(Boolean).join("  ·  ");
}

// re-exported for callers that only need the kind classifier alongside previews.
export { previewKind };
