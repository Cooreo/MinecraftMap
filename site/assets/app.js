/**
 * app.js — wiring for the sheet, tabs, dimensions, URL state and the estimator.
 */
import { createEngine } from "./map.js";

const DEFAULT_WORLDS = {
  overworld: { file: "assets/demo-overworld.json", label: "Overworld" },
  nether: { file: "assets/demo-nether.json", label: "Nether" },
  end: { file: "assets/demo-end.json", label: "The End" },
};

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-US");
const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

let WORLDS = { ...DEFAULT_WORLDS };
let POI_FILE = "assets/demo-pois.json";

const canvas = el("map");
const loading = el("loading");
const loadingText = el("loading-text");
const sheet = el("sheet");

/* --------------------------------------------------------------- engine --- */
const engine = createEngine(canvas, {
  onHover: (hit) => {
    el("ro-block").innerHTML = hit
      ? `<b>${hit.block.replace(/_/g, " ")}</b> <span style="opacity:.55">·</span> ${hit.x}, ${hit.z} <span style="opacity:.55">·</span> y ${hit.y}`
      : defaultHint();
  },
  onPick: (hit) => {
    if (!hit) return;
    engine.centerOn(hit.x, hit.z, Math.max(engine.state.zoom, 9));
    engine.requestRender();
    syncUrl();
  },
});

function defaultHint() {
  return isMobile() ? "drag to pan · pinch to zoom" : "drag to pan · scroll to zoom · click to keep";
}

engine.resize();

/* ------------------------------------------------------------------ data --- */
const cache = new Map();

async function loadDimension(key) {
  if (cache.has(key)) return cache.get(key);
  const url = WORLDS[key].file;
  loading.hidden = false;
  loadingText.textContent = `loading ${WORLDS[key].label.toLowerCase()}…`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const bytes = Number(res.headers.get("content-length") || 0);
  const json = await res.json();
  const netMs = Math.round(performance.now() - t0);
  const entry = { json, bytes, netMs };
  cache.set(key, entry);
  return entry;
}

let pois = [];
async function loadPois() {
  try {
    const res = await fetch(POI_FILE);
    if (res.ok) pois = await res.json();
  } catch {
    pois = [];
  }
}

/** Optional site/assets/config.json lets you swap in your own exports. */
async function loadConfig() {
  try {
    const res = await fetch("assets/config.json", { cache: "no-cache" });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.worlds && typeof cfg.worlds === "object") {
      WORLDS = {};
      for (const [key, val] of Object.entries(cfg.worlds)) {
        if (val && val.file) WORLDS[key] = { file: val.file, label: val.label || key };
      }
      if (!Object.keys(WORLDS).length) WORLDS = { ...DEFAULT_WORLDS };
    }
    if (cfg.pois) POI_FILE = cfg.pois;
    if (cfg.title) document.title = cfg.title;
  } catch {
    /* no config: keep the demo */
  }
}

let current = "overworld";

async function showDimension(key, opts = {}) {
  if (!WORLDS[key]) key = Object.keys(WORLDS)[0];
  current = key;
  try {
    const { json, bytes } = await loadDimension(key);
    const world = engine.setWorld(json);
    loading.hidden = true;

    const dimPois = pois.filter((p) => (p.dimension || "overworld") === key);
    engine.setPois(dimPois);
    renderPoiList(dimPois);
    renderMaterials(world);
    renderDimTabs();

    el("world-name").textContent = json.name || WORLDS[key].label;
    el("st-columns").textContent = fmt.format(world.columns);
    el("st-size").textContent = bytes ? `${(bytes / 1024).toFixed(0)} KB` : "—";
    el("st-parse").textContent = `${world.loadMs} ms`;
    el("st-bake").textContent = `${engine.state.bakeMs || 0} ms`;
    tick();
    if (!opts.keepCamera) syncUrl();
  } catch (err) {
    loadingText.textContent = `could not load ${key}: ${err.message}`;
    loading.hidden = false;
    console.error(err);
  }
}

function renderDimTabs() {
  const host = el("dim-tabs");
  host.innerHTML = "";
  for (const [key, val] of Object.entries(WORLDS)) {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.dataset.dim = key;
    b.setAttribute("aria-selected", String(key === current));
    b.textContent = val.label;
    host.appendChild(b);
  }
}

/* ------------------------------------------------------------- readouts --- */
function tick() {
  const s = engine.state;
  if (!s.world) return;
  const tw = s.zoom;
  el("ro-zoom").textContent = `1:${Math.max(1, Math.round(16 / Math.max(tw, 0.5)))}`;
  el("ro-pos").textContent = `${Math.round(s.camX)} ${Math.round(s.camZ)}`;
  const h = engine.heightAt(Math.round(s.camX), Math.round(s.camZ));
  el("ro-y").textContent = h == null ? "—" : String(h);
  el("st-drawn").textContent = fmt.format(s.drawn ?? 0);
  el("st-details").textContent = `${fmt.format(s.detailsDrawn ?? 0)} block${s.detailsDrawn === 1 ? "" : "s"}`;
  el("st-bake").textContent = `${s.bakeMs ?? 0} ms`;
}
setInterval(tick, 300);

