// Generic UI primitives used everywhere: the element getter, the Rust-command
// wrapper, toasts, the text-input modal, popovers and the right-click menu.

import { invoke } from "@tauri-apps/api/core";
import type { CtxItem } from "./types";

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Invoke a Rust command; on error pop an alert and return null.
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  document.body.style.cursor = "progress";
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    alert(String(e));
    return null;
  } finally {
    document.body.style.cursor = "default";
  }
}

// Invoke without the alert() that `call` throws up. The merge flow wants every
// outcome (clean, nothing-to-merge, failed) to land as a smooth toast, not a popup.
export async function tryInvoke(cmd: string, args: Record<string, unknown>): Promise<{ ok: boolean; out: string }> {
  try { return { ok: true, out: (await invoke<string>(cmd, args)) ?? "" }; }
  catch (e) { return { ok: false, out: String(e) }; }
}

let toastTimer = 0;
export function showToast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}

export function askText(title: string, hint = "", def = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = $("ask-overlay");
    const input = $("ask-input") as HTMLInputElement;
    $("ask-title").textContent = title;
    $("ask-hint").textContent = hint;
    $("ask-hint").classList.toggle("hidden", !hint);
    input.value = def;
    overlay.classList.remove("hidden");
    input.focus(); input.select();
    const close = (val: string | null) => { overlay.classList.add("hidden"); input.onkeydown = null; resolve(val); };
    ($("ask-ok") as HTMLButtonElement).onclick = () => close(input.value.trim());
    ($("ask-cancel") as HTMLButtonElement).onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    input.onkeydown = (e) => { if (e.key === "Enter") close(input.value.trim()); if (e.key === "Escape") close(null); };
  });
}

export function openPopover(menu: HTMLElement, btn: HTMLElement) {
  const showing = !menu.classList.contains("hidden");
  closeAllPopovers();
  if (showing) return;
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + "px";
  menu.style.left = r.left + "px";
  menu.classList.remove("hidden");
}

export function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach((p) => p.classList.add("hidden"));
}

export function openContextMenu(x: number, y: number, items: CtxItem[]) {
  closeAllPopovers();
  const menu = $("ctx-menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "popover-divider";
      menu.appendChild(d);
      continue;
    }
    const b = document.createElement("button");
    b.className = "popover-item" + (it.danger ? " danger" : "");
    b.textContent = it.label ?? "";
    b.addEventListener("click", () => { closeAllPopovers(); it.run?.(); });
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  // Keep the menu inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}

// Pull a short, human line out of lore's error text for a toast.
export function firstError(out: string): string {
  const err = out.split("\n").map((s) => s.trim()).find((s) => s.startsWith("[Error]"));
  const line = err ? err.replace(/^\[Error\]\s*/, "") : (out.trim().split("\n")[0] || "unknown error");
  return line.slice(0, 120);
}
