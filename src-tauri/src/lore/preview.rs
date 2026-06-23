// Binary file preview support: raw byte reads, embedded thumbnail extraction for
// Unreal .uasset/.umap (PNG/JPEG scan), Blender .blend parsing (thumbnail, block
// tally) and headless-Blender .blend -> glb conversion with an on-disk cache.

use std::process::{Command, Stdio};

use super::model::{BlendInfo, FileMeta};

#[tauri::command(async)]
pub fn file_meta(repo: String, path: String) -> FileMeta {
    match std::fs::metadata(std::path::Path::new(&repo).join(&path)) {
        Ok(m) => FileMeta { size: m.len(), exists: m.is_file() },
        Err(_) => FileMeta { size: 0, exists: false },
    }
}

/// Read a working-tree file's raw bytes for previewing (images, 3D models, ...).
/// Returns the bytes over Tauri's binary IPC, so the frontend gets an ArrayBuffer
/// directly - big textures and models never go through a JSON number array.
/// Capped so a stray huge file can't blow up memory.
#[tauri::command(async)]
pub fn read_file_bytes(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    // 256 MB is far above normal art assets; it only guards against accidents.
    const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "File is too big to preview ({} MB).",
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Find a byte pattern in `data`, returning the start index.
fn find_pattern(data: &[u8], pat: &[u8]) -> Option<usize> {
    if pat.is_empty() || data.len() < pat.len() {
        return None;
    }
    data.windows(pat.len()).position(|w| w == pat)
}

/// Pull the largest embedded PNG out of `data`, if any.
/// Unreal editor assets store the content-browser thumbnail PNG-compressed
/// inside the package, so scanning for a complete PNG (signature .. IEND) gets
/// us that thumbnail without parsing the whole UE package format.
fn extract_png(data: &[u8]) -> Option<Vec<u8>> {
    const SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const IEND: [u8; 8] = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
    let mut best: Option<Vec<u8>> = None;
    let mut i = 0usize;
    while i + SIG.len() <= data.len() {
        if data[i..i + SIG.len()] == SIG {
            if let Some(rel) = find_pattern(&data[i..], &IEND) {
                let end = i + rel + IEND.len();
                let candidate = &data[i..end];
                if best.as_ref().map_or(true, |b| candidate.len() > b.len()) {
                    best = Some(candidate.to_vec());
                }
                i = end;
                continue;
            }
            break; // PNG start with no end - give up
        }
        i += 1;
    }
    best
}

/// Pull the largest embedded JPEG out of `data` (fallback for assets that store
/// a JPEG thumbnail instead of a PNG).
fn extract_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    const START: [u8; 3] = [0xFF, 0xD8, 0xFF];
    const END: [u8; 2] = [0xFF, 0xD9];
    let start = find_pattern(data, &START)?;
    let rel_end = find_pattern(&data[start..], &END)?;
    let end = start + rel_end + END.len();
    Some(data[start..end].to_vec())
}

/// Best-effort thumbnail for an Unreal `.uasset`/`.umap`: extract the embedded
/// editor thumbnail image. Returns an error if the asset carries no thumbnail
/// (e.g. cooked assets), so the UI can fall back to an info card.
#[tauri::command(async)]
pub fn read_uasset_thumb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX_SCAN_BYTES: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX_SCAN_BYTES {
        return Err("Asset is too big to scan for a thumbnail.".to_string());
    }
    let data = std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?;
    if let Some(png) = extract_png(&data) {
        return Ok(tauri::ipc::Response::new(png));
    }
    if let Some(jpg) = extract_jpeg(&data) {
        return Ok(tauri::ipc::Response::new(jpg));
    }
    Err("No embedded thumbnail in this asset.".to_string())
}

fn read_u32(b: &[u8], little_endian: bool) -> u32 {
    let arr = [b[0], b[1], b[2], b[3]];
    if little_endian { u32::from_le_bytes(arr) } else { u32::from_be_bytes(arr) }
}