/* ------------------------------------------------------------------ URL --- */
let urlTimer = 0;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const s = engine.state;
    const view = s.view === "top" ? "&v=2d" : "";
  const hash = `#dim=${current}&x=${Math.round(s.targetX)}&z=${Math.round(s.targetZ)}&zoom=${s.targetZoom.toFixed(1)}${view}`;
    history.replaceState(null, "", hash);
  }, 300);
}

function readUrl() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  const num = (k) => (p.get(k) != null && p.get(k) !== "" ? Number(p.get(k)) : null);
  return { dim: p.get("dim"), x: num("x"), z: num("z"), zoom: num("zoom"), view: p.get("v") };
}

function applyUrlCamera(u) {
  if (u.x == null || u.z == null) return;
  engine.centerOn(u.x, u.z, u.zoom || engine.state.zoom);
  engine.requestRender();
}

window.addEventListener("hashchange", async () => {
  const u = readUrl();
  if (u.dim && WORLDS[u.dim] && u.dim !== current) {
    await showDimension(u.dim, { keepCamera: true });
  }
  applyUrlCamera(u);
});

/* ----------------------------------------------------------------- tabs --- */
const TITLES = {
  map: "This world",
  options: "What's possible",
  setup: "Add your world",
  limits: "Where it breaks",
};

function openTab(name, { openSheet = true } = {}) {
  document.querySelectorAll(".appbar .tabs > button[data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  el("sheet-title").textContent = TITLES[name] || name;
  sheet.scrollTop = 0;
  if (openSheet) setSheet(true);
}

document.querySelectorAll(".appbar .tabs > button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => openTab(btn.dataset.tab));
});

el("dim-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-dim]");
  if (btn) showDimension(btn.dataset.dim);
});

/* ---------------------------------------------------------------- sheet --- */
function setSheet(open) {
  if (!isMobile()) return;
  sheet.classList.toggle("open", open);
  el("btn-reader").setAttribute("aria-expanded", String(open));
  el("sheet-hint").textContent = open ? "swipe the handle down" : "tap to open";
}

el("sheet-grab").addEventListener("click", () => setSheet(!sheet.classList.contains("open")));
el("btn-reader").addEventListener("click", () => setSheet(!sheet.classList.contains("open")));

let handleY = null;
sheet.addEventListener(
  "touchstart",
  (e) => {
    if (isMobile() && e.target.closest(".sheet-grab")) handleY = e.touches[0].clientY;
  },
  { passive: true }
);
sheet.addEventListener(
  "touchend",
  (e) => {
    if (handleY == null) return;
    const dy = e.changedTouches[0].clientY - handleY;
    if (dy > 36) setSheet(false);
    else if (dy < -36) setSheet(true);
    handleY = null;
  },
  { passive: true }
);

/* ---------------------------------------------------------------- tools --- */
/* view mode + layers, remembered on this device */
const PREFS_KEY = "tilty.prefs.v1";
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
})();
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota: preferences just won't persist */
  }
}

function applyView(view, { persist = true } = {}) {
  engine.setView(view);
  document.querySelectorAll("#view-seg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  });
  // the 3D-only controls are meaningless in the flat map
  el("t-relief").style.display = view === "top" ? "none" : "";
  if (persist) {
    prefs.view = view;
    savePrefs();
  }
  syncUrl();
}

function applyStructures(on, { persist = true } = {}) {
  engine.setStructures(on);
  el("t-structures").setAttribute("aria-pressed", String(on));
  if (persist) {
    prefs.structures = on;
    savePrefs();
  }
}

el("view-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (btn) applyView(btn.dataset.view);
});

el("t-structures").addEventListener("click", (e) => {
  applyStructures(e.currentTarget.getAttribute("aria-pressed") !== "true");
});

el("t-zoom-in").addEventListener("click", () => engine.setZoom(engine.state.targetZoom * 1.6));
el("t-zoom-out").addEventListener("click", () => engine.setZoom(engine.state.targetZoom / 1.6));
el("t-fit").addEventListener("click", () => {
  engine.fitToWorld();
  engine.requestRender();
  syncUrl();
});
el("t-relief").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
  e.currentTarget.setAttribute("aria-pressed", String(on));
  engine.setRelief(on);
});
el("t-labels").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
  e.currentTarget.setAttribute("aria-pressed", String(on));
  engine.setLabels(on);
});
el("t-png").addEventListener("click", () => {
  const s = engine.state;
  const label = (WORLDS[current]?.label || "map").toLowerCase().replace(/\s+/g, "-");
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `tilty-${label}-${Math.round(s.camX)}-${Math.round(s.camZ)}.png`;
  a.click();
});
el("t-full").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el("stage").requestFullscreen();
  } catch {
    /* iOS refuses fullscreen on non-video elements — harmless */
  }
});
document.addEventListener("fullscreenchange", () => setTimeout(() => engine.resize(), 160));

