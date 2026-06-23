// App entry point: wire DOM elements to handlers, then bring the server up and
// re-open the last project. All real behaviour lives in the focused modules this
// file pulls together.

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { $, openPopover, openContextMenu, closeAllPopovers } from "./dom";
import { S } from "./state";
import { renderDiff } from "./diff";
import {
  openProject, createProject, cloneProject, renderRecent, enterProject,
  selectNav, setupSplitter, startChangeWatcher, refreshOnFocus,
} from "./project";
import { revealInExplorer } from "./fileops";
import { newBranch, doSwitch } from "./branches";
import { save, syncAction, pushAction, discardAll } from "./commit";
import { rerenderChanges, updateCommitButton, refreshStatus } from "./status";
import { openMergeModal, doMerge, finishMerge, abortMerge, resolveSide } from "./merge";
import { toggleConsole, runConsole, buildCommandList } from "./console";
import {
  openSettings, saveSettings, openSetup, saveSetup, toggleSetupServer,
  testSetupConnection, setSetupMode, refreshSetupShare, refreshSetupServerState,
  updateSettingsPreview, applySavedGlobals, ensureServer, refreshServerStatus,
  startServerClicked, stopServerClicked,
} from "./settings";

window.addEventListener("DOMContentLoaded", () => {
  $("open-btn").addEventListener("click", openProject);
  $("open-btn-2").addEventListener("click", openProject);
  $("create-btn").addEventListener("click", createProject);
  $("create-btn-2").addEventListener("click", createProject);
  $("clone-btn").addEventListener("click", cloneProject);
  $("clone-btn-2").addEventListener("click", cloneProject);
  $("reveal-repo-btn").addEventListener("click", () => revealInExplorer(""));

  $("proj-btn").addEventListener("click", (e) => { e.stopPropagation(); renderRecent(); openPopover($("proj-menu"), $("proj-btn")); });
  $("proj-btn").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (S.repoPath) openContextMenu(e.clientX, e.clientY, [{ label: "Reveal repo in Explorer", run: () => revealInExplorer("") }]);
  });
  $("branch-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("branch-menu"), $("branch-btn")); });
  $("sync-btn").addEventListener("click", syncAction);
  $("push-btn").addEventListener("click", pushAction);
  $("newbranch-btn").addEventListener("click", newBranch);
  $("merge-open-btn").addEventListener("click", openMergeModal);
  $("merge-ok").addEventListener("click", doMerge);
  $("merge-cancel").addEventListener("click", () => $("merge-overlay").classList.add("hidden"));
  $("merge-overlay").addEventListener("click", (e) => { if (e.target === $("merge-overlay")) $("merge-overlay").classList.add("hidden"); });

  // Merge conflict resolve.
  $("merge-finish").addEventListener("click", finishMerge);
  $("merge-abort").addEventListener("click", abortMerge);
  $("resolve-all-mine").addEventListener("click", () => resolveSide("mine"));
  $("resolve-all-theirs").addEventListener("click", () => resolveSide("theirs"));

  // Don't let the webview remember/autofill text inputs (e.g. commit messages).
  document.querySelectorAll("input").forEach((i) => i.setAttribute("autocomplete", "off"));

  $("nav-changes").addEventListener("click", () => selectNav("changes"));
  $("nav-history").addEventListener("click", () => selectNav("history"));
  $("nav-newbranch").addEventListener("click", (e) => { e.stopPropagation(); newBranch(); });
  $("sort-mode").addEventListener("change", (e) => { S.fileSort = (e.target as HTMLSelectElement).value as "name" | "type"; rerenderChanges(); });
  $("filter-ext").addEventListener("input", (e) => { S.fileFilter = (e.target as HTMLInputElement).value; rerenderChanges(); });

  $("save-btn").addEventListener("click", save);
  $("commit-msg").addEventListener("input", updateCommitButton);
  $("discard-all").addEventListener("click", discardAll);
  $("refresh-changes").addEventListener("click", () => { if (S.repoPath) refreshStatus(); });
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOnFocus(); });
  $("check-all").addEventListener("change", (e) => {
    const master = e.target as HTMLInputElement;
    master.indeterminate = false;
    document.querySelectorAll<HTMLInputElement>("#file-list .file-check").forEach((b) => (b.checked = master.checked));
    updateCommitButton();
  });

  $("console-toggle").addEventListener("click", toggleConsole);
  $("server-btn").addEventListener("click", (e) => { e.stopPropagation(); openPopover($("server-menu"), $("server-btn")); });
  $("server-start").addEventListener("click", startServerClicked);
  $("server-stop").addEventListener("click", stopServerClicked);
  $("settings-btn").addEventListener("click", openSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-cancel").addEventListener("click", () => $("settings-overlay").classList.add("hidden"));
  $("settings-overlay").addEventListener("click", (e) => { if (e.target === $("settings-overlay")) $("settings-overlay").classList.add("hidden"); });

  // Server setup wizard.
  $("setup-btn-2").addEventListener("click", openSetup);
  $("server-setup").addEventListener("click", openSetup);
  $("setup-cancel").addEventListener("click", () => $("setup-overlay").classList.add("hidden"));
  $("setup-overlay").addEventListener("click", (e) => { if (e.target === $("setup-overlay")) $("setup-overlay").classList.add("hidden"); });
  $("setup-save").addEventListener("click", saveSetup);
  $("setup-copy").addEventListener("click", () => navigator.clipboard?.writeText($("setup-share-url").textContent || ""));
  $("setup-server-toggle").addEventListener("click", toggleSetupServer);
  $("setup-test").addEventListener("click", testSetupConnection);
  $("setup-store-browse").addEventListener("click", async () => {
    const picked = await open({ directory: true, title: "Pick a folder to keep server data" });
    if (typeof picked === "string") ($("setup-store") as HTMLInputElement).value = picked;
  });

  // Branch-switch dirty guard.
  $("switch-cancel").addEventListener("click", () => $("switch-overlay").classList.add("hidden"));
  $("switch-bring").addEventListener("click", () => { $("switch-overlay").classList.add("hidden"); doSwitch(S.switchTargetName, false); });
  $("switch-reset").addEventListener("click", () => {
    if (!confirm(`Reset local changes to match "${S.switchTargetName}"? Your uncommitted edits will be lost.`)) return;
    $("switch-overlay").classList.add("hidden");
    doSwitch(S.switchTargetName, true);
  });
  $("switch-overlay").addEventListener("click", (e) => { if (e.target === $("switch-overlay")) $("switch-overlay").classList.add("hidden"); });
  $("setup-port").addEventListener("input", () => { refreshSetupShare(); refreshSetupServerState(); });
  document.querySelectorAll('input[name="setupmode"]').forEach((r) =>
    r.addEventListener("change", () => setSetupMode((r as HTMLInputElement).value as "host" | "connect"))
  );
  document.querySelectorAll("#settings-overlay input, #settings-overlay select")
    .forEach((el) => el.addEventListener("change", updateSettingsPreview));
  applySavedGlobals();
  $("cmd-run").addEventListener("click", () => runConsole());
  $("cmd-input").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runConsole(); });
  buildCommandList();
  setupSplitter();
  $("diff-mode").addEventListener("click", () => {
    S.diffMode = S.diffMode === "split" ? "unified" : "split";
    localStorage.setItem("diffMode", S.diffMode);
    if (S.lastDiffText) renderDiff(S.lastDiffText);
  });

  // Close popovers on outside click / Escape.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".popover") && !t.closest(".gh-dd")) closeAllPopovers();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllPopovers(); });

  // Bring the server up (auto-start local), then keep the status dot fresh.
  ensureServer();
  setInterval(refreshServerStatus, 6000);
  startChangeWatcher();

  // Re-open last project.
  const last = localStorage.getItem("repoPath");
  if (last) invoke<boolean>("lore_is_repo", { repo: last }).then((ok) => { if (ok) enterProject(last); });
});
