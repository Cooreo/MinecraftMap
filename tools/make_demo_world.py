#!/usr/bin/env python3
"""
Generates the synthetic "Ember Hollow" demo world used by the example map.

This is NOT a Minecraft world reader — see regions_to_json.py for that. It is a
deterministic toy generator that produces blocks in exactly the JSON shape the
viewer consumes, so the map has something believable to show before you wire up
your own world.

Shape, per dimension:
    site/assets/demo-overworld.json
    site/assets/demo-nether.json
    site/assets/demo-end.json
    site/assets/demo-pois.json

Terrain rules used for the overworld, so it reads well isometrically:
  * height field from smooth value noise + a coastal falloff
  * slope limiter: no column may be more than 1 block above a neighbour
  * sea level fill, beaches, snow caps, gravel patches
  * structures are built from detail blocks on flattened pads

Run: python3 tools/make_demo_world.py
"""
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "site", "assets")

SEA = 63          # sea level
SNOW_LINE = 95
ROCK_LINE = 87

# ---------------------------------------------------------------- palette ----
# block name -> [top rgb, optional side rgb]. Side defaults to the top colour.
PALETTE = {
    "grass_block": [0x7CBD6B, 0x8B6B4A],
    "podzol": [0x6B4A28, 0x5A3D20],
    "dirt": [0x8B6B4A],
    "coarse_dirt": [0x7A5C3E],
    "stone": [0x7E7E7E],
    "cobblestone": [0x7A7A7A],
    "gravel": [0x857E7A],
    "sand": [0xDBD3A0],
    "sandstone": [0xD9CE9B],
    "clay": [0xA0A6B0],
    "water": [0x3F76E4],
    "ice": [0x9CC7E8],
    "snow": [0xF2FAFA],
    "oak_leaves": [0x4C7A34],
    "birch_leaves": [0x6FA044],
    "spruce_leaves": [0x2E5A34],
    "oak_log": [0x6B5333, 0x5B4529],
    "birch_log": [0xD7CFC2, 0xBDB5A6],
    "spruce_log": [0x3B2B1A],
    "oak_planks": [0xB08B57, 0x9C7A4B],
    "spruce_planks": [0x7A5B37],
    "stone_bricks": [0x7B7B7B, 0x6E6E6E],
    "mossy_stone_bricks": [0x6C7A62],
    "bricks": [0x96604F, 0x8A5747],
    "glass": [0xC8E4F0],
    "white_wool": [0xE9ECEC],
    "red_wool": [0xA12722],
    "gold_block": [0xF6D33C],
    "iron_block": [0xD8D8D8],
    "lantern": [0xF7C55A],
    "torch": [0xFFD37A],
    "bookshelf": [0x9A7B4F],
    "lava": [0xD4551A],
    "netherrack": [0x6B3434],
    "nether_bricks": [0x3B1E22],
    "glowstone": [0xE9C27A],
    "blackstone": [0x35292B],
    "basalt": [0x4E4E56],
    "magma_block": [0x8E3B18],
    "soul_sand": [0x55402F],
    "crimson_planks": [0x8B3A56],
    "end_stone": [0xDBDE9E],
    "purpur_block": [0xA37BA3],
    "obsidian": [0x1A1226],
    "chorus_plant": [0x58395B],
    "amethyst_block": [0x8561BF],
}


# ------------------------------------------------------------------ noise ----
def value_noise(seed, radius=160):
    """Deterministic value noise on a lattice, with smooth interpolation."""
    rnd = random.Random(seed)
    lattice = {}
    for x in range(-radius, radius + 1):
        for z in range(-radius, radius + 1):
            lattice[(x, z)] = rnd.random()

    def smooth(t):
        return t * t * (3 - 2 * t)

    def at(x, z, scale):
        fx, fz = x / scale, z / scale
        x0, z0 = math.floor(fx), math.floor(fz)
        tx, tz = smooth(fx - x0), smooth(fz - z0)

        def g(dx, dz):
            return lattice.get((x0 + dx, z0 + dz), 0.5)

        a = g(0, 0) * (1 - tx) + g(1, 0) * tx
        b = g(0, 1) * (1 - tx) + g(1, 1) * tx
        return a * (1 - tz) + b * tz

    def fbm(x, z):
        return at(x, z, 90) * 0.55 + at(x, z, 38) * 0.3 + at(x, z, 14) * 0.15

    return fbm


