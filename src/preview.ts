// File preview: pictures and 3D models, shown in the detail pane.
//
// The Rust side hands us the file's raw bytes (ArrayBuffer). Here we turn those
// bytes into something on screen:
//   - pictures  -> an <img> on a checkerboard, like Fork's image view
//   - 3D models -> a small three.js scene you can orbit and zoom (fbx/obj/...)
//   - anything else is handled by the caller (a plain info card).
//
// Every mount returns a `cleanup` we must call before showing the next file, so
// the WebGL context and object URLs do not leak.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

export type PreviewKind = "image" | "texture" | "model" | "audio" | "uasset" | "blend" | "binary" | "other";

// Result of mounting a preview: a cleanup to call later, and a short info line
// (e.g. "256 × 256" for an image) the caller puts in the caption.
export interface PreviewResult {
  cleanup: () => void;
  info: string;
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];
const TEXTURE_EXT = ["exr", "hdr"]; // HDR textures rendered through three.js
const MODEL_EXT = ["fbx", "obj", "gltf", "glb", "stl", "ply"];
const AUDIO_EXT = ["wav", "mp3", "ogg", "flac", "m4a", "aac"];
const UASSET_EXT = ["uasset", "umap"]; // Unreal packages - try the embedded thumbnail
const BLEND_EXT = ["blend", "blend1", "blend2"]; // Blender - try the saved preview
// Known binary types we cannot draw in a web view (engine / DCC formats).
// They get an honest info card instead of a garbage text diff.
const BINARY_EXT = ["spine", "dds", "tga", "tiff", "tif", "psd", "bin", "exe", "dll", "pak"];

export function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

export function previewKind(path: string): PreviewKind {
  const ext = extOf(path);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (TEXTURE_EXT.includes(ext)) return "texture";
  if (MODEL_EXT.includes(ext)) return "model";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (UASSET_EXT.includes(ext)) return "uasset";
  if (BLEND_EXT.includes(ext)) return "blend";
  if (BINARY_EXT.includes(ext)) return "binary";
  return "other";
}

function imageMime(ext: string): string {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}

// ---- Image preview ----------------------------------------------------------

function mountImage(host: HTMLElement, bytes: ArrayBuffer, ext: string): Promise<PreviewResult> {
  return new Promise((resolve) => {
    const blob = new Blob([bytes], { type: imageMime(ext) });
    const url = URL.createObjectURL(blob);

    const board = document.createElement("div");
    board.className = "img-board";
    const img = document.createElement("img");
    img.className = "img-preview";
    board.appendChild(img);
    host.appendChild(board);

    const cleanup = () => { URL.revokeObjectURL(url); };

    img.onload = () => {
      const info = img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : "";
      resolve({ cleanup, info });
    };
    img.onerror = () => {
      host.innerHTML = `<div class="preview-msg muted">Could not show this picture.</div>`;
      resolve({ cleanup, info: "" });
    };
    img.src = url;
  });
}

// ---- 3D model preview -------------------------------------------------------

// Load the model bytes into a three.js object, picking the loader by extension.
// Loaders that only return geometry (stl/ply) get a default material here.
function loadModel(bytes: ArrayBuffer, ext: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    const fail = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)));
    const litMesh = (geom: THREE.BufferGeometry): THREE.Mesh => {
      geom.computeVertexNormals();
      return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xb9b9bd, roughness: 0.75, metalness: 0.05 }));
    };
    try {
      if (ext === "obj") {
        resolve(new OBJLoader().parse(new TextDecoder().decode(bytes)));
      } else if (ext === "fbx") {
        resolve(new FBXLoader().parse(bytes, ""));
      } else if (ext === "stl") {
        resolve(litMesh(new STLLoader().parse(bytes)));
      } else if (ext === "ply") {
        resolve(litMesh(new PLYLoader().parse(bytes)));
      } else if (ext === "gltf" || ext === "glb") {
        new GLTFLoader().parse(bytes, "", (g) => resolve(g.scene), fail);
      } else {
        reject(new Error(`No 3D loader for .${ext}`));
      }
    } catch (e) {
      fail(e);
    }
  });
}

// Make a freshly loaded model presentable: meshes that arrived without normals
// would render black under lighting, and meshes without a material would be
// invisible. Fix both so a bare obj/fbx/stl still shows up.
function prepMeshes(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry;
    if (geom && geom.getAttribute("position") && !geom.getAttribute("normal")) {
      geom.computeVertexNormals();
    }
    if (!mesh.material) {
      mesh.material = new THREE.MeshStandardMaterial({ color: 0xb9b9bd, roughness: 0.75, metalness: 0.05 });
    }
  });
}

