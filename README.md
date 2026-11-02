# tilty — your Minecraft world on the web

An isometric Minecraft map viewer that is **only static files**: HTML, CSS, two JS
modules and some JSON. No server, no database, no WebGL, no build step. It runs on
GitHub Pages and on Cloudflare Pages, works on a phone, and degrades gracefully on
a five-year-old one.

![what it is](https://img.shields.io/badge/backend-none-7ee0a1) ![deps](https://img.shields.io/badge/dependencies-zero-7ee0a1)

The repository also contains the honest answer to "what can static hosting actually
do with my world", with numbers — see [What's possible](#whats-possible) below, or
open the live site and read the *Options* tab.

---

## Quick start

```bash
# 1. look at the demo
cd site && python3 -m http.server 8080
#    → http://localhost:8080

# 2. put your own world on it
python3 tools/regions_to_json.py ~/.minecraft/saves/MyWorld \
        -o site/assets/world.json --details
python3 tools/regions_to_json.py ~/.minecraft/saves/MyWorld \
        -o site/assets/nether.json --dimension nether
cp site/assets/config.example.json site/assets/config.json   # then edit paths

# 3. publish
git push            # .github/workflows/deploy.yml does the rest
```

Nothing is uploaded anywhere: the converter runs on your machine, the map is a
plain file the browser fetches.

---

## What's possible

Read this as three buckets. The dividing line is simple: **a static host serves
files and runs no code**, so anything that needs a live connection to your
Minecraft server is out.

### Yes — works well on free static hosting

| Feature | How |
|---|---|
| Top-down / isometric map at any zoom | tile set from uNmINeD, or a single JSON heightmap (this project) |
| Full 3D fly-around | BlueMap's static export (three.js, WebGL) |
| Pinch-zoom, pan, deep links | plain JS; camera goes in the URL hash |
| Dimension switching | one file or folder per dimension |
| Named places, waypoints, notes | a small `pois.json` |
| Screenshots / print maps | `canvas.toDataURL()` |
| Custom domain, HTTPS | both GitHub Pages and Cloudflare Pages, free |
| Private world, public map | convert locally or in a private Action; publish only the render |

### Possible with effort

| Thing | The catch |
|---|---|
| Big worlds | GitHub Pages caps the *published site* at **1 GB**; Cloudflare Pages caps a deployment at **20,000 files**, 25 MiB each. A 5 km-radius world rendered at 1:1 is already several GB. |
| Live-ish updates | a scheduled Action can re-render and redeploy. That is a snapshot on a timer, not a live map. |
| Signs, chest contents, mobs, item frames | renderers draw blocks only. Add your own labels as a POI file instead. |
| Modded blocks | correct colours need a palette/resource-pack mapping; vanilla works out of the box, mods are configuration. |
| Big tile sets | keep HTML/CSS/JS on Pages, move tiles to Cloudflare R2 (10 GB free, no egress fees) behind the same domain. |

### No — not on a static host

| Thing | Why | Where to go instead |
|---|---|---|
| Live player positions, chat, console | needs a process that can reach your server | Dynmap or squaremap on the server itself |
| Editing the world from the browser | no writes, no auth, no backend | — |
| Uploading a world through the site | nowhere to persist it, and a 2 GB save in a tab is a memory problem | convert locally |
| Keeping coordinates private while the map is public | anything on Pages is public, even from a private repo | obfuscated URL, `--area` to render a safe region, or Cloudflare Access |

---

## Host comparison

|  | GitHub Pages | Cloudflare Pages |
|---|---|---|
| Cost | free | free |
| Published site size | **1 GB** | no total cap documented |
| Per file | no published cap | **25 MiB** |
| Files per deployment | no published cap (deploys get slow) | **20,000** |
| Bandwidth | 100 GB/month *soft* | unlimited for static assets |
| Builds | 10/hour (branch deploys) | 500/month, 20 min timeout |
| Custom domain + HTTPS | yes | yes |
| Commercial use | restricted by policy | allowed |
| Setup | repo → Settings → Pages | connect repo or `wrangler pages deploy` |

**Verdict:** start on GitHub Pages. It is the least setup, the map lives next to the
code, and a normal survival world fits comfortably. Move to Cloudflare Pages when you
want unlimited traffic or bigger single files; move the tile folder to R2 the moment
you approach 20,000 files (a uNmINeD export at `--zoomin 3` is ~12,000 files for a
small world — it is easier to hit than you would think).

Only leave static hosting if you need *live* data. And if you need live data, the
right answer is usually a map plugin on the server, not a static site plus a backend
you now have to keep alive.

---

## Renderer comparison

Same world (5 km radius, 393,129 chunks), same machine, default settings:

| Tool | Look | Output size | Render time | Files | Verdict |
|---|---|---|---|---|---|
| **tilty** (this repo) | isometric heightmap, 2D canvas | 2–20 MB JSON | seconds | 1–4 | fast on phones, no 3D, no full block detail |
| **uNmINeD** | 2D top-down + isometric, tile pyramid | 376 MB | 16 min | ~thousands | best quality per byte, Java **and** Bedrock |
| **BlueMap** | true 3D mesh, WebGL | 6.5 GB | 2 h 37 min | tens of thousands | gorgeous, heavy, needs a decent GPU |
| **Overviewer** | 2D tiles | 15.5 GB | 9 h | ~millions | unmaintained since 2023 — skip |
| **Dynmap / squaremap** | live 2D | server-side | live | — | the only option for live players, not static |

Numbers for uNmINeD/BlueMap/Overviewer come from a published side-by-side render of
one world, so they are comparable to each other; tilty's are from this repo's own
export.

---

## How this viewer works

* One `<canvas>`, painter's algorithm, diamond tiles in depth order (`x + z`).
* The scene is **baked** into an offscreen bitmap when the camera settles; dragging,
  pinching and zooming animate by blitting and scaling that bitmap. That is why
  panning stays smooth on a phone with 70,000 columns loaded.
* Side faces are drawn only where a neighbour is lower, capped at 12 blocks, and fade
  towards flat colour when zoomed out — otherwise every 1-block step became a contour
  line across the whole map.
* Nothing is pre-tiled, so there is no HTTP request storm: one file, one `fetch`,
  122 KB gzipped for the demo overworld.

### Data format

```jsonc
{
  "name": "My World",
  "dimension": "overworld",
  "bbox":    { "minX": 0, "minZ": 0, "width": 512, "depth": 512 },
  "palette": { "grass_block": [7977404], "oak_log": [7033139, 5973801] },
  "blocks":  ["grass_block", "water", "void", "..."],   // row-major, index = z * width + x
  "heights": [72, 63, 0, "..."],                        // surface y per column
  "details": [[12, 73, 40, "oak_leaves"], ["..."]]      // extra blocks above the surface
}
```

* `blocks` values are vanilla block names; `void`/`air`/`unloaded` mean "nothing here".
* `palette` values are `[top]` or `[top, side]` as `0xRRGGBB` integers.
* `details` are drawn on top of their column and are the expensive part — keep them
  sparse (trees, buildings) rather than exporting everything.
* Provide only what matters: a 512×512 world is 262,144 columns ≈ 1.5 MB raw, 60 KB
  gzipped.

---

## Tools in this repo

| Path | What it does |
|---|---|
| `tools/regions_to_json.py` | `.mca` (Anvil) → tilty JSON. Pure Python, no deps. Handles format 1.13–1.21 and legacy 1.8–1.12, overworld/Nether/End, vanilla + Bukkit layouts, `--area`, `--details`, `--selftest`. |
| `tools/make_demo_world.py` | generates the fictional "Ember Hollow" demo world (three dimensions) |
| `site/` | the whole published site; point Pages at this folder |
| `site/assets/config.example.json` | swap the demo for your own export |
| `site/assets/pois.example.json` | named places / waypoints |
| `.github/workflows/deploy.yml` | GitHub Pages deploy |

### Using the converter

```bash
python3 tools/regions_to_json.py --selftest                  # parser check, no world needed
python3 tools/regions_to_json.py SAVE -o out.json            # overworld surface only
python3 tools/regions_to_json.py SAVE -o out.json --details  # + trees and buildings
python3 tools/regions_to_json.py SAVE -o out.json --area -4 4 -4 4   # region coordinates
python3 tools/regions_to_json.py SAVE -o nether.json --dimension nether
```

It also prints how big the file is *after gzip*, which is what actually crosses the
wire — that number is what matters for hosting limits.

---

## Deploying

**GitHub Pages**: push to `main`, then *Settings → Pages → Source: GitHub Actions*.
The workflow builds nothing (there is nothing to build) — it regenerates the demo
world, runs the converter's self test, checks the site is self-contained, and uploads
`site/`.

**Cloudflare Pages**: create a project from this repo, build command empty, output
directory `site`. If your tile set grows past 20,000 files, put the tiles in an R2
bucket and keep the HTML on Pages.

**Anywhere else**: `site/` is a static folder. `python3 -m http.server` is enough to
preview it.

---

## Limits and honesty

* The demo world is generated, not played. It exists so the page has something to
  show before you wire up your own save.
* The converter reads the *surface*; it is not a save editor and never writes.
* Rendering a real 5,000×5,000-block world with trees gives a file in the tens of MB.
  It will load, but you will feel it on a phone — use `--area`, or render fewer
  columns. The estimator on the *Add your world* tab exists to tell you before you
  build it.
* No analytics, no cookies, no fonts from a CDN, no external requests at all.

## License

MIT for the code in this repository. Minecraft is a trademark of Mojang; this project
is not affiliated with or endorsed by them, and ships no Mojang assets.