# ---------------------------------------------------------------- builder ----
class World:
    """Holds the top surface per column plus sparse detail blocks above it."""

    def __init__(self, name, dimension, seed):
        self.name = name
        self.dimension = dimension
        self.seed = seed
        self.surface = {}   # (x, z) -> (block, y)
        self.details = []   # [x, y, z, block]

    def set_surface(self, x, z, block, y):
        self.surface[(x, z)] = (block, int(y))

    def y_at(self, x, z):
        hit = self.surface.get((x, z))
        return hit[1] if hit else None

    def block_at(self, x, z):
        hit = self.surface.get((x, z))
        return hit[0] if hit else None

    def add(self, x, y, z, block):
        if (x, z) in self.surface:
            self.details.append([x, int(y), z, block])

    def to_json(self):
        xs = [p[0] for p in self.surface]
        zs = [p[1] for p in self.surface]
        x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
        w, d = x1 - x0 + 1, z1 - z0 + 1

        blocks, heights = [], []
        for z in range(z0, z1 + 1):
            for x in range(x0, x1 + 1):
                hit = self.surface.get((x, z))
                if hit is None:
                    blocks.append("void")
                    heights.append(0)
                else:
                    blocks.append(hit[0])
                    heights.append(hit[1])

        details = [d for d in self.details if x0 <= d[0] <= x1 and z0 <= d[2] <= z1]
        return {
            "name": self.name,
            "dimension": self.dimension,
            "seed": self.seed,
            "palette": {k: v for k, v in PALETTE.items()},
            "bbox": {"minX": x0, "minZ": z0, "width": w, "depth": d},
            "blocks": blocks,
            "heights": heights,
            "details": details,
        }


# ------------------------------------------------------------- structures ----
def cottage(w, rnd, x, z, sx, sz, wall, roof, chimney=False):
    ground = w.y_at(x, z)
    if ground is None:
        return
    y0 = ground + 1
    x1, z1 = x + sx - 1, z + sz - 1
    door_x = x + sx // 2

    for y in range(y0, y0 + 3):
        for xx in range(x, x1 + 1):
            for zz in range(z, z1 + 1):
                if not (xx in (x, x1) or zz in (z, z1)):
                    continue
                if y == y0 and xx == door_x and zz == z1:
                    continue  # doorway
                block = wall
                windows = y == y0 + 1 and (
                    (xx in (x, x1) and zz in (z + 1, z1 - 1))
                    or (zz in (z, z1) and xx in (x + 1, x1 - 1))
                )
                if windows:
                    block = "glass"
                w.add(xx, y, zz, block)

    # pitched roof: one overhang ring, then a stack of shrinking slabs
    for xx in range(x - 1, x1 + 2):
        for zz in range(z - 1, z1 + 2):
            w.add(xx, y0 + 3, zz, roof)
    for xx in range(x, x1 + 1):
        for zz in range(z, z1 + 1):
            w.add(xx, y0 + 4, zz, roof)
    for xx in range(x + 1, x1):
        for zz in range(z + 1, z1):
            w.add(xx, y0 + 5, zz, roof)

    w.add(x + 1, y0, z + 1, "bookshelf")
    w.add(x1 - 1, y0, z + 1, "glass")
    w.add(door_x, y0 + 1, z + 1, "lantern")
    w.add(door_x, y0 + 2, z + 1, "torch")
    if chimney:
        for i in range(3, 7):
            w.add(x1 - 1, y0 + i, z1 - 1, "bricks")


def tree(w, kind, x, z, height):
    top = w.y_at(x, z)
    if top is None or w.block_at(x, z) in ("water", "ice"):
        return False
    # never overhang the edge of the map
    for dx in range(-2, 3):
        for dz in range(-2, 3):
            if w.y_at(x + dx, z + dz) is None:
                return False
    log, leaf = {
        "oak": ("oak_log", "oak_leaves"),
        "birch": ("birch_log", "birch_leaves"),
        "spruce": ("spruce_log", "spruce_leaves"),
    }[kind]

    for i in range(1, height + 1):
        w.add(x, top + i, z, log)

    if kind == "spruce":
        for i in range(2, height + 2):
            r = 2 if i % 3 else 1
            if i >= height:
                r = 1
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if abs(dx) == r and abs(dz) == r:
                        continue
                    if dx == 0 and dz == 0 and i < height:
                        continue
                    w.add(x + dx, top + i, z + dz, leaf)
    else:
        crown = top + height
        for dy, r in ((0, 2), (1, 2), (2, 1), (3, 0)):
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if abs(dx) == r and abs(dz) == r and r > 1:
                        continue
                    if dx == 0 and dz == 0 and dy < 2:
                        continue
                    w.add(x + dx, crown + dy, z + dz, leaf)
    return True


