// Settings (global lore flags + per-repo identity/avatar), the local server
// control (status / start / stop with a persistent data store) and the server
// setup wizard (host vs connect, share address, store folder).

import { invoke } from "@tauri-apps/api/core";
import { $, call, closeAllPopovers } from "./dom";
import {
  S, SET_KEY, SET_CHECKS, SET_TEXTS, FLAG_OF,
  ghUserKey, authorNameKey, sleep, isLocalAddr, portOf,
  getServerAddr, getServerConfigDir,
} from "./state";
import { refreshAll } from "./project";
import { loadHistory, clearAvatarCache } from "./history";

// ---- Settings (global lore flags) ----
function settingsToObject(): Record<string, unknown> {
  const o: Record<string, unknown> = {
    source: (document.querySelector('input[name="source"]:checked') as HTMLInputElement)?.value ?? "",
    serveraddr: ($("set-serveraddr") as HTMLInputElement).value.trim(),
  };
  for (const id of SET_CHECKS) o[id] = ($(id) as HTMLInputElement).checked;
  for (const id of SET_TEXTS) o[id] = ($(id) as HTMLInputElement).value;
  return o;
}

function objectToSettings(o: Record<string, unknown>) {
  const src = (o.source as string) ?? "";
  document.querySelectorAll<HTMLInputElement>('input[name="source"]').forEach((r) => (r.checked = r.value === src));
  ($("set-serveraddr") as HTMLInputElement).value = (o.serveraddr as string) ?? "";
  for (const id of SET_CHECKS) ($(id) as HTMLInputElement).checked = !!o[id];
  for (const id of SET_TEXTS) ($(id) as HTMLInputElement).value = (o[id] as string) ?? "";
}

// ---- Server control ----
function setServerState(up: boolean) {
  // When a project is open, the meaningful Local/Remote is THAT project's server
  // (its remote_url), not the settings address - a cloned remote repo must read
  // "Remote". Fall back to the settings address when no project is open.
  const addr = S.repoPath && S.repoRemoteUrl ? S.repoRemoteUrl : getServerAddr();
  const local = S.repoPath ? !S.repoIsRemote : isLocalAddr(addr);
  const type = local ? "Local" : "Remote";

  const dot = $("server-dot");
  dot.classList.toggle("up", up);
  dot.classList.toggle("down", !up);

  // Top bar shows the type so you know which server you are driving.
  $("server-label").textContent = type;
  $("server-addr-display").textContent = addr;
  $("server-type-line").textContent = `Type: ${type} server`;
  $("server-status-line").textContent = up ? "Status: running" : "Status: not running";

  // Start only when down + local; Stop only when up + local; neither for remote.
  $("server-start").classList.toggle("hidden", up || !local);
  $("server-stop").classList.toggle("hidden", !up || !local);
  $("server-remote-note").classList.toggle("hidden", local);
}

export async function refreshServerStatus(): Promise<boolean> {
  const addr = getServerAddr();
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: addr }); } catch { up = false; }
  setServerState(up);
  return up;
}

// Start a local server if the address is local and nothing is answering.
export async function ensureServer() {
  const addr = getServerAddr();
  if (await refreshServerStatus()) return; // already up (even one started earlier) - just use it
  if (!isLocalAddr(addr)) return; // remote: connect-only, do not start
  await startLocalServer();
}

// Start the local server, defaulting to a PERSISTENT data folder so it never
// runs on temp storage (which loses every repo when it restarts).
async function startLocalServer() {
  let configDir = getServerConfigDir();
  if (!configDir) {
    try {
      const dataDir = await invoke<string>("default_server_data_dir");
      configDir = await invoke<string>("write_server_store_config", { dataDir });
      setServerConfigDir(configDir); // remember it so future starts reuse the same store
    } catch (e) { console.error(e); }
  }
  try { await invoke("lore_start_server", { configDir }); } catch (e) { console.error(e); return; }
  for (let i = 0; i < 15; i++) { await sleep(1000); if (await refreshServerStatus()) break; }
}

function setServerConfigDir(dir: string) {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  saved.serverConfigDir = dir;
  localStorage.setItem(SET_KEY, JSON.stringify(saved));
}

export async function startServerClicked() {
  closeAllPopovers();
  await startLocalServer();
}

export async function stopServerClicked() {
  closeAllPopovers();
  const out = await call<string>("lore_stop_server");
  if (out !== null) await refreshServerStatus();
}