el("btn-share").addEventListener("click", async () => {
  syncUrl();
  await new Promise((r) => setTimeout(r, 320));
  const url = location.href;
  const btn = el("btn-share");
  const span = btn.querySelector("span");
  const old = span.textContent;
  try {
    await navigator.clipboard.writeText(url);
    span.textContent = "Copied";
  } catch {
    window.prompt("Copy this link", url);
  }
  setTimeout(() => (span.textContent = old), 1500);
});

window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const step = e.shiftKey ? 16 : 4;
  const move = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[e.key];
  if (move) {
    engine.panByWorld(move[0], move[1]);
    engine.requestRender();
    syncUrl();
    e.preventDefault();
  } else if (e.key === "+" || e.key === "=") {
    engine.setZoom(engine.state.targetZoom * 1.4);
  } else if (e.key === "-") {
    engine.setZoom(engine.state.targetZoom / 1.4);
  } else if (e.key === "f") {
    engine.fitToWorld();
    engine.requestRender();
  }
});

/* ----------------------------------------------------------------- POIs --- */
function renderPoiList(list) {
  const host = el("poi-list");
  host.innerHTML = "";
  if (!list.length) {
    host.innerHTML = `<div class="card"><p>No named places in this dimension yet. Add them to
      <code style="font-family:var(--mono);font-size:11.5px">site/assets/demo-pois.json</code>.</p></div>`;
    return;
  }
  for (const p of list) {
    const card = document.createElement("div");
    card.className = "card poi-card";
    card.innerHTML = `<h3>${p.name}</h3><p>${p.note || ""}</p>
      <p class="coord">x ${p.x} · z ${p.z}</p>`;
    card.addEventListener("click", () => {
      engine.centerOn(p.x, p.z, 10);
      engine.requestRender();
      syncUrl();
      if (isMobile()) setSheet(false);
    });
    host.appendChild(card);
  }
}