# ------------------------------------------------------------- overworld ----
def build_overworld():
    w = World("Ember Hollow", "overworld", 1337)
    rnd = random.Random(42)
    fbm = value_noise(1337)
    moisture = value_noise(77)
    R = 132

    # 1. raw height field: rolling hills, a ridge, and a coastal falloff
    h = {}
    for x in range(-R, R + 1):
        for z in range(-R, R + 1):
            d = math.hypot(x, z)
            if d > R:
                continue
            n = fbm(x, z)
            # a mountain range running north-east, plus a long ridge
            ridge = max(0.0, math.sin((x - z * 0.6) / 74.0 + 1.1)) ** 2 * 13
            coast = max(0.0, (d - 96) / 36.0) ** 1.6 * 30
            land = 66 + n * 26 + ridge * (n * 0.6 + 0.5) - coast
            h[(x, z)] = land

    # 2. slope limiter: repeatedly pull any column down to (highest neighbour + 1)
    for _ in range(90):
        changed = False
        for (x, z), v in h.items():
            best = -1e9
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = h.get((x + dx, z + dz))
                if n is not None and n > best:
                    best = n
            if best > -1e8 and v > best + 1:
                h[(x, z)] = best + 1
                changed = True
        if not changed:
            break

    # 3. one light smoothing pass so slopes are not staircases
    smooth = {}
    for (x, z), v in h.items():
        vals = [v]
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = h.get((x + dx, z + dz))
            if n is not None:
                vals.append(n)
        smooth[(x, z)] = sum(vals) / len(vals) * 0.55 + v * 0.45
    for k, v in smooth.items():
        h[k] = round(v)

    # 4. rivers: carve a wandering channel, but only through lowish ground
    river_cells = set()
    for t in range(-220, 221):
        # the river runs roughly north-south with a sine wander
        cx = int(18 * math.sin(t / 34.0) + 6 * math.sin(t / 11.0)) - 34
        for width in range(-1, 2):
            x = cx + width
            if (x, t) not in h:
                continue
            if h[(x, t)] < SEA + 6:
                river_cells.add((x, t))

    # 5. surface blocks + water
    for (x, z), v in h.items():
        d = math.hypot(x, z)
        m = moisture(x, z)
        if v < SEA:
            # anything below sea level is water, and shallow edges are beaches
            w.set_surface(x, z, "ice" if v < SEA - 8 else "water", SEA)
            continue
        top = int(v)
        if (x, z) in river_cells and top <= SEA + 2:
            w.set_surface(x, z, "water", SEA)
            continue
        if top >= SNOW_LINE:
            block = "snow"
        elif top >= ROCK_LINE:
            block = "stone" if m > 0.32 else "gravel"
        elif top <= SEA + 2:
            block = "sand" if d > 60 else "gravel"
        elif m > 0.66 and top > SEA + 6:
            block = "podzol"
        elif m < 0.24:
            block = "coarse_dirt" if m < 0.16 else "grass_block"
        else:
            block = "grass_block"
        w.set_surface(x, z, block, top)

    # 6. gravel paths through the village
    for i in range(-84, 34):
        z = int(52 + 12 * math.sin(i / 17.0))
        for dz in (0, 1):
            if w.block_at(i, z + dz) in ("grass_block", "coarse_dirt", "podzol"):
                w.set_surface(i, z + dz, "gravel", w.y_at(i, z + dz))

    # 7. village
    for i, (hx, hz, sx, sz, chimney) in enumerate([
        (-58, 40, 9, 7, False), (-31, 56, 7, 7, True), (-52, 66, 8, 6, False),
        (-16, 36, 7, 9, False), (-74, 20, 6, 6, True), (8, 60, 10, 8, False),
    ]):
        # flatten a pad under each house
        ground = w.y_at(hx + sx // 2, hz + sz // 2)
        if ground is None:
            continue
        for x in range(hx - 1, hx + sx + 1):
            for z in range(hz - 1, hz + sz + 1):
                if w.block_at(x, z) not in (None, "water"):
                    w.set_surface(x, z, "grass_block", min(ground, w.y_at(x, z)))
        cottage(w, rnd, hx, hz, sx, sz,
                "oak_planks" if i % 2 else "spruce_planks",
                "bricks" if i % 2 else "spruce_planks", chimney)

    # 8. the ember keep: a circular curtain wall on a flattened pad
    kx, kz = 56, -44
    ky = w.y_at(kx, kz)
    for x in range(kx - 18, kx + 19):
        for z in range(kz - 18, kz + 19):
            if (x - kx) ** 2 + (z - kz) ** 2 <= 18 * 18 and w.block_at(x, z) not in (None, "water"):
                w.set_surface(x, z, "stone_bricks" if (x + z) % 7 else "mossy_stone_bricks", ky)
    # wall ring
    for step in range(0, 720):
        ang = step / 720 * 2 * math.pi
        x = kx + int(round(15 * math.cos(ang)))
        z = kz + int(round(15 * math.sin(ang)))
        for y in range(ky + 1, ky + 6):
            w.add(x, y, z, "stone_bricks")
        if step % 24 < 12:
            w.add(x, ky + 6, z, "mossy_stone_bricks")
    # central tower
    for x in range(kx - 4, kx + 5):
        for z in range(kz - 4, kz + 5):
            r = max(abs(x - kx), abs(z - kz))
            if r in (3, 4):
                for y in range(ky + 1, ky + 16):
                    w.add(x, y, z, "glass" if y in (ky + 7, ky + 12) and r == 4 else "stone_bricks")
    for x in range(kx - 1, kx + 2):
        for z in range(kz - 1, kz + 2):
            for y in range(ky + 16, ky + 21):
                w.add(x, y, z, "spruce_planks")
    w.add(kx, ky + 21, kz, "gold_block")
    for a in range(0, 360, 45):
        w.add(kx + int(8 * math.cos(math.radians(a))), ky + 1,
              kz + int(8 * math.sin(math.radians(a))), "lantern")
    # gatehouse on the south side
    for x in range(kx - 2, kx + 3):
        for y in range(ky + 1, ky + 8):
            if abs(x - kx) == 2:
                w.add(x, y, kz + 15, "stone_bricks")
        w.add(x, ky + 8, kz + 15, "stone_bricks")

    # 9. the great oak
    tx, tz = -18, -74
    ty = w.y_at(tx, tz)
    if ty is not None:
        for y in range(ty + 1, ty + 22):
            w.add(tx, y, tz, "oak_log")
        for level, r in ((21, 7), (22, 7), (23, 6), (24, 4), (25, 2)):
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if dx * dx + dz * dz <= r * r and not (dx == 0 and dz == 0 and level < 23):
                        w.add(tx + dx, ty + level, tz + dz, "oak_leaves")

    # 10. a pier reaching into the bay
    for i in range(0, 24):
        z = -10 + i
        for x in (30, 31):
            if w.block_at(x, z) is not None:
                w.set_surface(x, z, "oak_planks", SEA + 1)
        if i % 6 == 0:
            w.add(30, SEA + 2, z, "torch")

    # 11. trees, avoiding buildings and water
    placed = 0
    for _ in range(4000):
        if placed >= 420:
            break
        x, z = rnd.randint(-R + 3, R - 3), rnd.randint(-R + 3, R - 3)
        block = w.block_at(x, z)
        if block not in ("grass_block", "podzol", "snow"):
            continue
        if abs(x - kx) < 22 and abs(z - kz) < 22:
            continue
        if w.y_at(x, z) >= SEA + 26:
            continue
        kind = "spruce" if (w.y_at(x, z) > SEA + 12 or moisture(x, z) > 0.6) else ("birch" if rnd.random() < 0.3 else "oak")
        height = rnd.randint(4, 6) if kind != "spruce" else rnd.randint(6, 9)
        if tree(w, kind, x, z, height):
            placed += 1

    return w, (kx, kz)


# ----------------------------------------------------------------- nether ----
def build_nether():
    w = World("Ember Hollow — Nether", "nether", 1337)
    rnd = random.Random(7)
    fbm = value_noise(99)
    R = 78

    h = {}
    for x in range(-R, R + 1):
        for z in range(-R, R + 1):
            if math.hypot(x, z) > R:
                continue
            h[(x, z)] = 40 + fbm(x * 1.7, z * 1.7) * 26
    for _ in range(60):
        changed = False
        for (x, z), v in h.items():
            best = max([h.get((x + dx, z + dz), -1e9) for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1))])
            if v > best + 2:
                h[(x, z)] = best + 2
                changed = True
        if not changed:
            break

    for (x, z), v in h.items():
        n = fbm(x * 1.7, z * 1.7)
        if n < 0.2:
            w.set_surface(x, z, "lava", 40)
        elif n > 0.78:
            w.set_surface(x, z, "glowstone", int(v) + 1)
        elif n > 0.6:
            w.set_surface(x, z, "basalt", int(v))
        elif n < 0.32:
            w.set_surface(x, z, "soul_sand", int(v))
        else:
            w.set_surface(x, z, "netherrack", int(v))

    # ruined crimson hall
    for x in range(-18, 19):
        for z in range(-7, 8):
            if abs(x) == 18 or abs(z) == 7:
                base = w.y_at(x, z)
                if base is None:
                    continue
                w.set_surface(x, z, "blackstone", base + 1)
                for y in range(base + 2, base + 8):
                    w.add(x, y, z, "crimson_planks" if y % 3 == 0 else "nether_bricks")
    for x in range(-16, 17, 4):
        w.add(x, (w.y_at(x, 0) or 40) + 10, 0, "glowstone")
    for _ in range(30):
        x, z = rnd.randint(-60, 60), rnd.randint(-60, 60)
        y = w.y_at(x, z)
        if y and y > 46 and w.block_at(x, z) == "netherrack":
            for i in range(1, rnd.randint(3, 8)):
                w.add(x, y + i, z, "lava")
    return w


