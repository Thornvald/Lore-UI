// Lore CLI bridge.
//
// The `lore` CLI has no JSON output, so this module shells out to the binary and
// parses its human-readable text. Split into focused submodules:
//   - model:   serde structs shared across the bridge
//   - process: the low-level CLI runner + global flags + console passthrough
//   - parse:   text parsers (status / branches / history / change lists) + tests
//   - repo:    day-to-day repo commands (status/stage/commit/branch/merge/...)
//   - setup:   repository create / clone / one-time Unreal setup
//   - server:  local loreserver control + working-tree watcher + share IPs
//   - config:  repo identity / remote URL + reveal-in-Explorer
//   - preview: binary file preview (raw bytes, uasset/blend thumbnails, glb)
//
// The command functions are re-exported here so lib.rs keeps referring to them
// as `lore::<name>`, unchanged by the split.

mod model;
mod parse;
mod process;

mod config;
mod preview;
mod repo;
mod server;
mod setup;

pub use config::*;
pub use preview::*;
pub use process::*;
pub use repo::*;
pub use server::*;
pub use setup::*;
