/**
 * tilty — a tiny isometric Minecraft heightmap renderer.
 *
 * No dependencies, no build step, no WebGL. One visible <canvas>2D, a painter's
 * algorithm, and a chunk of JSON. Works on phones because interaction never
 * repaints the scene: the scene is baked into an offscreen canvas and the
 * camera blits + scales that bitmap. Re-bake happens when the camera settles.
 *
 * Coordinate system: world x/z in blocks, y up. Screen:
 *   sx = W/2 + (x - camX - (z - camZ)) * tw/2
 *   sy = H/2 + (x - camX + (z - camZ)) * th/2 - (y - camY) * th
 * with tw = zoom (block width in px) and th = zoom / 2 (block height).
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const MAX_CLIFF = 12; // how many blocks of side face we bother drawing

/* --------------------------------------------------------------- colour --- */
function shade(hex, amount) {
  const r = clamp(Math.round(((hex >> 16) & 255) * amount), 0, 255);
  const g = clamp(Math.round(((hex >> 8) & 255) * amount), 0, 255);
  const b = clamp(Math.round((hex & 255) * amount), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function buildPaletteCss(palette) {
  const css = new Map();
  for (const [name, entry] of Object.entries(palette || {})) {
    const top = Array.isArray(entry) ? entry[0] : entry;
    const side = Array.isArray(entry) && entry.length > 1 ? entry[1] : top;
    css.set(name, {
      top: shade(top, 1),
      right: shade(side, 0.78),
      left: shade(side, 0.58),
      raw: top,
      shaded: [1, 0.93, 0.86, 0.78].map((k) => shade(top, k)),
    });
  }
  return css;
}

const FALLBACK = {
  top: "#7e7e7e", right: "#5f5f5f", left: "#4a4a4a", raw: 0x7e7e7e,
  shaded: ["#7e7e7e", "#757575", "#6c6c6c", "#626262"],
};

// block names that mean "nothing is here"
const EMPTY_BLOCKS = new Set(["void", "", "air", "minecraft:air", "unloaded", "unknown"]);

/* ---------------------------------------------------------------- engine --- */
export function createEngine(canvas, opts = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const bake = document.createElement("canvas");
  const bakeCtx = bake.getContext("2d", { alpha: false });

  const state = {
    width: 1,
    height: 1,
    dpr: 1,
    zoom: 4,
    minZoom: 1,
    maxZoom: 48,
    camX: 0,
    camY: 64,
    camZ: 0,
    targetZoom: 4,
    targetX: 0,
    targetY: 64,
    targetZ: 0,
    smoothing: 0.3,
    relief: true,
    labels: true,
    followY: true,
    world: null,
    pois: [],
    hover: null,
    drawn: 0,
    detailsDrawn: 0,
    bakeMs: 0,
    onHover: opts.onHover || null,
    onPick: opts.onPick || null,
  };

  // camera + zoom the baked bitmap was rendered at
  const baked = { valid: false, x: 0, y: 0, z: 0, zoom: 4, w: 0, h: 0, dpr: 1, relief: true };

  /* ---------------------------------------------------------- world load --- */
  function setWorld(world) {
    const t0 = performance.now();
    const bbox = world.bbox;
    const n = bbox.width * bbox.depth;

    const palette = buildPaletteCss(world.palette);
    const names = new Map();
    const blocks = new Uint8Array(n);
    // index 0 = "no column", real block ids start at 1
    const blockNames = [""];

    for (let i = 0; i < n; i++) {
      const name = world.blocks[i];
      if (EMPTY_BLOCKS.has(name)) continue; // stays id 0 = empty column
      let id = names.get(name);
      if (id === undefined) {
        id = blockNames.length;
        names.set(name, id);
        blockNames.push(name);
        if (!palette.has(name)) palette.set(name, FALLBACK);
      }
      blocks[i] = id;
    }

    const heights = new Int16Array(n);
    for (let i = 0; i < n; i++) heights[i] = world.heights[i];

    // bucket detail blocks by column so they interleave with depth order
    const cellDetails = new Map();
    for (const d of world.details || []) {
      const x = d[0];
      const y = d[1];
      const z = d[2];
      if (x < bbox.minX || z < bbox.minZ || x >= bbox.minX + bbox.width || z >= bbox.minZ + bbox.depth) continue;
      if (EMPTY_BLOCKS.has(d[3])) continue;
      let id = names.get(d[3]);
      if (id === undefined) {
        id = blockNames.length;
        names.set(d[3], id);
        blockNames.push(d[3]);
        if (!palette.has(d[3])) palette.set(d[3], FALLBACK);
      }
      const key = (z - bbox.minZ) * bbox.width + (x - bbox.minX);
      let list = cellDetails.get(key);
      if (!list) cellDetails.set(key, (list = []));
      list.push(y, id);
    }

    let minY = Infinity;
    let maxY = -Infinity;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!blocks[i]) continue;
      const h = heights[i];
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      total++;
    }

    state.world = {
      meta: world,
      bbox,
      blocks,
      heights,
      blockNames,
      palette,
      cellDetails,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 80,
      columns: total,
      loadMs: Math.round(performance.now() - t0),
    };
    fitToWorld();
    doBake();
    draw();
    return state.world;
  }

  /* ------------------------------------------------------------ camera ---- */
  function fitToWorld(padding = 0.88) {
    if (!state.world) return;
    const b = state.world.bbox;
    const cx = b.minX + b.width / 2;
    const cz = b.minZ + b.depth / 2;
    const relief = Math.max(8, state.world.maxY - state.world.minY);
    const twForWidth = (state.width * padding) / ((b.width + b.depth) / 2);
    const twForHeight = (state.height * padding) / ((b.width + b.depth) / 4 + relief / 2);
    const z = Math.min(twForWidth, twForHeight, 24);
    state.zoom = state.targetZoom = clamp(z, 0.5, state.maxZoom);
    state.camX = state.targetX = cx;
    state.camZ = state.targetZ = cz;
    state.followY = true;
    state.camY = state.targetY = heightAt(Math.round(cx), Math.round(cz)) ?? state.world.maxY;
    state.minZoom = clamp(state.zoom * 0.4, 0.3, 2);
    invalidate();
  }

  function centerOn(x, z, zoom) {
    state.followY = true;
    state.targetX = x;
    state.targetZ = z;
    if (zoom) state.targetZoom = clamp(zoom, state.minZoom, state.maxZoom);
    invalidate();
  }

  /* -------------------------------------------------------- projections ---- */
  function project(x, z, y = 0) {
    const tw = state.zoom;
    return {
      x: state.width / 2 + (x - state.camX - (z - state.camZ)) * (tw / 2),
      y: state.height / 2 + (x - state.camX + (z - state.camZ)) * (tw / 4) - (y - state.camY) * (tw / 2),
    };
  }

  function unproject(px, py, y = 0) {
    const tw = state.zoom;
    const a = (px - state.width / 2) / (tw / 2);
    const sum = ((py - state.height / 2) * 4) / tw + 2 * (y - state.camY);
    return { x: (a + sum) / 2 + state.camX, z: (sum - a) / 2 + state.camZ };
  }

  function idx(x, z) {
    const b = state.world.bbox;
    const ix = x - b.minX;
    const iz = z - b.minZ;
    if (ix < 0 || iz < 0 || ix >= b.width || iz >= b.depth) return -1;
    return iz * b.width + ix;
  }

  function heightAt(x, z) {
    if (!state.world) return null;
    const i = idx(x, z);
    return i < 0 ? null : state.world.heights[i];
  }

  /* -------------------------------------------------------------- picking -- */
  function pointInQuad(u, v, quad) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = quad[i][0];
      const yi = quad[i][1];
      const xj = quad[j][0];
      const yj = quad[j][1];
      if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pick(px, py) {
    const w = state.world;
    if (!w) return null;
    const tw = state.zoom;
    for (let y = w.maxY + 30; y >= w.minY - 2; y -= 1) {
      const p = unproject(px, py, y);
      const cx = Math.round(p.x);
      const cz = Math.round(p.z);
      const found = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          const i = idx(x, z);
          if (i < 0) continue;
          const id = w.blocks[i];
          if (!id) continue;
          const h = w.heights[i];
          const sc = project(x, z, h);
          const u = (px - sc.x) / (tw / 2);
          const v = (py - sc.y) / (tw / 4);
          const hR = heightAt(x + 1, z);
          const hL = heightAt(x, z + 1);
          const dR = Math.max(0, h - (hR == null ? h : hR));
          const dL = Math.max(0, h - (hL == null ? h : hL));
          let face = null;
          if (Math.abs(u) + Math.abs(v) <= 1) face = "top";
          else if (dR > 0 && u >= 0 && v >= 0) face = "side";
          else if (dL > 0 && u <= 0 && v >= 0) face = "side";
          if (face) found.push({ x, z, y: h, block: w.blockNames[id], sum: x + z, face });
        }
      }
      if (found.length) {
        found.sort((a, c) => c.sum - a.sum);
        return found[0];
      }
    }
    return null;
  }

  /* ------------------------------------------------------- scene painter --- */
  function paintScene(g, W, H, camX, camY, camZ, zoom, relief) {
    const w = state.world;
    const tw = zoom;
    const th = tw / 2;
    const halfW = tw / 2;
    const halfH = tw / 4;
    const grow = 0.5; // seam killer: overlapping sub-pixel edges

    g.setTransform(1, 0, 0, 1, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0d1015");
    bg.addColorStop(1, "#131a21");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    if (!w) return 0;

    const b = w.bbox;

    // visible range: unproject the screen corners at two heights
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const probe = (px, py, y) => {
      const a = (px - W / 2) / (tw / 2);
      const sum = ((py - H / 2) * 4) / tw + 2 * (y - camY);
      const x = (a + sum) / 2 + camX;
      const z = (sum - a) / 2 + camZ;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    probe(-tw, -tw, camY + 40);
    probe(W + tw, -tw, camY + 40);
    probe(-tw, H + tw, camY - 40);
    probe(W + tw, H + tw, camY - 40);

    minX = clamp(Math.floor(minX) - 1, b.minX, b.minX + b.width - 1);
    maxX = clamp(Math.ceil(maxX) + 1, b.minX, b.minX + b.width - 1);
    minZ = clamp(Math.floor(minZ) - 1, b.minZ, b.minZ + b.depth - 1);
    maxZ = clamp(Math.ceil(maxZ) + 1, b.minZ, b.minZ + b.depth - 1);
    if (minX > maxX || minZ > maxZ) return 0;

    const blocks = w.blocks;
    const heights = w.heights;
    const palette = w.palette;
    const names = w.blockNames;
    const details = w.cellDetails;
    const bw = b.width;
    const bx = b.minX;
    const bz = b.minZ;
    const xMax = b.minX + b.width - 1;
    const zMax = b.minZ + b.depth - 1;
    const cullL = -tw;
    const cullR = W + tw;
    const cullT = -th * 4;
    const cullB = H + th * 6;

    // how strongly side faces are shaded. At 1:1 the world reads as blocks; when
    // zoomed all the way out the same shading turns into contour lines, so fade
    // it towards flat colour instead.
    const sideMix = clamp((tw - 1.6) / 6, 0.16, 1);
    const sideFactor = (amount) => 1 - (1 - amount) * sideMix;
    // level of detail for stacked blocks: skip them entirely when a block is a
    // couple of pixels, and skip their side faces until they read as blocks
    const drawDetails = tw >= 2.4;
    const detailSides = tw >= 5;
    const detailGrow = Math.max(0.5, tw * 0.06);
    // hillshade steps used by the far-out view (index = blocks of drop)
    const SHADE_BUCKETS = [1, 0.9, 0.79, 0.66];

    let drawn = 0;
    let detailCount = 0;

    /* --- flat mode: batch one path per block colour, fill once per colour.
           Cheap enough for the whole world on screen at once.             --- */
    if (!relief) {
      // Flat mode doubles as the far-out view. Instead of drawing side faces
      // (which at a pixel or two per block read as contour lines), darken the
      // top face by how steep the column is: a cheap hillshade.
      const paths = new Map(); // "bucket|colourKey" -> Path2D
      for (let s = minX + minZ; s <= maxX + maxZ; s++) {
        const xStart = Math.max(minX, s - maxZ);
        const xEnd = Math.min(maxX, s - minZ);
        for (let x = xStart; x <= xEnd; x++) {
          const z = s - x;
          const i = (z - bz) * bw + (x - bx);
          const id = blocks[i];
          if (!id) continue;
          const h = heights[i];
          const sx = W / 2 + (x - camX - (z - camZ)) * halfW;
          const sy = H / 2 + (x - camX + (z - camZ)) * halfH - (h - camY) * tw;
          if (sx + tw < cullL || sx - tw > cullR || sy + tw < cullT || sy - tw > cullB) continue;
          const base = palette.get(names[id]) || FALLBACK;
          let bucket = 0;
          const hR = x < xMax ? heights[i + 1] : h;
          const hL = z < zMax ? heights[i + bw] : h;
          const drop = Math.max(0, h - hR, h - hL);
          if (drop >= 3) bucket = 3;
          else if (drop >= 2) bucket = 2;
          else if (drop >= 1) bucket = 1;
          const key = bucket + "|" + base.raw;
          let p = paths.get(key);
          if (!p) paths.set(key, (p = new Path2D()));
          p.moveTo(sx, sy - halfH - grow);
          p.lineTo(sx + halfW + grow, sy);
          p.lineTo(sx, sy + halfH + grow);
          p.lineTo(sx - halfW - grow, sy);
          p.closePath();
          drawn++;
        }
      }
      for (const [key, p] of paths) {
        const sep = key.indexOf("|");
        const bucket = Number(key.slice(0, sep));
        const raw = Number(key.slice(sep + 1));
        g.fillStyle = bucket === 0 ? "#" + raw.toString(16).padStart(6, "0") : shade(raw, SHADE_BUCKETS[bucket]);
        g.fill(p);
      }
      // sparse details are still worth drawing when zoomed out to give texture
      if (tw >= 2.4) {
        for (const [cell, det] of details) {
          const x = (cell % bw) + bx;
          const z = Math.floor(cell / bw) + bz;
          const h = heights[cell];
          const sx = W / 2 + (x - camX - (z - camZ)) * halfW;
          const sy = H / 2 + (x - camX + (z - camZ)) * halfH - (h - camY) * tw;
          if (sx + tw < cullL || sx - tw > cullR || sy + tw < cullT || sy - tw > cullB) continue;
          for (let k = det.length - 2; k >= 0; k -= 2) {
            const y = det[k];
            const col = (palette.get(names[det[k + 1]]) || FALLBACK).top;
            const ty = sy - (y - h) * tw;
            g.fillStyle = col;
            g.beginPath();
            g.moveTo(sx, ty - halfH);
            g.lineTo(sx + halfW, ty);
            g.lineTo(sx, ty + halfH);
            g.lineTo(sx - halfW, ty);
            g.closePath();
            g.fill();
            detailCount++;
          }
        }
      }
      state.detailsDrawn = detailCount;
      return drawn;
    }

    /* --- relief mode: painter's order, one column at a time --- */
    for (let s = minX + minZ; s <= maxX + maxZ; s++) {
      const xStart = Math.max(minX, s - maxZ);
      const xEnd = Math.min(maxX, s - minZ);
      for (let x = xStart; x <= xEnd; x++) {
        const z = s - x;
        const i = (z - bz) * bw + (x - bx);
        const id = blocks[i];
        if (!id) continue;
        const h = heights[i];

        const sx = W / 2 + (x - camX - (z - camZ)) * halfW;
        const sy = H / 2 + (x - camX + (z - camZ)) * halfH - (h - camY) * tw;

        // a neighbour outside the map is treated as the same height, so the
        // edge of an export does not grow a giant wall of cliff faces
        const dR = x < xMax && blocks[i + 1] ? Math.min(MAX_CLIFF, Math.max(0, h - heights[i + 1])) : 0;
        const dL = z < zMax && blocks[i + bw] ? Math.min(MAX_CLIFF, Math.max(0, h - heights[i + bw])) : 0;
        const drop = Math.max(dR, dL) * th;
        if (sx + tw < cullL || sx - tw > cullR || sy - tw > cullB || sy + tw + drop < cullT) continue;

        const col = palette.get(names[id]) || FALLBACK;
        drawn++;

        if (dR > 0 && sideMix > 0.2) {
          g.fillStyle = shade(col.raw, sideFactor(0.78));
          g.beginPath();
          g.moveTo(sx + halfW + grow, sy);
          g.lineTo(sx, sy + halfH);
          g.lineTo(sx, sy + halfH + dR * th);
          g.lineTo(sx + halfW + grow, sy + dR * th);
          g.closePath();
          g.fill();
        }
        if (dL > 0 && sideMix > 0.2) {
          g.fillStyle = shade(col.raw, sideFactor(0.58));
          g.beginPath();
          g.moveTo(sx, sy + halfH);
          g.lineTo(sx - halfW - grow, sy);
          g.lineTo(sx - halfW - grow, sy + dL * th);
          g.lineTo(sx, sy + halfH + dL * th);
          g.closePath();
          g.fill();
        }

        g.fillStyle = col.top;
        g.beginPath();
        g.moveTo(sx, sy - halfH - grow);
        g.lineTo(sx + halfW + grow, sy);
        g.lineTo(sx, sy + halfH + grow);
        g.lineTo(sx - halfW - grow, sy);
        g.closePath();
        g.fill();

        const det = drawDetails ? details.get(i) : null;
        if (det) {
          detailCount += det.length / 2;
          for (let k = 0; k < det.length; k += 2) {
            const y = det[k];
            const dy = (h - y) * tw;
            const c2 = palette.get(names[det[k + 1]]) || FALLBACK;
            const ty = sy - dy;
            if (ty - th > cullB || ty + tw < cullT) continue;
            const flatish = names[det[k + 1]] === "glass" || !detailSides;
            if (!flatish) {
              g.fillStyle = c2.right;
              g.beginPath();
              g.moveTo(sx + halfW + grow, ty);
              g.lineTo(sx, ty + halfH);
              g.lineTo(sx, ty + halfH + tw);
              g.lineTo(sx + halfW + grow, ty + tw);
              g.closePath();
              g.fill();
              g.fillStyle = c2.left;
              g.beginPath();
              g.moveTo(sx, ty + halfH);
              g.lineTo(sx - halfW - grow, ty);
              g.lineTo(sx - halfW - grow, ty + tw);
              g.lineTo(sx, ty + halfH + tw);
              g.closePath();
              g.fill();
            }
            g.fillStyle = c2.top;
            g.beginPath();
            g.moveTo(sx, ty - halfH - grow);
            g.lineTo(sx + halfW + grow, ty);
            g.lineTo(sx, ty + halfH + grow);
            g.lineTo(sx - halfW - grow, ty);
            g.closePath();
            g.fill();
          }
        }
      }
    }
    state.detailsDrawn = detailCount;
    return drawn;
  }

  /* ------------------------------------------------------------- baking --- */
  const REBAKE_DELAY = 110;
  let bakeTimer = 0;

  function invalidate() {
    baked.valid = false;
    if (bakeTimer) return;
    bakeTimer = setTimeout(() => {
      bakeTimer = 0;
      if (!baked.valid) {
        doBake();
        draw();
      }
    }, REBAKE_DELAY);
  }

  function doBake() {
    if (!state.world) return;
    const w = state.width;
    const h = state.height;
    const dpr = state.dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (bake.width !== bw || bake.height !== bh) {
      bake.width = bw;
      bake.height = bh;
    }
    const effectiveRelief = state.relief && state.zoom >= 2.2;

    bakeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t0 = performance.now();
    bakeCtx.save();
    state.drawn = paintScene(bakeCtx, w, h, state.camX, state.camY, state.camZ, state.zoom, effectiveRelief);
    bakeCtx.restore();
    state.bakeMs = Math.round(performance.now() - t0);
    Object.assign(baked, {
      valid: true,
      x: state.camX,
      y: state.camY,
      z: state.camZ,
      zoom: state.zoom,
      w,
      h,
      dpr,
      relief: effectiveRelief,
    });
  }

  /* ------------------------------------------------------- overlay layer --- */
  function markerHeight(x, z) {
    const h = heightAt(Math.round(x), Math.round(z));
    return h == null ? (state.world ? state.world.maxY : 64) : h + 1;
  }

  function drawPin(x, y, active) {
    const r = active ? 6.5 : 5;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = active ? "#ffb45c" : "#7ee0a1";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(8,11,15,.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawOverlay() {
    if (state.labels) {
      ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (const p of state.pois) {
        const s = project(p.x, p.z, markerHeight(p.x, p.z));
        if (s.x < -80 || s.x > state.width + 80 || s.y < -40 || s.y > state.height + 70) continue;
        drawPin(s.x, s.y, p.active);
        const wpx = ctx.measureText(p.name).width;
        const pad = 6;
        ctx.fillStyle = "rgba(11,14,19,.82)";
        roundRect(s.x - wpx / 2 - pad, s.y - 33, wpx + pad * 2, 19, 6);
        ctx.fill();
        ctx.fillStyle = p.active ? "#ffd9a0" : "#e9eef5";
        ctx.fillText(p.name, s.x, s.y - 18);
      }
    }
    if (state.hover) {
      const h = state.hover;
      const s = project(h.x, h.z, h.y);
      const q = state.zoom / 4;
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - q);
      ctx.lineTo(s.x + q, s.y);
      ctx.lineTo(s.x, s.y + q);
      ctx.lineTo(s.x - q, s.y);
      ctx.closePath();
      ctx.stroke();
    }
  }

  /* --------------------------------------------------------------- draw --- */
  function draw() {
    const W = state.width;
    const H = state.height;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (!baked.valid) {
      ctx.fillStyle = "#0d1015";
      ctx.fillRect(0, 0, W, H);
    } else {
      const k = state.zoom / baked.zoom;
      const zb = baked.zoom;
      const dx = state.camX - baked.x;
      const dz = state.camZ - baked.z;
      const dy = state.camY - baked.y;
      // screen-space translation between the baked camera and the live one
      const shiftX = -k * (dx - dz) * (zb / 2);
      const shiftY = -k * (dx + dz) * (zb / 4) + k * dy * (zb / 2);
      ctx.setTransform(
        k * state.dpr,
        0,
        0,
        k * state.dpr,
        state.dpr * (W / 2 - k * (W / 2) + shiftX),
        state.dpr * (H / 2 - k * (H / 2) + shiftY)
      );
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bake, 0, 0, baked.w, baked.h, 0, 0, W, H);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    }
    drawOverlay();
  }

  /* ---------------------------------------------------------- loop/paint --- */
  let frame = 0;
  let lastCamera = { x: 0, y: 0, z: 0, zoom: 0 };

  function requestRender() {
    if (frame) return;
    frame = requestAnimationFrame(step);
  }

  function step() {
    frame = 0;
    let animating = false;
    if (state.followY && state.world) {
      const gy = heightAt(Math.round(state.targetX), Math.round(state.targetZ));
      if (gy != null) state.targetY = gy;
    }
    if (Math.abs(state.targetZoom - state.zoom) > 1e-3) {
      state.zoom = lerp(state.zoom, state.targetZoom, state.smoothing);
      animating = true;
    }
    if (Math.abs(state.targetX - state.camX) > 0.02) {
      state.camX = lerp(state.camX, state.targetX, state.smoothing);
      animating = true;
    }
    if (Math.abs(state.targetZ - state.camZ) > 0.02) {
      state.camZ = lerp(state.camZ, state.targetZ, state.smoothing);
      animating = true;
    }
    if (Math.abs(state.targetY - state.camY) > 0.02) {
      state.camY = lerp(state.camY, state.targetY, state.smoothing);
      animating = true;
    }
    const movedFar = Math.hypot(state.camX - lastCamera.x, state.camZ - lastCamera.z) > 0.5 ||
      Math.abs(state.zoom - lastCamera.zoom) > 1e-3 || Math.abs(state.camY - lastCamera.y) > 0.5;
    if (!baked.valid || movedFar) invalidate();
    lastCamera = { x: baked.x, y: baked.y, z: baked.z, zoom: baked.zoom };
    draw();
    if (animating) requestRender();
  }

  function render() {
    if (!baked.valid) doBake();
    draw();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === state.width && height === state.height && dpr === state.dpr) return;
    state.dpr = dpr;
    state.width = width;
    state.height = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    baked.valid = false;
    doBake();
    draw();
  }

  /* ------------------------------------------------------------- camera ---- */
  function panByScreen(dx, dy) {
    state.followY = true;
    const tw = state.zoom;
    const ax = (dx + 2 * dy) / tw;
    const az = (2 * dy - dx) / tw;
    state.targetX -= ax;
    state.targetZ -= az;
    state.camX = state.targetX;
    state.camZ = state.targetZ;
  }

  function panByWorld(dx, dz) {
    state.followY = true;
    state.targetX += dx;
    state.targetZ += dz;
    invalidate();
  }

  function zoomAt(px, py, factor) {
    const nz = clamp(state.targetZoom * factor, state.minZoom, state.maxZoom);
    if (Math.abs(nz - state.zoom) < 1e-4) return;
    // keep the world point under the cursor pinned: find it before, change the
    // zoom, find it again, then slide the camera by the difference.
    const before = unproject(px, py, state.camY);
    state.zoom = state.targetZoom = nz;
    const after = unproject(px, py, state.camY);
    state.camX = state.targetX += before.x - after.x;
    state.camZ = state.targetZ += before.z - after.z;
    invalidate();
  }

  function setZoom(z, anchor) {
    const px = anchor ? anchor.x : state.width / 2;
    const py = anchor ? anchor.y : state.height / 2;
    zoomAt(px, py, clamp(z, state.minZoom, state.maxZoom) / state.zoom);
  }

  /* ------------------------------------------------------------- input ----- */
  const pointers = new Map();
  let pinch = null;
  let dragging = false;
  let moved = false;
  let downAt = 0;
  let inertia = { x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    dragging = true;
    downAt = performance.now();
    inertia = { x: 0, y: 0 };
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinch = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), zoom: state.targetZoom };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    if (!dragging) {
      if (e.pointerType !== "mouse") return;
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      const changed = (!hit && state.hover) || (hit && (!state.hover || state.hover.x !== hit.x || state.hover.z !== hit.z));
      state.hover = hit;
      if (changed) {
        draw();
        state.onHover?.(hit);
      }
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinch && pinch.dist > 4) {
        const mid = { x: (p1.x + p2.x) / 2 - rect.left, y: (p1.y + p2.y) / 2 - rect.top };
        const target = clamp(pinch.zoom * (dist / pinch.dist), state.minZoom, state.maxZoom);
        zoomAt(mid.x, mid.y, target / state.zoom);
        draw();
      }
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    inertia = { x: dx, y: dy };
    panByScreen(dx, dy);
    draw();
    requestRender();
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    dragging = false;
    if (!moved && performance.now() - downAt < 450) {
      const rect = canvas.getBoundingClientRect();
      void rect;
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      state.onPick?.(hit);
    }
    if (!baked.valid) invalidate();
    if (Math.hypot(inertia.x, inertia.y) > 2) {
      let vx = inertia.x;
      let vy = inertia.y;
      const glide = () => {
        if (Math.hypot(vx, vy) < 0.5) {
          invalidate();
          return;
        }
        panByScreen(vx, vy);
        vx *= 0.9;
        vy *= 0.9;
        draw();
        requestAnimationFrame(glide);
      };
      requestAnimationFrame(glide);
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (pointers.size === 0 && state.hover) {
      state.hover = null;
      draw();
      state.onHover?.(null);
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      draw();
    },
    { passive: false }
  );

  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const target = state.targetZoom * 2 > state.maxZoom ? state.minZoom * 2 : state.targetZoom * 2;
    state.targetZoom = target;
    zoomAt(at.x, at.y, 1);
    draw();
  });

  canvas.style.touchAction = "none";
  window.addEventListener("resize", resize);

  return {
    state,
    setWorld,
    resize,
    render,
    requestRender,
    invalidate,
    fitToWorld,
    centerOn,
    setZoom,
    project,
    unproject,
    pick,
    heightAt,
    panByWorld,
    setPois(pois) {
      state.pois = pois || [];
      draw();
    },
    setLabels(on) {
      state.labels = on;
      draw();
    },
    setRelief(on) {
      state.relief = on;
      invalidate();
      doBake();
      draw();
    },
    bakeNow() {
      doBake();
      draw();
    },
    destroy() {
      window.removeEventListener("resize", resize);
    },
  };
}

export const __test = { shade, buildPaletteCss };
