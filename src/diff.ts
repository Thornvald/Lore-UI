// Diff rendering: unified and side-by-side views over a unified-diff string,
// plus the merge-conflict grid that parses Lore's <<<< ==== >>>> markers into a
// mine/theirs comparison.

import { $ } from "./dom";
import { S } from "./state";
import type { ConflictRow, SbsRow } from "./types";

// Render the diff in the current mode (unified or side-by-side) and reveal the
// toggle. Keeps the text so the toggle can re-render without re-fetching.
export function renderDiff(text: string) {
  S.lastDiffText = text;
  $("diff-toolbar").classList.remove("hidden");
  ($("diff-mode") as HTMLElement).textContent = S.diffMode === "split" ? "Unified" : "Side by side";
  if (S.diffMode === "split") renderDiffSplit(text);
  else renderDiffUnified(text);
}

function renderDiffUnified(text: string) {
  const out = $("detail-diff") as HTMLPreElement;
  out.classList.remove("split");
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

// Turn a unified diff into aligned old/new rows. Runs of removals and additions
// are paired so a change shows old on the left, new on the right.
function parseSideBySide(text: string): SbsRow[] {
  const rows: SbsRow[] = [];
  const lines = text.split("\n");
  let oldN = 0, newN = 0, i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldN = parseInt(m[1], 10); newN = parseInt(m[2], 10); }
      rows.push({ type: "meta", oldText: line });
      i++; continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      rows.push({ type: "meta", oldText: line }); i++; continue;
    }
    if ((line.startsWith("-") && !line.startsWith("---")) || (line.startsWith("+") && !line.startsWith("+++"))) {
      const dels: string[] = [], adds: string[] = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) { dels.push(lines[i].slice(1)); i++; }
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) { adds.push(lines[i].slice(1)); i++; }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k], a = adds[k];
        const row: SbsRow = { type: d !== undefined && a !== undefined ? "chg" : d !== undefined ? "del" : "add" };
        if (d !== undefined) { row.oldText = d; row.oldNum = oldN++; }
        if (a !== undefined) { row.newText = a; row.newNum = newN++; }
        rows.push(row);
      }
      continue;
    }
    const t = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ type: "ctx", oldText: t, newText: t, oldNum: oldN++, newNum: newN++ });
    i++;
  }
  return rows;
}

function renderDiffSplit(text: string) {
  const out = $("detail-diff") as HTMLPreElement;
  out.classList.add("split");
  out.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "diff-split";
  for (const row of parseSideBySide(text)) {
    if (row.type === "meta") {
      const m = document.createElement("div");
      m.className = "dmeta"; m.textContent = row.oldText ?? "";
      grid.appendChild(m);
      continue;
    }
    const leftCls = row.type === "del" || row.type === "chg" ? "dl-del" : row.type === "ctx" ? "dl-ctx" : "";
    const rightCls = row.type === "add" || row.type === "chg" ? "dl-add" : row.type === "ctx" ? "dl-ctx" : "";
    grid.append(
      sbsCell(row.oldNum, "dn"),
      sbsCell(row.oldText, "dc " + leftCls),
      sbsCell(row.newNum, "dn"),
      sbsCell(row.newText, "dc " + rightCls),
    );
  }
  out.appendChild(grid);
}

export function sbsCell(val: string | number | undefined, cls: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = val === undefined ? "" : String(val);
  return d;
}

// A byte is NUL only in binary files - a cheap, reliable text/binary test.
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// Split file text into context lines (same both sides) and conflict blocks
// (mine on the left, theirs on the right), ignoring any ||||||| base section.
function parseConflictHunks(text: string): ConflictRow[] {
  const rows: ConflictRow[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (/^<{4,}/.test(lines[i])) {
      const mineLabel = lines[i].replace(/^<+\s?/, "").trim();
      const mine: string[] = [];
      const theirs: string[] = [];
      i++;
      while (i < lines.length && !/^={4,}/.test(lines[i]) && !/^\|{4,}/.test(lines[i])) { mine.push(lines[i]); i++; }
      if (i < lines.length && /^\|{4,}/.test(lines[i])) { i++; while (i < lines.length && !/^={4,}/.test(lines[i])) i++; }
      if (i < lines.length && /^={4,}/.test(lines[i])) i++;
      while (i < lines.length && !/^>{4,}/.test(lines[i])) { theirs.push(lines[i]); i++; }
      let theirsLabel = "";
      if (i < lines.length && /^>{4,}/.test(lines[i])) { theirsLabel = lines[i].replace(/^>+\s?/, "").trim(); i++; }
      rows.push({ meta: `conflict   mine${mineLabel ? " (" + mineLabel + ")" : ""}   |   theirs${theirsLabel ? " (" + theirsLabel + ")" : ""}` });
      const n = Math.max(mine.length, theirs.length);
      for (let k = 0; k < n; k++) rows.push({ left: mine[k], right: theirs[k], conflict: true });
      continue;
    }
    rows.push({ left: lines[i], right: lines[i] });
    i++;
  }
  return rows;
}

export function buildConflictGrid(text: string): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "diff-split";
  for (const r of parseConflictHunks(text)) {
    if (r.meta !== undefined) {
      const m = document.createElement("div");
      m.className = "dmeta"; m.textContent = r.meta;
      grid.appendChild(m);
      continue;
    }
    const leftCls = r.conflict ? "dl-del" : "dl-ctx";
    const rightCls = r.conflict ? "dl-add" : "dl-ctx";
    grid.append(
      sbsCell("", "dn"),
      sbsCell(r.left, "dc " + leftCls),
      sbsCell("", "dn"),
      sbsCell(r.right, "dc " + rightCls),
    );
  }
  return grid;
}
