/**
 * Dev-only harness: runs site/assets/map.js in Node with a canvas shim that
 * records draw calls as SVG, so the renderer can be checked without a browser.
 *
 *   node tools/dev/render.mjs out.png --view top --zoom 3 --x 0 --z 0
 *
 * Writes an SVG next to the PNG and prints stats. Rasterising is left to
 * whatever the host has (see rasterise.py in this folder).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* ------------------------------------------------------------------ shim --- */
class Ctx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.out = [];
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "high";
    this.shadowBlur = 0;
    this.shadowColor = "";
    this.lineJoin = "miter";
    this._path = "";
  }
  setTransform() {}
  save() {}
  restore() {}
  clearRect() {}
  beginPath() {
    this._path = "";
  }
  moveTo(x, y) {
    this._path += `M${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  lineTo(x, y) {
    this._path += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  closePath() {
    this._path += "Z";
  }
  arc(x, y, r) {
    this._path += `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  arcTo(x, y) {
    this._path += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  fill(p) {
    const d = p && p.d ? p.d : this._path;
    if (!d) return;
    const f = typeof this.fillStyle === "object" && this.fillStyle.stops ? this.fillStyle.stops[0] : this.fillStyle;
    this.out.push(`<path d="${d}" fill="${f}" fill-opacity="${this.globalAlpha}"/>`);
  }
  stroke() {
    if (this._path) this.out.push(`<path d="${this._path}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.lineWidth}"/>`);
  }
  fillRect(x, y, w, h) {
    const f = typeof this.fillStyle === "object" && this.fillStyle.stops ? this.fillStyle.stops[0] : this.fillStyle;
    this.out.push([`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`, x, y, w, h]);
  }
  drawImage() {}
  measureText(t) {
    return { width: t.length * 6.2 };
  }
  fillText() {}
  createLinearGradient() {
    return { stops: ["#0d1015"], addColorStop(o, c) { if (!this.stops.length) this.stops.push(c); } };
  }
}

class Path2D {
  constructor() {
    this.d = "";
  }
  moveTo(x, y) {
    this.d += `M${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  lineTo(x, y) {
    this.d += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  rect(x, y, w, h) {
    this.d += `M${x.toFixed(2)} ${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}Z`;
  }
  closePath() {
    this.d += "Z";
  }
}

function installGlobals() {
  global.Path2D = Path2D;
  global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    visualViewport: null,
  };
  global.document = {
    createElement: () => ({ width: 0, height: 0, style: {}, _ctx: null, getContext() { return (this._ctx ||= new Ctx(0, 0)); } }),
    addEventListener() {},
    getElementById: () => null,
    querySelectorAll: () => [],
  };
}

/* --------------------------------------------------------------- runner ---- */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);

const W = Number(args.w || 1200);
const H = Number(args.h || 800);
const worldFile = args.world || "site/assets/demo-overworld.json";
const out = args.out || "tools/dev/out.svg";

installGlobals();
const { createEngine } = await import(path.resolve("site/assets/map.js"));

const visible = new Ctx(W, H);
global.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => new Ctx(0, 0) });
const bakeHolder = { ctx: null };
const realCreate = global.document.createElement;
global.document.createElement = () => {
  const c = { width: 0, height: 0, style: {}, getContext: () => (bakeHolder.ctx ||= new Ctx(W, H)) };
  return c;
};

const engine = createEngine({
  getContext: () => visible,
  getBoundingClientRect: () => ({ width: W, height: H, top: 0, left: 0 }),
  addEventListener() {},
  style: {},
  setPointerCapture() {},
});
engine.state.width = W;
engine.state.height = H;
engine.state.dpr = 1;

const world = JSON.parse(fs.readFileSync(worldFile, "utf8"));
engine.setWorld(world);
if (args.view) engine.setView(args.view);
if (args.structures === "false") engine.setStructures(false);
if (args.shade === "false") engine.setHillshade(false);

const zoom = Number(args.zoom || engine.state.zoom);
engine.state.zoom = engine.state.targetZoom = zoom;
if (args.x !== undefined) engine.state.camX = engine.state.targetX = Number(args.x);
if (args.z !== undefined) engine.state.camZ = engine.state.targetZ = Number(args.z);
engine.state.camY = engine.state.targetY = engine.heightAt(Math.round(engine.state.camX), Math.round(engine.state.camZ)) ?? engine.state.world.maxY;

bakeHolder.ctx.out.length = 0;
engine.bakeNow();

const svg = bakeHolder.ctx.out
  .map((o) => {
    if (typeof o === "string") return o;
    if (Array.isArray(o)) return o[0];
    return "";
  })
  .join("");
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`);
const png = out.replace(/\.svg$/, ".png");
console.log(
  `view=${engine.state.view} zoom=${zoom.toFixed(2)} drawn=${engine.state.drawn} details=${engine.state.detailsDrawn} ` +
    `bake=${engine.state.bakeMs}ms structures=${engine.state.layers.structures} -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`
);
void zlib;
void realCreate;
void png;