/// Decompress a `.blend` saved with compression (gzip, older; zstd, Blender 3.0+);
/// otherwise return the bytes unchanged.
fn maybe_decompress(data: Vec<u8>) -> Vec<u8> {
    use std::io::Read;
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        let mut out = Vec::new();
        if flate2::read::GzDecoder::new(&data[..]).read_to_end(&mut out).is_ok() {
            return out;
        }
    } else if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
        // Blender writes the .blend as many concatenated zstd frames, so decode
        // frame by frame until the whole input is consumed.
        let mut cursor = std::io::Cursor::new(&data[..]);
        let mut out = Vec::new();
        let mut last = 0u64;
        while (cursor.position() as usize) < data.len() {
            match ruzstd::StreamingDecoder::new(&mut cursor) {
                Ok(mut dec) => {
                    if dec.read_to_end(&mut out).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
            if cursor.position() == last {
                break; // no progress - avoid an infinite loop
            }
            last = cursor.position();
        }
        if !out.is_empty() {
            return out;
        }
    }
    data
}

fn read_u64(b: &[u8], little_endian: bool) -> u64 {
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&b[0..8]);
    if little_endian { u64::from_le_bytes(arr) } else { u64::from_be_bytes(arr) }
}

/// Parsed `.blend` header. Handles the classic 12-byte header and the new
/// "BLENDER17-01v0501" large-file header (Blender 4.0+/5.x) whose file-block
/// headers carry a 64-bit length.
struct BlendHeader {
    little_endian: bool,
    block_header_len: usize,
    new_format: bool,
    data_start: usize,
}

fn parse_blend_header(data: &[u8]) -> Option<BlendHeader> {
    if data.len() < 12 || &data[0..7] != b"BLENDER" {
        return None;
    }
    let b7 = data[7];
    // Classic: byte 7 is the pointer-size marker ('-' = 8, '_' = 4).
    if b7 == b'-' || b7 == b'_' {
        let ptr = if b7 == b'-' { 8 } else { 4 };
        return Some(BlendHeader {
            little_endian: data[8] == b'v',
            block_header_len: 4 + 4 + ptr + 4 + 4,
            new_format: false,
            data_start: 12,
        });
    }
    // New: "BLENDER" + 2 digits (header size) + ptr + 2 digits (format ver) +
    // endian + version. Block headers become: code[4] pad[4] len:u64 old sdna nr.
    if b7.is_ascii_digit() && data.len() >= 17 {
        let hsize = (b7 - b'0') as usize * 10 + (data[8] - b'0') as usize;
        let ptr = if data[9] == b'-' { 8 } else { 4 };
        return Some(BlendHeader {
            little_endian: data[12] == b'v',
            block_header_len: 4 + 4 + 8 + ptr + 4 + 4,
            new_format: true,
            data_start: hsize,
        });
    }
    None
}

/// The byte length of the block whose header starts at `off`.
fn blend_block_len(data: &[u8], off: usize, h: &BlendHeader) -> usize {
    if h.new_format {
        read_u64(&data[off + 8..off + 16], h.little_endian) as usize
    } else {
        read_u32(&data[off + 4..off + 8], h.little_endian) as usize
    }
}