// ---- Server setup wizard ----
export function setSetupMode(mode: "host" | "connect") {
  document.querySelectorAll<HTMLInputElement>('input[name="setupmode"]').forEach((r) => (r.checked = r.value === mode));
  $("setup-host").classList.toggle("hidden", mode !== "host");
  $("setup-connect").classList.toggle("hidden", mode !== "connect");
  document.querySelectorAll(".setup-card").forEach((c) => {
    const r = c.querySelector("input") as HTMLInputElement;
    c.classList.toggle("selected", r.checked);
  });
}

// Build the shareable address. A remote friend reaches you over Tailscale, so
// prefer the 100.x tailnet address when present; fall back to the LAN IP.
export async function refreshSetupShare() {
  const port = ($("setup-port") as HTMLInputElement).value.trim() || "41337";
  if (S.setupTsIp === undefined) {
    try { S.setupTsIp = await invoke<string | null>("tailscale_ip"); } catch { S.setupTsIp = null; }
  }
  if (S.setupLanIp === undefined) {
    try { S.setupLanIp = await invoke<string | null>("local_ip"); } catch { S.setupLanIp = null; }
  }
  const ip = S.setupTsIp || S.setupLanIp;
  if (ip) {
    $("setup-share-url").textContent = `lore://${ip}:${port}`;
    $("setup-host-note").textContent = S.setupTsIp
      ? `Tailscale address detected. Share this URL with your friend on the same tailnet (their firewall and yours must allow port ${port} TCP+UDP - QUIC uses UDP). IMPORTANT: for the repo to stay available across restarts, start the server below with a persistent data folder, not the temp quick-start.`
      : `loreserver listens on all interfaces, so teammates on your LAN or VPN can reach this once your firewall allows port ${port} (TCP+UDP). On Tailscale, share your 100.x address. The quick local server uses a TEMP folder - set a persistent data folder for a team server.`;
  } else {
    $("setup-share-url").textContent = `lore://127.0.0.1:${port}`;
    $("setup-host-note").textContent = "No shareable address found - others can only reach you over a shared LAN or VPN (e.g. Tailscale).";
  }
}

export async function refreshSetupServerState() {
  const local = "lore://127.0.0.1:" + (($("setup-port") as HTMLInputElement).value.trim() || "41337");
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: local }); } catch { up = false; }
  $("setup-server-state").textContent = up ? "Status: running" : "Status: not running";
  const toggle = $("setup-server-toggle") as HTMLButtonElement;
  toggle.textContent = up ? "Stop server" : "Start server";
  toggle.dataset.up = up ? "1" : "0";
}

export async function toggleSetupServer() {
  const toggle = $("setup-server-toggle") as HTMLButtonElement;
  const wasUp = toggle.dataset.up === "1";
  toggle.disabled = true;
  try {
    if (wasUp) await invoke("lore_stop_server");
    else await invoke("lore_start_server", { configDir: getServerConfigDir() });
  } catch (e) { alert(String(e)); }
  for (let i = 0; i < 8; i++) {
    await sleep(800);
    await refreshSetupServerState();
    if ((toggle.dataset.up === "1") !== wasUp) break;
  }
  toggle.disabled = false;
  refreshServerStatus();
}

export async function testSetupConnection() {
  const addr = ($("setup-addr") as HTMLInputElement).value.trim();
  const state = $("setup-test-state");
  if (!addr) { state.textContent = "Type an address first."; return; }
  state.textContent = "Checking…";
  let up = false;
  try { up = await invoke<boolean>("lore_server_status", { baseUrl: addr }); } catch { up = false; }
  state.textContent = up ? "Connected ✓" : "No answer ✗";
}

export function openSetup() {
  closeAllPopovers();
  const addr = getServerAddr();
  const local = isLocalAddr(addr);
  ($("setup-port") as HTMLInputElement).value = portOf(addr) || "41337";
  ($("setup-addr") as HTMLInputElement).value = local ? "" : addr;
  ($("setup-store") as HTMLInputElement).value = (JSON.parse(localStorage.getItem(SET_KEY) || "{}").serverStore as string) || "";
  $("setup-test-state").textContent = "";
  setSetupMode(local ? "host" : "connect");
  refreshSetupShare();
  refreshSetupServerState();
  $("setup-overlay").classList.remove("hidden");
}