# -------------------------------------------------------------------- end ----
def build_end():
    w = World("Ember Hollow — The End", "end", 1337)
    rnd = random.Random(5)
    R = 96

    for x in range(-R, R + 1):
        for z in range(-R, R + 1):
            d = math.hypot(x, z)
            if 26 < d < 28 and abs(x) + abs(z) > 6:
                w.set_surface(x, z, "obsidian", 62)      # the exit ring
            elif d <= R:
                w.set_surface(x, z, "end_stone", 56 + int(2 * math.sin(x / 11.0) * math.cos(z / 13.0)))

    # central pillar
    for x in range(-3, 4):
        for z in range(-3, 4):
            if x * x + z * z <= 9:
                w.set_surface(x, z, "obsidian", 62)
                for y in range(63, 78):
                    w.add(x, y, z, "obsidian")
    w.add(0, 79, 0, "gold_block")

    # obsidian towers
    for a in range(0, 360, 30):
        tx = int(round(20 * math.cos(math.radians(a))))
        tz = int(round(20 * math.sin(math.radians(a))))
        for y in range(57, 73):
            w.add(tx, y, tz, "obsidian")
        w.add(tx, 73, tz, "amethyst_block")

    # a purpur outpost, and chorus growth
    for x in range(44, 57):
        for z in range(-7, 8):
            if x in (44, 56) or z in (-7, 7):
                base = w.y_at(x, z)
                if base is None:
                    continue
                w.set_surface(x, z, "purpur_block", base + 1)
                for y in range(base + 2, base + 7):
                    w.add(x, y, z, "purpur_block")
    for _ in range(70):
        x, z = rnd.randint(-80, 80), rnd.randint(-80, 80)
        y = w.y_at(x, z)
        if y is None or math.hypot(x, z) < 32:
            continue
        for i in range(1, rnd.randint(2, 5)):
            w.add(x, y + i, z, "chorus_plant")
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            w.add(x + dx, y + 3, z + dz, "chorus_plant")
    return w