/// Best-effort thumbnail for a Blender `.blend`: walk the file-block list to the
/// "TEST" block, which holds the saved preview image (int32 width, int32 height,
/// then RGBA pixels). Returns `[u32 width][u32 height][rgba...]` (all little-
/// endian) for the UI to paint, or an error when the file is compressed or has
/// no saved preview.
#[tauri::command(async)]
pub fn read_blend_thumb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX {
        return Err("File too large to scan.".to_string());
    }
    let data = maybe_decompress(std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?);
    let h = parse_blend_header(&data).ok_or("Could not read this .blend.".to_string())?;
    let le = h.little_endian;
    let mut off = h.data_start;
    while off + h.block_header_len <= data.len() {
        let code = &data[off..off + 4];
        if code == b"ENDB" {
            break;
        }
        let size = blend_block_len(&data, off, &h);
        let body = off + h.block_header_len;
        if body + size > data.len() {
            break;
        }
        if code == b"TEST" && size >= 8 {
            let w = read_u32(&data[body..body + 4], le);
            let hgt = read_u32(&data[body + 4..body + 8], le);
            let want = (w as usize).saturating_mul(hgt as usize).saturating_mul(4);
            let take = want.min(size - 8);
            let mut out = Vec::with_capacity(8 + take);
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&hgt.to_le_bytes());
            out.extend_from_slice(&data[body + 8..body + 8 + take]);
            return Ok(tauri::ipc::Response::new(out));
        }
        off = body + size;
    }
    Err("No saved preview in this .blend.".to_string())
}

fn blend_id_label(c0: u8, c1: u8) -> &'static str {
    match (c0, c1) {
        (b'O', b'B') => "Objects",
        (b'M', b'E') => "Meshes",
        (b'M', b'A') => "Materials",
        (b'I', b'M') => "Images",
        (b'T', b'E') => "Textures",
        (b'C', b'A') => "Cameras",
        (b'L', b'A') => "Lights",
        (b'A', b'R') => "Armatures",
        (b'A', b'C') => "Actions",
        (b'C', b'U') => "Curves",
        (b'W', b'O') => "Worlds",
        (b'S', b'C') => "Scenes",
        (b'G', b'R') => "Collections",
        (b'N', b'T') => "Node trees",
        (b'B', b'R') => "Brushes",
        (b'P', b'A') => "Particle systems",
        (b'G', b'D') => "Grease pencil",
        (b'V', b'F') => "Fonts",
        (b'S', b'O') => "Sounds",
        (b'T', b'X') => "Texts",
        (b'L', b'T') => "Lattices",
        (b'M', b'B') => "Metaballs",
        _ => "Other data",
    }
}

/// Walk a `.blend`'s block list and tally its datablocks, so the UI can show
/// what the file contains (not just a thumbnail).
#[tauri::command(async)]
pub fn read_blend_info(repo: String, path: String) -> Result<BlendInfo, String> {
    let full = std::path::Path::new(&repo).join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("Cannot open file: {e}"))?;
    const MAX: u64 = 512 * 1024 * 1024;
    if meta.len() > MAX {
        return Err("File too large to scan.".to_string());
    }
    let data = maybe_decompress(std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?);
    if data.len() < 12 || &data[0..7] != b"BLENDER" {
        return Err("Could not read this .blend (unsupported compression?).".to_string());
    }
    let h = parse_blend_header(&data).ok_or("Could not read this .blend.".to_string())?;
    let le = h.little_endian;

    use std::collections::BTreeMap;
    let mut counts: BTreeMap<&'static str, u32> = BTreeMap::new();
    let mut width = 0u32;
    let mut height = 0u32;
    let mut has_thumb = false;

    let mut off = h.data_start;
    while off + h.block_header_len <= data.len() {
        let code = &data[off..off + 4];
        if code == b"ENDB" {
            break;
        }
        let size = blend_block_len(&data, off, &h);
        let body = off + h.block_header_len;
        if body + size > data.len() {
            break;
        }
        // ID datablocks use a 2-letter code with the last two bytes null;
        // structural blocks (DATA, DNA1, TEST, REND, GLOB, ...) do not.
        if code[2] == 0 && code[3] == 0 {
            *counts.entry(blend_id_label(code[0], code[1])).or_insert(0) += 1;
        } else if code == b"TEST" && size >= 8 {
            width = read_u32(&data[body..body + 4], le);
            height = read_u32(&data[body + 4..body + 8], le);
            has_thumb = width > 0 && height > 0;
        }
        off = body + size;
    }

    let mut datablocks: Vec<(String, u32)> =
        counts.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    datablocks.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(BlendInfo { width, height, has_thumb, datablocks })
}

