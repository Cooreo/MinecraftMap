#!/usr/bin/env python3
"""
Minimal SVG -> PNG rasteriser, only for eyeballing the dev harness output.
Handles the subset of SVG the harness emits: absolute M/L/Z paths, rects and
horizontal/vertical shorthand. Not a general SVG renderer.

    python3 tools/dev/rasterise.py in.svg out.png 1200 800
"""
import re
import struct
import sys
import zlib


def parse_colour(c):
    if not c:
        return (128, 128, 128, 1.0)
    c = c.strip()
    if c.startswith("#"):
        h = c[1:]
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        if len(h) >= 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    m = re.match(r"rgba?\(([^)]+)\)", c)
    if m:
        p = [float(v) for v in m.group(1).split(",")]
        return (int(p[0]), int(p[1]), int(p[2]), p[3] if len(p) > 3 else 1.0)
    return (128, 128, 128, 1.0)


def parse_path(d):
    """Return a list of closed polygons (list of (x, y))."""
    polys = []
    cur = []
    x = y = 0.0
    for cmd, args in re.findall(r"([MLHZVmlhzv])([-\d.\s,]*)", d):
        nums = [float(v) for v in re.split(r"[\s,]+", args.strip()) if v] if args.strip() else []
        if cmd == "M":
            if len(cur) >= 3:
                polys.append(cur)
            cur = [(nums[0], nums[1])]
            x, y = nums[0], nums[1]
        elif cmd == "L":
            for i in range(0, len(nums) - 1, 2):
                x, y = nums[i], nums[i + 1]
                cur.append((x, y))
        elif cmd in "Hh":
            for v in nums:
                x = v if cmd == "H" else x + v
                cur.append((x, y))
        elif cmd in "Vv":
            for v in nums:
                y = v if cmd == "V" else y + v
                cur.append((x, y))
        elif cmd in "Zz":
            if len(cur) >= 3:
                polys.append(cur)
            cur = []
    if len(cur) >= 3:
        polys.append(cur)
    return polys


def fill_polygons(buf, W, H, polys, colour, alpha):
    edges = []
    for poly in polys:
        for i in range(len(poly)):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % len(poly)]
            if y1 != y2:
                edges.append((x1, y1, x2, y2))
    if not edges:
        return
    ys = [e[1] for e in edges] + [e[3] for e in edges]
    y0 = max(0, int(min(ys)))
    y1 = min(H, int(max(ys)) + 1)
    r, g, b, _ = colour
    for yy in range(y0, y1):
        yc = yy + 0.5
        xs = []
        for (x1, y1_, x2, y2) in edges:
            if (y1_ <= yc < y2) or (y2 <= yc < y1_):
                xs.append(x1 + (yc - y1_) * (x2 - x1) / (y2 - y1_))
        if len(xs) < 2:
            continue
        xs.sort()
        row = yy * W * 3
        for i in range(0, len(xs) - 1, 2):
            a = max(0, int(xs[i]))
            bb = min(W, int(xs[i + 1]) + 1)
            if alpha >= 0.999:
                buf[row + a * 3: row + bb * 3] = bytes((r, g, b)) * (bb - a)
            else:
                for xx in range(a, bb):
                    o = row + xx * 3
                    for k in range(3):
                        buf[o + k] = int(buf[o + k] * (1 - alpha) + (r, g, b)[k] * alpha)


def write_png(path, W, H, buf):
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw += buf[y * W * 3:(y + 1) * W * 3]

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    W, H = (int(v) for v in (sys.argv[3:5] if len(sys.argv) > 4 else ["1200", "800"]))
    svg = open(src).read()
    body = svg.split(">", 1)[1].rsplit("</svg>", 1)[0]
    buf = bytearray(bytes((13, 16, 21)) * (W * H))

    for m in re.finditer(r"<(rect|path)\b([^>]*)/?>", body):
        tag, attrs = m.group(1), m.group(2)
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs))
        colour = parse_colour(a.get("fill"))
        alpha = float(a.get("fill-opacity", 1) or 1)
        if tag == "rect":
            x, y = float(a.get("x", 0)), float(a.get("y", 0))
            w, h = float(a.get("width", 0)), float(a.get("height", 0))
            polys = [[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]]
        else:
            polys = parse_path(a.get("d", ""))
        fill_polygons(buf, W, H, polys, colour, alpha)

    write_png(dst, W, H, buf)
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