/* ------------------------------------------------------------ materials --- */
function renderMaterials(world) {
  const counts = new Map();
  for (const name of world.blockNames) counts.set(name, 0);
  const ids = world.blocks;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    counts.set(world.blockNames[id], (counts.get(world.blockNames[id]) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const top = [...counts.entries()]
    .filter(([name]) => name)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  el("materials").innerHTML = top
    .map(([name, n]) => {
      const col = world.palette.get(name) || { top: "#7e7e7e" };
      const pct = (n / total) * 100;
      return `<div class="mat">
        <i style="background:${col.top}"></i>
        <span class="n">${name.replace(/_/g, " ")}</span>
        <span class="bar"><b style="width:${pct.toFixed(1)}%"></b></span>
        <span class="p">${pct.toFixed(1)}%</span>
      </div>`;
    })
    .join("");
}

/* ----------------------------------------------------------------- misc --- */
window.addEventListener("orientationchange", () => setTimeout(() => engine.resize(), 250));
if (window.visualViewport) window.visualViewport.addEventListener("resize", () => engine.resize());
new ResizeObserver(() => engine.resize()).observe(el("stage"));

/* ------------------------------------------------------------ estimator --- */
/**
 * Numbers come from a published comparison render of the same 5 km-radius world
 * (393,129 chunks) on one machine:
 *   uNmINeD 2D tiles .... 376 MB, 16 min
 *   BlueMap 3D ..........   6.5 GB, 2 h 37 min
 *   Overviewer .......... 15.5 GB, 9 h
 * Per-chunk: ~1 KB and ~2.4 ms (uNmINeD), ~17 KB and ~24 ms (BlueMap).
 * tilty's own JSON is ~2.5 KB/chunk with trees and structures dense.
 */
const PER_CHUNK = {
  tiltyBytes: 2.5 * 1024,
  tilesBytes: 1.0 * 1024,
  tilesMs: 2.4,
  bluemapBytes: 17 * 1024,
  bluemapMs: 24,
  overviewerBytes: 41 * 1024,
  filesPerRegion: 120, // tile files per region at a typical 3-zoom export
};

function hits(bytesKB) {
  if (bytesKB <= 1024 * 1024) return ["good", "under 1 GB"];
  if (bytesKB <= 3 * 1024 * 1024) return ["maybe", "over GitHub's 1 GB"];
  return ["bad", "use R2 or tile less"];
}
function filesVerdict(n) {
  if (n <= 18000) return ["good", "fits Cloudflare"];
  if (n <= 45000) return ["maybe", "GH fine, CF needs R2"];
  return ["bad", "tiles belong in R2"];
}
function duration(minutes) {
  if (minutes < 1) return "<1 min";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function renderEstimate(regions) {
  const chunks = regions * 1024;
  const rows = [];
  const add = (k, v, verdict) => rows.push({ k, v, verdict });

  add("chunks", fmt.format(chunks));
  add("columns", fmt.format(chunks * 256));
  const tiltyKB = (chunks * PER_CHUNK.tiltyBytes) / 1024;
  add("tilty JSON", tiltyKB < 1024 ? `${Math.round(tiltyKB)} KB` : `${(tiltyKB / 1024).toFixed(1)} MB`, hits(tiltyKB));
  const tilesKB = (chunks * PER_CHUNK.tilesBytes) / 1024;
  add("uNmINeD tiles", `${(tilesKB / 1024).toFixed(0)} MB`, hits(tilesKB));
  add("tile files", fmt.format(regions * PER_CHUNK.filesPerRegion), filesVerdict(regions * PER_CHUNK.filesPerRegion));
  add("BlueMap 3D", `${((chunks * PER_CHUNK.bluemapBytes) / 1024 / 1024).toFixed(1)} GB`, hits((chunks * PER_CHUNK.bluemapBytes) / 1024));
  add("render (uNmINeD)", duration((chunks * PER_CHUNK.tilesMs) / 60000));
  add("render (BlueMap)", duration((chunks * PER_CHUNK.bluemapMs) / 60000));

  el("estimate-kv").innerHTML = rows
    .map((r) => {
      const v = r.verdict ? r.verdict[0] : "";
      const tail = r.verdict ? ` <span class="tail">${r.verdict[1]}</span>` : "";
      return `<span class="k">${r.k}</span><span class="v ${v}">${r.v}${tail}</span>`;
    })
    .join("");

  const size = Math.min(24, Math.max(8, Math.ceil(Math.sqrt(regions) * 1.25)));
  const cells = [];
  for (let i = 0; i < size * size; i++) cells.push(i < regions ? "cell on" : "cell");
  const fp = el("footprint");
  fp.style.gridTemplateColumns = `repeat(${size}, 7px)`;
  fp.innerHTML = cells.map((c) => `<span class="${c}"></span>`).join("");
  el("estimate").hidden = false;
}

function regionCount(files) {
  const set = new Set();
  let bytes = 0;
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".mca")) continue;
    const dir = (f.webkitRelativePath || f.name).replace(/\/[^/]+$/, "");
    set.add(`${dir}/${f.name}`);
    bytes += f.size;
  }
  return { regions: set.size, bytes };
}

const drop = el("drop");
const input = el("drop-input");

drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") input.click();
});
input.addEventListener("change", () => {
  if (input.files?.length) handleFiles([...input.files]);
});
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);

async function walkEntry(entry) {
  if (entry.isFile) {
    return new Promise((res) => entry.file((f) => res([f])));
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((res) => reader.readEntries(res));
    if (!batch.length) break;
    for (const child of batch) out.push(...(await walkEntry(child)));
  }
  return out;
}

drop.addEventListener("drop", async (e) => {
  const entries = [...(e.dataTransfer?.items || [])]
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  const files = entries.length
    ? (await Promise.all(entries.map(walkEntry))).flat()
    : [...(e.dataTransfer?.files || [])];
  if (files.length) handleFiles(files);
});

function handleFiles(files) {
  const { regions, bytes } = regionCount(files);
  if (!regions) {
    el("estimate").hidden = false;
    el("estimate-kv").innerHTML = `<span class="k">result</span><span class="v bad">no .mca region files found</span>`;
    el("footprint").innerHTML = "";
    return;
  }
  renderEstimate(regions);
  el("estimate-kv").insertAdjacentHTML(
    "beforeend",
    `<span class="k">on disk</span><span class="v">${(bytes / 1024 / 1024).toFixed(0)} MB</span>`
  );
}

/* ----------------------------------------------------------------- boot --- */
(async function boot() {
  el("ro-block").textContent = defaultHint();
  await loadConfig();
  await loadPois();
  const u = readUrl();
  // URL wins over the stored preference, so a shared link opens as sent
  const wantedView = u.view === "2d" ? "top" : u.view === "iso" ? "iso" : prefs.view || "iso";
  applyView(wantedView, { persist: false });
  applyStructures(u.view ? true : prefs.structures !== false, { persist: false });
  await showDimension(u.dim && WORLDS[u.dim] ? u.dim : Object.keys(WORLDS)[0], { keepCamera: true });
  applyUrlCamera(u);
  openTab(u.dim ? "map" : "map", { openSheet: false });
  if (!isMobile()) setSheet(true);
  setTimeout(tick, 60);
})();