/// Locate a Blender executable: `BLENDER_PATH` env, then common install paths,
/// then `blender` on PATH.
fn find_blender() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Ok(p) = std::env::var("BLENDER_PATH") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return pb;
        }
    }
    let candidates = [
        r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe",
        r"C:\Program Files\Steam\steamapps\common\Blender\blender.exe",
    ];
    for c in candidates {
        let pb = PathBuf::from(c);
        if pb.is_file() {
            return pb;
        }
    }
    if let Ok(entries) = std::fs::read_dir(r"C:\Program Files\Blender Foundation") {
        for e in entries.flatten() {
            let exe = e.path().join("blender.exe");
            if exe.is_file() {
                return exe;
            }
        }
    }
    PathBuf::from("blender") // last resort: rely on PATH
}

/// Where a `.blend`'s converted glb is cached on disk. Keyed by the file's full
/// path + last-modified time, so an edited .blend re-converts but an unchanged
/// one is served instantly across sessions.
fn blend_cache_path(input: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let meta = std::fs::metadata(input).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.to_string_lossy().hash(&mut hasher);
    mtime.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    let dir = std::env::temp_dir().join("loreui_blendcache");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{:016x}.glb", hasher.finish())))
}

/// True if this `.blend` already has a converted glb on disk (so the UI can show
/// a row thumbnail without kicking off a slow conversion for every file).
#[tauri::command(async)]
pub fn blend_is_cached(repo: String, path: String) -> bool {
    let input = std::path::Path::new(&repo).join(&path);
    match blend_cache_path(&input) {
        Some(p) => p.is_file(),
        None => false,
    }
}

/// Convert a `.blend` to glTF-binary (glb) with a headless Blender and return
/// the glb bytes for the 3D viewer - so a `.blend` previews like an FBX. The
/// result is cached on disk (see `blend_cache_path`), so the first view of a
/// file is slow but every later view is instant. Needs Blender installed.
#[tauri::command(async)]
pub fn blend_to_glb(repo: String, path: String) -> Result<tauri::ipc::Response, String> {
    let input = std::path::Path::new(&repo).join(&path);
    if !input.is_file() {
        return Err("File not found.".to_string());
    }

    // Serve the cached glb if we already converted this exact file.
    let cache = blend_cache_path(&input);
    if let Some(c) = &cache {
        if c.is_file() {
            if let Ok(bytes) = std::fs::read(c) {
                return Ok(tauri::ipc::Response::new(bytes));
            }
        }
    }

    let blender = find_blender();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("loreui_blend_{nanos}.glb"));
    let out_py = out.to_string_lossy().replace('\\', "/");

    // Load the .blend in background mode and export the whole scene to glb.
    let script = format!(
        "import bpy\ntry:\n import addon_utils; addon_utils.enable('io_scene_gltf2')\nexcept Exception:\n pass\nbpy.ops.export_scene.gltf(filepath='{out_py}', export_format='GLB', use_visible=False, use_renderable=False)\n"
    );

    let mut cmd = Command::new(&blender);
    cmd.arg("-b")
        .arg(&input)
        .arg("--python-expr")
        .arg(&script)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Could not run Blender ({}): {e}", blender.display()))?;

    if !out.is_file() {
        let log = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
        return Err(format!(
            "Blender did not produce a model. Is Blender installed? {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        ));
    }
    let bytes = std::fs::read(&out).map_err(|e| format!("Cannot read converted model: {e}"))?;
    // Keep the result for next time, then clean up the temp export.
    if let Some(c) = &cache {
        let _ = std::fs::copy(&out, c);
    }
    let _ = std::fs::remove_file(&out);
    Ok(tauri::ipc::Response::new(bytes))
}
