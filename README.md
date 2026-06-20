# Lore UI
![Lore UI](Lore_UI.png)

> [!WARNING]
> **Work in Progress**: This project is currently under active development and is not yet finished. Features may change or be incomplete.

A desktop GUI for the [Lore](https://epicgames.github.io/lore/) version control system - a clean, GitHub-Desktop-style client built with Tauri and TypeScript.

### Why Lore UI?
Lore ships as a CLI only. Lore UI was designed to allow designers to easily use Lore alongside developers, wrapping the powerful command set of the Lore CLI from Epic into a compact, grayscale interface so common work is just a click away.

## Features

- **Layout** - a left nav tree (Changes, History, local branches, remotes), a center list, and a detail pane, in the spirit of Fork - mapped to Lore's own concepts, not Git's.
- **Workspace** - changed files in a collapsible folder tree, stage and commit, push and get latest, switch and create branches, merge. Sort by name or type, filter by extension.
- **Previews** - pictures on a checkerboard with dimensions and size; HDR textures (`exr`, `hdr`); 3D models (`fbx`, `obj`, `gltf`/`glb`, `stl`, `ply`) in an orbit/zoom viewer; audio (`wav`, `mp3`, `ogg`, ...) players. Engine/binary files (`uasset`, `blend`, `spine`, ...) get an info card; text files fall back to a line diff.
- **History** - a commit graph with a lane rail, plus right-click operations on any revision: sync to it, create a branch there, reset the branch to it, cherry-pick, revert, amend the latest message, undo, view revision info, copy the id.
- **Branch operations** - right-click a branch to switch, merge into current, push, view info, protect/unprotect, or archive.
- **File locking** - right-click a file to acquire, release, or check a lock - important for binary art assets that cannot be merged.
- **Diffs** - per-file line diffs for working changes and past commits, colour-coded (add green, change orange, remove red).
- **Discard** - drop working changes per file, including brand-new files.
- **Server setup** - a simple wizard to host a server on this PC (with a shareable LAN/VPN address for teammates) or connect to a shared VPS / VPN server, with a connection test.
- **Server control** - shows local/remote server type and status; auto-starts a local `loreserver` when the address is local, with Start/Stop controls.
- **Settings** - global lore flags (data source, offline, force, dry-run, identity, log level, limits) applied to every command.
- **Console** - run any lore command with full output, with a browsable list of all commands.

## How it works

The Tauri (Rust) backend shells out to the `lore` CLI and parses its text output into structured data for the TypeScript frontend. Lore has no JSON output, so every parser was built against real CLI output. File previews read raw bytes over Tauri's binary IPC and render them with the browser (`<img>`) or [three.js](https://threejs.org/) (models).

## Requirements

- The `lore` CLI on your `PATH` (and `loreserver` for local hosting).
- [Rust](https://www.rust-lang.org/) and [Node.js](https://nodejs.org/) to build.

## Develop

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```