function disposeScene(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}

// View modes (Blender-style): a clean matte "solid" clay, wireframe, or normals.
// We override the model's own materials so a metallic glb/fbx with no environment
// map stops looking chrome-y and just reads as a solid object.
type ViewMode = "solid" | "wireframe" | "normals";
function makeViewMaterial(mode: ViewMode): THREE.Material {
  if (mode === "normals") return new THREE.MeshNormalMaterial();
  if (mode === "wireframe") return new THREE.MeshBasicMaterial({ color: 0x9aa0a8, wireframe: true });
  return new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.6, metalness: 0.0 });
}
function applyViewMode(root: THREE.Object3D, mode: ViewMode) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const existing = mesh.material;
    if (existing) (Array.isArray(existing) ? existing : [existing]).forEach((m) => m.dispose());
    mesh.material = makeViewMaterial(mode);
  });
}
// A pleasant 3-point + hemisphere rig that flatters matte surfaces.
function addStudioLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a30, 1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(2, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-2, 1, -1);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(0, 2.5, -3);
  scene.add(rim);
}

async function mountModel(host: HTMLElement, bytes: ArrayBuffer, ext: string): Promise<PreviewResult> {
  let model: THREE.Object3D;
  try {
    model = await loadModel(bytes, ext);
  } catch (e) {
    host.innerHTML = `<div class="preview-msg muted">Could not open this model.<br><span class="small">${String(e)}</span></div>`;
    return { cleanup: () => {}, info: "" };
  }
  prepMeshes(model);
  applyViewMode(model, "solid"); // clean matte look, no chrome

  const stage = document.createElement("div");
  stage.className = "model-stage";
  host.appendChild(stage);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    host.innerHTML = `<div class="preview-msg muted">3D preview needs WebGL, which is not available here.</div>`;
    return { cleanup: () => {}, info: "" };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  stage.appendChild(renderer.domElement);

  // View-mode toolbar: Solid / Wireframe / Normals.
  const tools = document.createElement("div");
  tools.className = "model-tools";
  const MODES: ViewMode[] = ["solid", "wireframe", "normals"];
  const toolBtns: HTMLButtonElement[] = [];
  for (const m of MODES) {
    const b = document.createElement("button");
    b.className = "model-tool" + (m === "solid" ? " on" : "");
    b.textContent = m[0].toUpperCase() + m.slice(1);
    b.addEventListener("click", () => {
      applyViewMode(model, m);
      toolBtns.forEach((x) => x.classList.toggle("on", x === b));
    });
    toolBtns.push(b);
    tools.appendChild(b);
  }
  stage.appendChild(tools);

  const scene = new THREE.Scene();
  addStudioLights(scene);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(model);

  // Frame the model: centre the orbit on it and pull the camera back enough to
  // fit its bounding box, with a little padding.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = (camera.fov * Math.PI) / 180;
  const dist = ((maxDim / 2) / Math.tan(fov / 2)) * 1.6;
  camera.position.set(center.x + dist * 0.75, center.y + dist * 0.5, center.z + dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();

  // A faint ground grid under the model, for a sense of scale (like the refs).
  const grid = new THREE.GridHelper(maxDim * 4, 20, 0x3c3c42, 0x2a2a2e);
  grid.position.set(center.x, box.min.y, center.z);
  scene.add(grid);

  const resize = () => {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  let raf = 0;
  let live = true;
  const tick = () => {
    if (!live) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();

  const cleanup = () => {
    live = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };

  const tris = countTriangles(model);
  const info = tris ? `${tris.toLocaleString()} tris · drag to orbit, scroll to zoom` : "drag to orbit, scroll to zoom";
  return { cleanup, info };
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry;
    if (g.index) n += g.index.count / 3;
    else if (g.attributes.position) n += g.attributes.position.count / 3;
  });
  return Math.round(n);
}

// ---- Offscreen model thumbnails (for file rows) -----------------------------
// Browsers cap how many live WebGL contexts exist, so every row thumbnail shares
// ONE offscreen renderer and the jobs run one at a time. Each job returns a PNG
// data URL the caller drops into an <img>.
const THUMB_SIZE = 72;
let thumbRenderer: THREE.WebGLRenderer | null = null;
let thumbRendererTried = false;
function getThumbRenderer(): THREE.WebGLRenderer | null {
  if (thumbRendererTried) return thumbRenderer;
  thumbRendererTried = true;
  try {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    thumbRenderer.toneMappingExposure = 1.1;
  } catch {
    thumbRenderer = null;
  }
  return thumbRenderer;
}

// Serialize jobs onto one chain so we never render two models into the shared
// context at once.
let thumbChain: Promise<unknown> = Promise.resolve();
export function renderModelThumbnail(bytes: ArrayBuffer, ext: string): Promise<string | null> {
  const job = thumbChain.then(() => renderModelThumbnailNow(bytes, ext));
  thumbChain = job.catch(() => null);
  return job;
}

async function renderModelThumbnailNow(bytes: ArrayBuffer, ext: string): Promise<string | null> {
  const renderer = getThumbRenderer();
  if (!renderer) return null;
  let model: THREE.Object3D;
  try {
    model = await loadModel(bytes, ext);
  } catch {
    return null;
  }
  prepMeshes(model);
  applyViewMode(model, "solid");

  const scene = new THREE.Scene();
  addStudioLights(scene);
  scene.add(model);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100000);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = (camera.fov * Math.PI) / 180;
  // Tight framing so the model fills the little row thumbnail.
  const dist = ((maxDim / 2) / Math.tan(fov / 2)) * 1.15;
  camera.position.set(center.x + dist * 0.65, center.y + dist * 0.5, center.z + dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  disposeScene(scene);
  return url;
}

// ---- HDR texture preview (exr / hdr) ----------------------------------------
// Render the float texture once to a canvas with tone mapping, then show it
// like a picture (a still image needs no animation loop).
function mountTexture(host: HTMLElement, bytes: ArrayBuffer, ext: string): PreviewResult {
  let tex: THREE.DataTexture;
  let w = 0, h = 0;
  try {
    const loader = ext === "hdr" ? new RGBELoader() : new EXRLoader();
    const data = loader.parse(bytes) as unknown as {
      data: THREE.TypedArray; width: number; height: number; format: THREE.PixelFormat; type: THREE.TextureDataType;
    };
    w = data.width; h = data.height;
    tex = new THREE.DataTexture(data.data, w, h, data.format, data.type);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
  } catch (e) {
    host.innerHTML = `<div class="preview-msg muted">Could not open this texture.<br><span class="small">${String(e)}</span></div>`;
    return { cleanup: () => {}, info: "" };
  }

  const board = document.createElement("div");
  board.className = "img-board";
  host.appendChild(board);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  } catch {
    host.innerHTML = `<div class="preview-msg muted">HDR preview needs WebGL, which is not available here.</div>`;
    tex.dispose();
    return { cleanup: () => {}, info: "" };
  }
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.scale.y = -1; // EXR/HDR rows are top-down; flip so it reads upright
  scene.add(quad);
  renderer.render(scene, cam);

  const canvas = renderer.domElement;
  canvas.className = "img-preview";
  board.appendChild(canvas);

  const cleanup = () => {
    tex.dispose();
    mat.dispose();
    quad.geometry.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  return { cleanup, info: `${w} × ${h} · HDR` };
}

// ---- Audio preview ----------------------------------------------------------
function mountAudio(host: HTMLElement, bytes: ArrayBuffer, ext: string): PreviewResult {
  const blob = new Blob([bytes], { type: `audio/${ext === "mp3" ? "mpeg" : ext}` });
  const url = URL.createObjectURL(blob);
  const wrap = document.createElement("div");
  wrap.className = "audio-wrap";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = url;
  wrap.appendChild(audio);
  host.appendChild(wrap);
  return { cleanup: () => URL.revokeObjectURL(url), info: ext.toUpperCase() + " audio" };
}

// ---- Entry point ------------------------------------------------------------

// Mount a preview for `path` from its `bytes` into `host`. The caller has
// already decided this is a previewable kind (image / texture / model / audio).
export function mountPreview(host: HTMLElement, bytes: ArrayBuffer, path: string): Promise<PreviewResult> {
  const ext = extOf(path);
  const kind = previewKind(path);
  if (kind === "image") return mountImage(host, bytes, ext);
  if (kind === "texture") return Promise.resolve(mountTexture(host, bytes, ext));
  if (kind === "audio") return Promise.resolve(mountAudio(host, bytes, ext));
  return mountModel(host, bytes, ext);
}