def write(world, filename):
    path = os.path.join(OUT_DIR, filename)
    data = world.to_json()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"{filename:24s} {len(data['blocks']):>7} columns {len(data['details']):>6} details {kb:8.1f} KB")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    overworld, keep = build_overworld()
    write(overworld, "demo-overworld.json")
    write(build_nether(), "demo-nether.json")
    write(build_end(), "demo-end.json")
    with open(os.path.join(OUT_DIR, "demo-pois.json"), "w", encoding="utf-8") as f:
        json.dump([
            {"name": "Ember Keep", "x": keep[0], "z": keep[1], "dimension": "overworld",
             "note": "Curtain wall, gatehouse and a tower tall enough to see the whole island from."},
            {"name": "Willow Village", "x": -45, "z": 52, "dimension": "overworld",
             "note": "Six cottages on a gravel path, each with a lantern in the doorway."},
            {"name": "The Great Oak", "x": -18, "z": -74, "dimension": "overworld",
             "note": "21 blocks of trunk. The leaves are the expensive part of this render."},
            {"name": "Bay Pier", "x": 30, "z": 2, "dimension": "overworld",
             "note": "Planks laid into the shallow water, torches every six blocks."},
            {"name": "Ruined Crimson Hall", "x": 0, "z": 0, "dimension": "nether",
             "note": "The nether hub: blackstone floor, glowstone ceiling."},
            {"name": "Obsidian Spire", "x": 0, "z": 0, "dimension": "end",
             "note": "Spawn platform at the centre of the ring."},
        ], f, indent=2)
    print("demo-pois.json written")


if __name__ == "__main__":
    main()