export async function saveSetup() {
  const mode = (document.querySelector('input[name="setupmode"]:checked') as HTMLInputElement)?.value || "host";
  let addr: string;
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  if (mode === "host") {
    const port = ($("setup-port") as HTMLInputElement).value.trim() || "41337";
    // The app drives a local server over loopback; the LAN address is only for sharing.
    addr = `lore://127.0.0.1:${port}`;
    // Optional persistent data folder -> write a loreserver config dir for it.
    const store = ($("setup-store") as HTMLInputElement).value.trim();
    saved.serverStore = store;
    if (store) {
      try { saved.serverConfigDir = await invoke<string>("write_server_store_config", { dataDir: store }); }
      catch (e) { alert(String(e)); return; }
    } else {
      saved.serverConfigDir = "";
    }
  } else {
    addr = ($("setup-addr") as HTMLInputElement).value.trim();
    if (!addr) { alert("Type the server address to connect to."); return; }
  }
  saved.serveraddr = addr;
  localStorage.setItem(SET_KEY, JSON.stringify(saved));
  ($("set-serveraddr") as HTMLInputElement).value = addr;
  $("setup-overlay").classList.add("hidden");
  await ensureServer();
}

function buildGlobals(): string[] {
  const g: string[] = [];
  const source = (document.querySelector('input[name="source"]:checked') as HTMLInputElement)?.value;
  if (source) g.push(source);
  for (const id of SET_CHECKS) if (($(id) as HTMLInputElement).checked) g.push(FLAG_OF[id]);
  for (const id of SET_TEXTS) {
    const v = ($(id) as HTMLInputElement).value.trim();
    if (v) g.push(FLAG_OF[id], v);
  }
  return g;
}

export function updateSettingsPreview() {
  const g = buildGlobals();
  $("settings-preview").textContent = g.length ? "lore " + g.join(" ") + " …" : "lore … (no extra flags)";
}

export function openSettings() {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  objectToSettings(saved);
  // Per-repo identity lives in the project's config, not the global settings.
  ($("set-repoidentity") as HTMLInputElement).value = S.repoIdentity;
  ($("set-repoidentity") as HTMLInputElement).disabled = !S.repoPath;
  ($("set-ghuser") as HTMLInputElement).value = S.repoGithubUser;
  ($("set-ghuser") as HTMLInputElement).disabled = !S.repoPath;
  ($("set-authorname") as HTMLInputElement).value = S.repoAuthorName;
  ($("set-authorname") as HTMLInputElement).disabled = !S.repoPath;
  updateSettingsPreview();
  $("settings-overlay").classList.remove("hidden");
}

export async function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settingsToObject()));
  await invoke("lore_set_globals", { globals: buildGlobals() });
  if (S.repoPath) {
    let avatarChanged = false;
    const newGh = ($("set-ghuser") as HTMLInputElement).value.trim();
    if (newGh !== S.repoGithubUser) {
      S.repoGithubUser = newGh;
      if (newGh) localStorage.setItem(ghUserKey(S.repoPath), newGh);
      else localStorage.removeItem(ghUserKey(S.repoPath));
      avatarChanged = true;
    }
    const newName = ($("set-authorname") as HTMLInputElement).value.trim();
    if (newName !== S.repoAuthorName) {
      S.repoAuthorName = newName;
      if (newName) localStorage.setItem(authorNameKey(S.repoPath), newName);
      else localStorage.removeItem(authorNameKey(S.repoPath));
      avatarChanged = true; // reuse the history re-render path
    }
    const newId = ($("set-repoidentity") as HTMLInputElement).value.trim();
    if (newId !== S.repoIdentity) {
      const out = await invoke<string>("lore_set_identity", { repo: S.repoPath, identity: newId }).catch((e) => { alert(String(e)); return null; });
      if (out !== null) { S.repoIdentity = newId; avatarChanged = true; }
    }
    if (avatarChanged) {
      clearAvatarCache();
      if (!$("pane-history").classList.contains("hidden")) loadHistory();
    }
  }
  $("settings-overlay").classList.add("hidden");
  if (S.repoPath) refreshAll();
}

// Push saved settings to the backend at startup.
export async function applySavedGlobals() {
  const saved = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
  objectToSettings(saved);
  await invoke("lore_set_globals", { globals: buildGlobals() });
}
