// The raw Console view: a command palette of `lore` subcommands plus a free
// input that runs any command and prints its output.

import { $, call } from "./dom";
import { S, LORE_COMMANDS } from "./state";
import { refreshStatus } from "./status";
import { refreshBranches } from "./branches";
import type { RunResult } from "./types";

export function toggleConsole() {
  S.consoleOn = !S.consoleOn;
  document.querySelector(".gh-body")!.classList.toggle("hidden", S.consoleOn);
  $("view-console").classList.toggle("hidden", !S.consoleOn);
  $("console-toggle").textContent = S.consoleOn ? "Workspace" : "Console";
}

export function buildCommandList() {
  const ul = $("cmd-list") as HTMLUListElement;
  ul.innerHTML = "";
  for (const { cmd, desc } of LORE_COMMANDS) {
    const li = document.createElement("li");
    li.className = "cmd-item";
    li.title = desc;
    const name = document.createElement("span");
    name.className = "cmd-name"; name.textContent = cmd;
    const d = document.createElement("span");
    d.className = "cmd-desc"; d.textContent = desc;
    li.append(name, d);
    li.addEventListener("click", () => {
      ($("cmd-input") as HTMLInputElement).value = cmd + " ";
      ($("cmd-input") as HTMLInputElement).focus();
      runConsole([cmd, "--help"], `lore ${cmd} --help`);
    });
    ul.appendChild(li);
  }
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export async function runConsole(args?: string[], echo?: string) {
  const input = $("cmd-input") as HTMLInputElement;
  const finalArgs = args ?? tokenize(input.value.trim());
  if (finalArgs.length === 0) return;
  const shown = echo ?? "lore " + input.value.trim();
  const out = $("cmd-out") as HTMLPreElement;
  out.classList.remove("muted");
  const res = await call<RunResult>("lore_run", { repo: S.repoPath, args: finalArgs });
  const head = document.createElement("div");
  head.className = "cmd-echo"; head.textContent = "> " + shown;
  const body = document.createElement("div");
  body.className = "cmd-result " + (res && res.ok ? "ok" : "bad");
  body.textContent = res ? res.output.trimEnd() : "(failed)";
  out.append(head, body);
  out.scrollTop = out.scrollHeight;
  if (S.repoPath) { refreshStatus(); refreshBranches(); }
}
