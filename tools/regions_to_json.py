#!/usr/bin/env python3
"""
regions_to_json.py — turn a Minecraft Java save into the JSON tilty renders.

Reads .mca (Anvil) region files, finds the top solid block of every column, and
writes a single JSON file with a palette, a block-name grid and a height grid.

No Java, no mods, no server. Pure Python 3.8+ with the standard library only.

    # a single dimension, surface only
    python3 tools/regions_to_json.py ~/.minecraft/saves/MyWorld -o world.json

    # Nether (DIM-1) or End (DIM1), and only part of the map
    python3 tools/regions_to_json.py ~/.minecraft/saves/MyWorld -o nether.json --dimension nether

    # also carry trees/structures above the surface (bigger file, slower)
    python3 tools/regions_to_json.py ~/.minecraft/saves/MyWorld -o world.json --details

    # sanity check the parser without a world handy
    python3 tools/regions_to_json.py --selftest

Then point the site at it: copy the file into site/assets/ and edit
site/assets/config.json to reference it (see the README).

Formats supported: chunk format 1.13 through 1.21 (block_states/palette), and the
older 1.8–1.12 layout (Level/Sections/Blocks) as a fallback.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import struct
import sys
import zlib

# --------------------------------------------------------------------------
# NBT reader
# --------------------------------------------------------------------------

TAG_END = 0
TAG_BYTE = 1
TAG_SHORT = 2
TAG_INT = 3
TAG_LONG = 4
TAG_FLOAT = 5
TAG_DOUBLE = 6
TAG_BYTE_ARRAY = 7
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10
TAG_INT_ARRAY = 11
TAG_LONG_ARRAY = 12


class NBTError(Exception):
    pass


class Reader:
    """Little cursor over a bytes buffer."""

    __slots__ = ("buf", "pos")

    def __init__(self, buf, pos=0):
        self.buf = buf
        self.pos = pos

    def take(self, n):
        if self.pos + n > len(self.buf):
            raise NBTError("unexpected end of NBT data")
        out = self.buf[self.pos:self.pos + n]
        self.pos += n
        return out

    def u1(self):
        v = self.buf[self.pos]
        self.pos += 1
        return v

    def i1(self):
        v = struct.unpack_from(">b", self.buf, self.pos)[0]
        self.pos += 1
        return v

    def i2(self):
        v = struct.unpack_from(">h", self.buf, self.pos)[0]
        self.pos += 2
        return v

    def u2(self):
        v = struct.unpack_from(">H", self.buf, self.pos)[0]
        self.pos += 2
        return v

    def i4(self):
        v = struct.unpack_from(">i", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def string(self):
        n = self.u2()
        return self.take(n).decode("utf-8", "replace")


def read_payload(r, tag):
    if tag == TAG_BYTE:
        return r.i1()
    if tag == TAG_SHORT:
        return r.i2()
    if tag == TAG_INT:
        return r.i4()
    if tag == TAG_LONG:
        v = struct.unpack_from(">q", r.buf, r.pos)[0]
        r.pos += 8
        return v
    if tag == TAG_FLOAT:
        v = struct.unpack_from(">f", r.buf, r.pos)[0]
        r.pos += 4
        return v
    if tag == TAG_DOUBLE:
        v = struct.unpack_from(">d", r.buf, r.pos)[0]
        r.pos += 8
        return v
    if tag == TAG_BYTE_ARRAY:
        n = r.i4()
        return r.take(n)
    if tag == TAG_STRING:
        return r.string()
    if tag == TAG_LIST:
        item = r.u1()
        n = r.i4()
        if n <= 0:
            return []
        # fast paths for the two list types that dominate chunk data
        if item == TAG_COMPOUND:
            return [read_payload(r, TAG_COMPOUND) for _ in range(n)]
        if item == TAG_LONG:
            raw = r.take(8 * n)
            return list(struct.unpack(">%dq" % n, raw))
        return [read_payload(r, item) for _ in range(n)]
    if tag == TAG_COMPOUND:
        out = {}
        while True:
            t = r.u1()
            if t == TAG_END:
                return out
            name = r.string()
            out[name] = read_payload(r, t)
    if tag == TAG_INT_ARRAY:
        n = r.i4()
        raw = r.take(4 * n)
        return list(struct.unpack(">%di" % n, raw))
    if tag == TAG_LONG_ARRAY:
        n = r.i4()
        raw = r.take(8 * n)
        return struct.unpack(">%dq" % n, raw)
    raise NBTError("unknown NBT tag %d" % tag)


def read_nbt(buf):
    r = Reader(buf)
    t = r.u1()
    if t != TAG_COMPOUND:
        raise NBTError("root tag is not a compound")
    r.string()
    return read_payload(r, TAG_COMPOUND)


# --------------------------------------------------------------------------
# Region files
# --------------------------------------------------------------------------

def iter_chunks(path):
    """Yield (chunk_x, chunk_z, nbt dict) for every present chunk in a region."""
    with open(path, "rb") as f:
        header = f.read(4096)
        if len(header) < 4096:
            return
        for i in range(1024):
            offset = (header[i * 4] << 16) | (header[i * 4 + 1] << 8) | header[i * 4 + 2]
            sectors = header[i * 4 + 3]
            if offset == 0 or sectors == 0:
                continue
            f.seek(offset * 4096)
            frame = f.read(5)
            if len(frame) < 5:
                continue
            length, kind = struct.unpack(">IB", frame)
            if length <= 1:
                continue
            payload = f.read(length - 1)
            try:
                if kind == 1:
                    data = gzip.decompress(payload)
                elif kind == 2:
                    data = zlib.decompress(payload)
                elif kind == 3:
                    data = payload
                else:
                    continue  # LZ4 / external: rare, skip rather than crash
                nbt = read_nbt(data)
            except Exception:
                continue
            yield i % 32, i // 32, nbt


# --------------------------------------------------------------------------
# Block decoding
# --------------------------------------------------------------------------

AIR = {"air", "cave_air", "void_air", "minecraft:air", "minecraft:cave_air", "minecraft:void_air"}
SKIP_SURFACE = AIR | {
    # plants, torches and thin snow sit *on* a block: the interesting surface is
    # underneath them, and drawing them as terrain colour would look wrong.
    "short_grass", "grass", "tall_grass", "fern", "large_fern", "dead_bush",
    "dandelion", "poppy", "torch", "wall_torch", "oak_sapling", "snow",
    "vine", "lily_pad", "sugar_cane", "wheat", "nether_sprouts", "crimson_roots",
}


def short_name(name):
    return name[len("minecraft:"):] if name.startswith("minecraft:") else name


def decode_palette_section(section):
    """Return (palette list of names, accessor(x,y,z) -> index) for a 1.13+ section."""
    states = section.get("block_states")
    if states is None:
        return None
    palette = [short_name(e.get("Name", "minecraft:air")) for e in states.get("palette", [])]
    if not palette:
        palette = ["air"]
    data = states.get("data")
    if not data or len(palette) == 1:
        return palette, None  # single-value palette
    bits = max(4, (len(palette) - 1).bit_length())

    def accessor(x, y, z):
        idx = y * 256 + z * 16 + x
        per_long = 64 // bits
        long_index = idx // per_long
        offset = (idx % per_long) * bits
        if long_index >= len(data):
            return 0
        value = (data[long_index] >> offset) & ((1 << bits) - 1)
        return value if value < len(palette) else 0

    return palette, accessor


def decode_legacy_section(section):
    """1.8–1.12: Blocks (byte array of ids) + Data (nibbles)."""
    blocks = section.get("Blocks")
    if not blocks or len(blocks) < 4096:
        return None
    data = section.get("Data") or b""
    add = section.get("Add") or b""

    def accessor(x, y, z):
        idx = y * 256 + z * 16 + x
        value = blocks[idx] & 0xFF
        if add and idx // 2 < len(add) and (idx % 2):
            value += (add[idx // 2] & 0xF0) << 8
        elif add and idx // 2 < len(add):
            value += (add[idx // 2] & 0x0F) << 8
        return value

    return ("legacy-ids", accessor, data)


LEGACY_IDS = {
    1: "stone", 2: "grass_block", 3: "dirt", 4: "cobblestone", 5: "oak_planks",
    7: "bedrock", 8: "water", 9: "water", 12: "sand", 13: "gravel", 14: "gold_ore",
    15: "iron_ore", 16: "coal_ore", 17: "oak_log", 18: "oak_leaves", 20: "glass",
    24: "sandstone", 35: "white_wool", 45: "bricks", 49: "obsidian", 50: "torch",
    54: "chest", 67: "cobblestone_stairs", 78: "snow", 79: "ice", 80: "snow_block",
    82: "clay", 87: "netherrack", 89: "glowstone", 98: "stone_bricks", 121: "end_stone",
}

# --------------------------------------------------------------------------
# Surface extraction
# --------------------------------------------------------------------------

def chunk_surface(nbt):
    """Return a dict {(x, z): (block_name, y)} in chunk-local coords."""
    out = {}

    # 1.13+ puts sections under the root; 1.8–1.12 nests them under Level.
    level = nbt.get("Level", nbt)
    sections = level.get("sections") or level.get("Sections") or []

    decoded = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        sy = section.get("Y")
        if sy is None:
            sy = section.get("y")
        if sy is None:
            continue
        if sy < -8 or sy > 24:
            continue
        modern = decode_palette_section(section)
        if modern:
            palette, accessor = modern
            decoded.append((sy, palette, accessor, None))
            continue
        legacy = decode_legacy_section(section)
        if legacy:
            decoded.append((sy, legacy[0], legacy[1], legacy[2]))

    if not decoded:
        return out

    decoded.sort(key=lambda d: d[0], reverse=True)

    for x in range(16):
        for z in range(16):
            found = None
            for sy, palette, accessor, _ in decoded:
                base = sy * 16
                top = 15
                while top >= 0:
                    if palette == "legacy-ids":
                        name = LEGACY_IDS.get(accessor(x, top, z), "stone")
                    elif accessor is None:
                        name = palette[0]
                    else:
                        idx = accessor(x, top, z)
                        name = palette[idx] if idx < len(palette) else "air"
                    if name not in SKIP_SURFACE:
                        found = (name, base + top)
                        break
                    top -= 1
                if found:
                    break
            if found:
                out[(x, z)] = found
    return out


def section_details(nbt):
    """Every non-air block above the surface, up to a sane cap. Used by --details."""
    level = nbt.get("Level", nbt)
    sections = level.get("sections") or level.get("Sections") or []
    out = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        sy = section.get("Y", section.get("y"))
        if sy is None:
            continue
        modern = decode_palette_section(section)
        if not modern:
            continue
        palette, accessor = modern
        for y in range(16):
            for z in range(16):
                for x in range(16):
                    if accessor is None:
                        name = palette[0]
                    else:
                        idx = accessor(x, y, z)
                        name = palette[idx] if idx < len(palette) else "air"
                    if name in AIR:
                        continue
                    out.append((x, sy * 16 + y, z, name))
    return out


# --------------------------------------------------------------------------
# Colour palette for output
# --------------------------------------------------------------------------

# Top-face colour per block family. Anything not listed falls back to a
# deterministic hash colour, which is ugly but never wrong-looking-grey.
BLOCK_COLOURS = {
    "grass_block": 0x7CBD6B, "dirt": 0x8B6B4A, "coarse_dirt": 0x7A5C3E,
    "podzol": 0x6B4A28, "rooted_dirt": 0x91674A, "mycelium": 0x6F6265,
    "farmland": 0x6B4A2B, "dirt_path": 0x9A7F4B, "mud": 0x3C3A3E, "muddy_mangrove_roots": 0x4A4238,
    "stone": 0x7E7E7E, "cobblestone": 0x7A7A7A, "gravel": 0x857E7A,
    "andesite": 0x8A8A8A, "diorite": 0xC4C4C4, "granite": 0x9A6B5B, "tuff": 0x6C6E68,
    "deepslate": 0x505055, "cobbled_deepslate": 0x4E4E52, "bedrock": 0x565656,
    "sand": 0xDBD3A0, "sandstone": 0xD9CE9B, "red_sand": 0xB45E2C, "red_sandstone": 0xB4602F,
    "terracotta": 0x985E43, "clay": 0xA0A6B0, "snow": 0xF2FAFA, "snow_block": 0xF2FAFA,
    "powder_snow": 0xF4FAFB, "ice": 0x9CC7E8, "packed_ice": 0x8DB5DB, "blue_ice": 0x74A6E0,
    "water": 0x3F76E4, "lava": 0xD4551A, "magma_block": 0x8E3B18,
    "oak_leaves": 0x4C7A34, "birch_leaves": 0x6FA044, "spruce_leaves": 0x2E5A34,
    "jungle_leaves": 0x3E7A28, "acacia_leaves": 0x5E8B34, "dark_oak_leaves": 0x3C6B26,
    "mangrove_leaves": 0x4C7A34, "cherry_leaves": 0xE8A9C4, "azalea_leaves": 0x5C7B36,
    "oak_log": 0x6B5333, "birch_log": 0xD7CFC2, "spruce_log": 0x3B2B1A,
    "jungle_log": 0x5B4426, "acacia_log": 0x676157, "dark_oak_log": 0x3E2D1A,
    "cherry_log": 0x7A4A50, "oak_planks": 0xB08B57, "spruce_planks": 0x7A5B37,
    "birch_planks": 0xC7B27D, "jungle_planks": 0xA97A57, "acacia_planks": 0xB4633B,
    "dark_oak_planks": 0x4B3418, "cherry_planks": 0xD9A0A8, "crimson_planks": 0x8B3A56,
    "warped_planks": 0x2E8C86, "bamboo_planks": 0xC2A94E,
    "stone_bricks": 0x7B7B7B, "mossy_stone_bricks": 0x6C7A62, "bricks": 0x96604F,
    "mossy_cobblestone": 0x6C7A5C, "prismarine": 0x63A08E, "dark_prismarine": 0x335B4B,
    "sea_lantern": 0xC5E3DE, "glowstone": 0xE9C27A, "shroomlight": 0xE8A05C,
    "netherrack": 0x6B3434, "nether_bricks": 0x3B1E22, "red_nether_bricks": 0x4E1A1A,
    "blackstone": 0x35292B, "basalt": 0x4E4E56, "soul_sand": 0x55402F, "soul_soil": 0x4A3B31,
    "crimson_nylium": 0x8B2C2C, "warped_nylium": 0x2C7A6B, "end_stone": 0xDBDE9E,
    "purpur_block": 0xA37BA3, "obsidian": 0x1A1226, "crying_obsidian": 0x2A1A4A,
    "chorus_plant": 0x58395B, "amethyst_block": 0x8561BF, "glass": 0xC8E4F0,
    "white_wool": 0xE9ECEC, "red_wool": 0xA12722, "gold_block": 0xF6D33C,
    "iron_block": 0xD8D8D8, "copper_block": 0xC06B4E, "emerald_block": 0x2DBE5C,
    "diamond_block": 0x62E5DA, "netherite_block": 0x443A3B, "lantern": 0xF7C55A,
    "torch": 0xFFD37A, "bookshelf": 0x9A7B4F, "crafting_table": 0xA0774B,
    "hay_block": 0xB79B31, "pumpkin": 0xC07615, "melon": 0x6C9B33,
}
COLOURED_FAMILIES = ["wool", "concrete", "terracotta", "stained_glass", "carpet"]


def colour_for(name):
    if name in BLOCK_COLOURS:
        return BLOCK_COLOURS[name]
    for family in COLOURED_FAMILIES:
        if name.endswith(family):
            for key, value in BLOCK_COLOURS.items():
                if name.startswith(key.replace("_block", "").replace("white_", "")):
                    return value
    # deterministic hash -> muted colour, so unknown blocks are at least stable
    h = 0
    for ch in name:
        h = (h * 31 + ord(ch)) & 0xFFFFFF
    r = 70 + (h & 0x3F)
    g = 70 + ((h >> 8) & 0x3F)
    b = 70 + ((h >> 16) & 0x3F)
    return (r << 16) | (g << 8) | b


# --------------------------------------------------------------------------
# Region discovery + conversion
# --------------------------------------------------------------------------

DIMENSIONS = {
    "overworld": ["region"],
    "nether": ["DIM-1/region"],
    "end": ["DIM1/region"],
}


def find_region_dirs(save, dimension):
    """Handle vanilla, Bukkit/Paper and modded folder layouts."""
    candidates = []
    if dimension == "overworld":
        candidates += [
            os.path.join(save, "region"),
            os.path.join(save, "world", "region"),
            os.path.join(save, "DIM0", "region"),
        ]
    elif dimension == "nether":
        candidates += [
            os.path.join(save, "DIM-1", "region"),
            os.path.join(save, "world_nether", "DIM-1", "region"),
            os.path.join(save, "world", "DIM-1", "region"),
        ]
    else:
        candidates += [
            os.path.join(save, "DIM1", "region"),
            os.path.join(save, "world_the_end", "DIM1", "region"),
            os.path.join(save, "world", "DIM1", "region"),
        ]
    return [c for c in candidates if os.path.isdir(c)]


def convert(save, dimension, with_details, limit_regions, min_x, max_x, min_z, max_z, verbose):
    dirs = find_region_dirs(save, dimension)
    if not dirs:
        raise SystemExit(
            "no region folder found under %s for dimension %r.\n"
            "Point me at the save folder that contains 'region/' (or 'world/region/')." % (save, dimension)
        )

    surface = {}
    details = []
    region_files = 0
    chunk_count = 0

    files = []
    for d in dirs:
        for name in sorted(os.listdir(d)):
            if name.endswith(".mca"):
                files.append((d, name))
    if limit_regions:
        files = files[:limit_regions]

    for d, name in files:
        rx, rz = 0, 0
        try:
            rx, rz = [int(p) for p in name[:-4].split(".")]
        except ValueError:
            pass
        if min_x is not None and rx < min_x:
            continue
        if max_x is not None and rx > max_x:
            continue
        if min_z is not None and rz < min_z:
            continue
        if max_z is not None and rz > max_z:
            continue
        region_files += 1
        path = os.path.join(d, name)
        for cx, cz, nbt in iter_chunks(path):
            chunk_count += 1
            ox = (rx * 32 + cx) * 16
            oz = (rz * 32 + cz) * 16
            for (lx, lz), (block, y) in chunk_surface(nbt).items():
                surface[(ox + lx, oz + lz)] = (block, y)
            if with_details:
                for lx, y, lz, block in section_details(nbt):
                    details.append((ox + lx, y, oz + lz, block))
        if verbose:
            sys.stderr.write("\r%s: %d regions, %d chunks, %d columns"
                             % (name, region_files, chunk_count, len(surface)))
            sys.stderr.flush()

    if not surface:
        raise SystemExit("read %d region files but found no surface blocks." % region_files)

    if verbose:
        sys.stderr.write("\n")

    xs = [p[0] for p in surface]
    zs = [p[1] for p in surface]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    w, d = x1 - x0 + 1, z1 - z0 + 1

    names = []
    index = {}
    blocks = []
    heights = []
    ground = {}
    for z in range(z0, z1 + 1):
        for x in range(x0, x1 + 1):
            hit = surface.get((x, z))
            if hit is None:
                blocks.append("void")
                heights.append(0)
                continue
            block, y = hit
            if block not in index:
                index[block] = len(names)
                names.append(block)
            blocks.append(block)
            heights.append(y)
            ground[(x, z)] = y

    palette = {}
    for name in names:
        colour = colour_for(name)
        palette[name] = [colour]

    # details need a height reference: only keep blocks above their own column
    out_details = []
    if with_details:
        for x, y, z, block in details:
            g = ground.get((x, z))
            if g is None:
                continue
            if y <= g + 1 or y > g + 80:
                continue  # at or below the surface, or absurdly high
            if block not in index:
                index[block] = len(names)
                names.append(block)
                palette[block] = [colour_for(block)]
            out_details.append([x, y, z, block])

    return {
        "name": os.path.basename(os.path.normpath(save)) + ("" if dimension == "overworld" else " — " + dimension),
        "dimension": dimension,
        "palette": palette,
        "bbox": {"minX": x0, "minZ": z0, "width": w, "depth": d},
        "blocks": blocks,
        "heights": heights,
        "details": out_details,
        "stats": {"regions": region_files, "chunks": chunk_count, "columns": len(surface)},
    }, region_files, chunk_count


# --------------------------------------------------------------------------
# Self test: build a tiny 1.21-style region file, read it back
# --------------------------------------------------------------------------

def _nbt_str(s):
    b = s.encode()
    return struct.pack(">H", len(b)) + b


def _nbt_int(v):
    return struct.pack(">i", v)


def _nbt_long(v):
    v &= (1 << 64) - 1
    if v >= 1 << 63:
        v -= 1 << 64
    return struct.pack(">q", v)


def _tag(t, name, payload):
    return struct.pack(">B", t) + _nbt_str(name) + payload


def _compound_payload(items):
    """Named compound payload. Used for map entries and list elements alike."""
    return b"".join(items) + b"\x00"


def _compound(name, items):
    return _tag(TAG_COMPOUND, name, _compound_payload(items))


def _list(name, item_type, payloads):
    """List elements carry no name field, unlike named tags."""
    return _tag(TAG_LIST, name, struct.pack(">Bi", item_type, len(payloads)) + b"".join(payloads))


def build_test_region():
    """One chunk, 1.21 layout: a 3-block-thick slab of stone with grass on top."""
    palette = ["minecraft:stone", "minecraft:grass_block", "minecraft:air"]
    # 3 palette entries -> 4 bits per index (the format minimum), 16 per long
    values = []
    for y in range(16):
        for z in range(16):
            for x in range(16):
                if y < 5:
                    idx = 0
                elif y == 5:
                    idx = 1
                else:
                    idx = 2
                values.append(idx)
    longs = []
    for i in range(0, len(values), 16):
        chunk = values[i:i + 16]
        acc = 0
        for j, v in enumerate(chunk):
            acc |= (v & 0xF) << (4 * j)
        longs.append(acc)

    pal = _list("palette", TAG_COMPOUND, [
        _compound_payload([_tag(TAG_STRING, "Name", _nbt_str(n))]) for n in palette
    ])
    block_states = _compound("block_states", [
        pal,
        _tag(TAG_LONG_ARRAY, "data", _nbt_int(len(longs)) + b"".join(_nbt_long(v) for v in longs)),
    ])
    section = _compound_payload([_tag(TAG_BYTE, "Y", struct.pack(">b", 0)), block_states])
    root = _compound("", [
        _tag(TAG_INT, "DataVersion", _nbt_int(3953)),
        _tag(TAG_INT, "xPos", _nbt_int(0)),
        _tag(TAG_INT, "zPos", _nbt_int(0)),
        _list("sections", TAG_COMPOUND, [section]),
    ])
    payload = zlib.compress(root, 6)
    frame = struct.pack(">IB", len(payload) + 1, 2) + payload

    header = bytearray(8192)
    header[0:3] = (2).to_bytes(3, "big")  # chunk 0 starts at sector 2
    header[3] = 1 + (len(frame) + 4095) // 4096
    return bytes(header) + frame + b"\x00" * 4096


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        region_dir = os.path.join(tmp, "region")
        os.makedirs(region_dir)
        with open(os.path.join(region_dir, "r.0.0.mca"), "wb") as f:
            f.write(build_test_region())

        data, regions, chunks = convert(tmp, "overworld", False, None, None, None, None, None, verbose=False)
        assert regions == 1, regions
        assert chunks == 1, chunks
        assert len(data["blocks"]) == 256, len(data["blocks"])
        assert len(data["heights"]) == 256
        assert set(data["blocks"]) == {"grass_block"}, set(data["blocks"])
        assert set(data["heights"]) == {5}, set(data["heights"])
        assert data["bbox"]["width"] == 16 and data["bbox"]["depth"] == 16
        json.dumps(data)  # must be serialisable
        print("selftest ok: 1 region, 1 chunk, 256 columns of grass_block at y=5")
        print("palette:", data["palette"])


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="Convert Minecraft .mca regions into tilty JSON.")
    ap.add_argument("save", nargs="?", help="path to the world save folder")
    ap.add_argument("-o", "--output", help="output .json path")
    ap.add_argument("--dimension", default="overworld", choices=sorted(DIMENSIONS))
    ap.add_argument("--details", action="store_true", help="also export blocks above the surface (trees, builds)")
    ap.add_argument("--limit-regions", type=int, default=None, help="only read the first N region files")
    ap.add_argument("--area", nargs=4, type=int, metavar=("MINX", "MAXX", "MINZ", "MAXZ"),
                    help="restrict to a rectangle of region coordinates, e.g. --area -4 4 -4 4")
    ap.add_argument("--pretty", action="store_true", help="indent the JSON (much bigger)")
    ap.add_argument("-q", "--quiet", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="run the built-in parser test and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0

    if not args.save or not args.output:
        ap.error("save and -o/--output are required (or use --selftest)")

    area = args.area or (None, None, None, None)
    data, regions, chunks = convert(
        args.save, args.dimension, args.details, args.limit_regions,
        area[0], area[1], area[2], area[3], verbose=not args.quiet,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        if args.pretty:
            json.dump(data, f, indent=1)
        else:
            json.dump(data, f, separators=(",", ":"))

    size = os.path.getsize(args.output) / 1024
    print("%s: %d regions, %d chunks, %d columns, %d details -> %.1f KB"
          % (args.output, regions, chunks, data["stats"]["columns"], len(data["details"]), size))
    gz = len(zlib.compress(json.dumps(data, separators=(",", ":")).encode()))
    print("gzips to %.0f KB on the wire" % (gz / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
