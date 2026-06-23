// The folder tree shared by the Changes list and the per-commit file list:
// folds flat "a/b/file" paths into collapsible folders (Fork-style), plus the
// per-row visuals (status tag + thumbnail/glyph) and the two file-row builders.

import { invoke } from "@tauri-apps/api/core";
import { previewKind, extOf, renderModelThumbnail } from "./preview";
import { $, call, openContextMenu } from "./dom";
import { S, STATUS_LABEL } from "./state";
import type { FileChange, FileMeta, FileRow, TreeNode } from "./types";

// Fold flat paths into a folder tree.
export function buildTree(items: { path: string; payload: unknown }[]): TreeNode {
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
    if (S.fileSort === "type" && !a.dir && !b.dir) {
      const ea = extOf(a.name), eb = extOf(b.name);
      if (ea !== eb) return ea.localeCompare(eb);
    }
    return a.name.localeCompare(b.name);
  });
}

const indent = (depth: number) => depth * 14 + 8 + "px";

export function renderTree(
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
export function changesFileRow(node: TreeNode, depth: number): HTMLElement {
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

  row.addEventListener("click", () => showWorkingFile(r.change.path, r.change.status));
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, fileMenu(r.change.path)); });
  return row;
}

// A file row inside a commit's changed-files tree (no checkbox/discard).
// Clicking shows the line diff, or a preview for pictures/models still on disk.
export function commitFileRow(f: FileChange, name: string, depth: number, source: string, target: string, box: HTMLElement): HTMLElement {
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
      const meta = await call<FileMeta>("file_meta", { repo: S.repoPath, path: f.path });
      if (meta && meta.exists) {
        if (k === "uasset") await showUassetPreview(f.path);
        else if (k === "blend") await showBlendPreview(f.path);
        else await showPreview(f.path, "current file on disk");
        return;
      }
      // Previewable but not in the working tree - Lore can't extract a past
      // binary, so show an info card instead of a raw "Binary files differ".
      await showInfoCard(f.path);
      $("preview-caption").textContent = `${f.path} · not in your working tree (can't preview a past binary)`;
      return;
    }
    showDiffView();
    const text = await call<string>("lore_commit_file_diff", { repo: S.repoPath, source, target, path: f.path });
    renderDiff(text ?? "Could not load diff.");
  });
  return row;
}

// Leading visual for a file row: a real thumbnail for pictures and Unreal
// assets, a small kind glyph for everything else - so every file shows
// something next to its name.
function fileVisual(path: string): HTMLElement {
  const kind = previewKind(path);
  if (kind === "image") { const img = thumbImg(); attachThumb(img, path); return img; }
  if (kind === "uasset") { const img = thumbImg(); attachUassetThumb(img, path); return img; }
  if (kind === "model") { const img = thumbImg(); attachModelThumb(img, path); return img; }
  if (kind === "blend") { const img = thumbImg(); attachBlendThumb(img, path); return img; }
  const ic = document.createElement("span");
  ic.className = "row-icon";
  ic.textContent = kindGlyph(kind);
  return ic;
}

// Cache rendered model thumbnails (data URLs) by path+size so list refreshes and
// re-opens are instant.
const modelThumbCache = new Map<string, string>();
// Render a tiny 3D thumbnail for a model row in the background. Big models are
// skipped (do not read a 200 MB fbx for a 72px square).
async function attachModelThumb(img: HTMLImageElement, path: string) {
  try {
    const meta = await invoke<FileMeta>("file_meta", { repo: S.repoPath, path });
    if (!meta.exists || meta.size > 48 * 1024 * 1024) return;
    const key = path + ":" + meta.size;
    const cached = modelThumbCache.get(key);
    if (cached) { img.src = cached; img.classList.add("loaded"); return; }
    const buf = await readFileBytesCached(path, meta.size);
    const url = await renderModelThumbnail(buf, extOf(path));
    if (url) { modelThumbCache.set(key, url); img.src = url; img.classList.add("loaded"); }
  } catch { /* keep the icon */ }
}

// Blend rows get a 3D thumbnail too - but only once the file has a cached glb
// (converting every .blend in a list would be far too slow). A blend gets cached
// the first time it is opened in the preview pane.
async function attachBlendThumb(img: HTMLImageElement, path: string) {
  try {
    const cached = await invoke<boolean>("blend_is_cached", { repo: S.repoPath, path });
    if (!cached) return; // leave the placeholder; opening it once will cache it
    const meta = await invoke<FileMeta>("file_meta", { repo: S.repoPath, path });
    const key = "blend:" + path + ":" + (meta?.size ?? 0);
    const hit = modelThumbCache.get(key);
    if (hit) { img.src = hit; img.classList.add("loaded"); return; }
    const glb = await invoke<ArrayBuffer>("blend_to_glb", { repo: S.repoPath, path });
    const url = await renderModelThumbnail(glb, "glb");
    if (url) { modelThumbCache.set(key, url); img.src = url; img.classList.add("loaded"); }
  } catch { /* keep the icon */ }
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

// Cache raw file bytes (keyed by path+size) so a row thumbnail and the big
// preview of the same file don't each read + parse it from disk. Bounded.
const fileBytesCache = new Map<string, ArrayBuffer>();
export async function readFileBytesCached(path: string, size: number): Promise<ArrayBuffer> {
  const key = path + ":" + size;
  const hit = fileBytesCache.get(key);
  if (hit) return hit;
  const buf = await invoke<ArrayBuffer>("read_file_bytes", { repo: S.repoPath, path });
  fileBytesCache.set(key, buf);
  if (fileBytesCache.size > 6) { const k = fileBytesCache.keys().next().value; if (k) fileBytesCache.delete(k); }
  return buf;
}

// Load a small inline thumbnail for an image row (skips big/missing files so a
// 4K texture does not get read just to draw a 20px square).
async function attachThumb(img: HTMLImageElement, path: string) {
  try {
    const meta = await invoke<FileMeta>("file_meta", { repo: S.repoPath, path });
    if (!meta.exists || meta.size > 4 * 1024 * 1024) return;
    const buf = await readFileBytesCached(path, meta.size);
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
    const meta = await invoke<FileMeta>("file_meta", { repo: S.repoPath, path });
    if (!meta.exists || meta.size > 64 * 1024 * 1024) return;
    const buf = await invoke<ArrayBuffer>("read_uasset_thumb", { repo: S.repoPath, path });
    const url = URL.createObjectURL(new Blob([buf]));
    img.onload = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    img.classList.add("loaded");
  } catch { /* no embedded thumbnail */ }
}

// Keep the master checkbox honest: checked only when every file is checked,
// indeterminate when some are.
export function onFileCheckChange() { updateCommitButton(); syncMasterCheck(); }
export function syncMasterCheck() {
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#file-list .file-check")];
  const checked = boxes.filter((b) => b.checked).length;
  const master = $("check-all") as HTMLInputElement;
  master.checked = boxes.length > 0 && checked === boxes.length;
  master.indeterminate = checked > 0 && checked < boxes.length;
}

import { discardFiles } from "./commit";
import { showWorkingFile, updateCommitButton } from "./status";
import { showUassetPreview, showBlendPreview, showPreview, showInfoCard, showDiffView } from "./detail";
import { renderDiff } from "./diff";
import { fileMenu } from "./fileops";
