#!/usr/bin/env python3
"""
Build a library of real strokes from your drawings.

Output: data/generate/stroke_library.json
Each stroke is a normalized polyline taken from skeletonized ink —
the raw material for composing new drawings.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DRAWINGS = ROOT / "drawings"
OUT_DIR = ROOT / "data" / "generate"
OUT_DEFAULT = OUT_DIR / "stroke_library.json"

MAX_SIDE = 1000
MIN_POINTS = 8
MAX_STROKES_PER_IMAGE = 250
SIMPLIFY_EPS = 0.22
SKEL_SIDE = 560
MAX_POINTS = 96  # denser paths = smoother hand curves


def load_drawing(path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """Returns (bgr_or_gray3, gray) resized to MAX_SIDE."""
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    h, w = bgr.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        bgr = cv2.resize(
            bgr,
            (int(w * scale), int(h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return bgr, gray


def ink_mask_from_gray(gray: np.ndarray) -> np.ndarray:
    if float(np.mean(gray)) < 127:
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    else:
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        bw = cv2.adaptiveThreshold(
            blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            35,
            8,
        )
    bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return (bw > 0).astype(np.uint8)


def ink_mask(path: Path) -> np.ndarray | None:
    loaded = load_drawing(path)
    if loaded is None:
        return None
    _, gray = loaded
    return ink_mask_from_gray(gray)


def morphological_skeleton(binary: np.ndarray) -> np.ndarray:
    img = (binary * 255).astype(np.uint8)
    skel = np.zeros_like(img)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while True:
        opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
        temp = cv2.subtract(img, opened)
        eroded = cv2.erode(img, element)
        skel = cv2.bitwise_or(skel, temp)
        img = eroded
        if cv2.countNonZero(img) == 0:
            break
    return (skel > 0).astype(np.uint8)


def neighbors8(y: int, x: int, skel: np.ndarray) -> list[tuple[int, int]]:
    h, w = skel.shape
    out: list[tuple[int, int]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and skel[ny, nx]:
                out.append((ny, nx))
    return out


def trace_polylines(skel: np.ndarray) -> list[list[tuple[float, float]]]:
    ys, xs = np.where(skel > 0)
    if len(xs) == 0:
        return []
    remaining = {(int(y), int(x)) for y, x in zip(ys, xs)}
    degree = {p: len(neighbors8(p[0], p[1], skel)) for p in remaining}

    def walk(start: tuple[int, int]) -> list[tuple[float, float]]:
        path = [start]
        remaining.discard(start)
        prev = None
        cur = start
        while True:
            nbrs = [
                n
                for n in neighbors8(cur[0], cur[1], skel)
                if n in remaining and n != prev
            ]
            if not nbrs:
                break
            nxt = nbrs[0]
            remaining.discard(nxt)
            path.append(nxt)
            prev, cur = cur, nxt
            if degree.get(cur, 0) != 2 and len(path) > 1:
                if degree.get(cur, 0) > 2:
                    remaining.add(cur)
                break
        return [(float(x), float(y)) for y, x in path]

    polylines: list[list[tuple[float, float]]] = []
    endpoints = [p for p, d in degree.items() if d == 1 and p in remaining]
    for start in endpoints + list(remaining):
        if start not in remaining:
            continue
        pl = walk(start)
        if len(pl) >= MIN_POINTS:
            polylines.append(pl)
    while remaining:
        start = next(iter(remaining))
        pl = walk(start)
        if len(pl) >= MIN_POINTS:
            polylines.append(pl)
        else:
            remaining.discard(start)
    return polylines


def simplify(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    arr = np.array(points, dtype=np.float32).reshape(-1, 1, 2)
    approx = cv2.approxPolyDP(arr, eps, False)
    return [(float(p[0][0]), float(p[0][1])) for p in approx]


def resample_polyline(
    points: list[tuple[float, float]], max_points: int = MAX_POINTS
) -> list[tuple[float, float]]:
    """Keep hand shape: light simplify, then densify/subsample to a stable length."""
    if len(points) < 3:
        return points
    simple = simplify(points, SIMPLIFY_EPS)
    if len(simple) < 3:
        simple = points
    # densify short strokes so the model sees real motion, not 4-point sticks
    target = min(max_points, max(16, len(simple) * 3))
    if len(simple) == target:
        return simple
    # arc-length resample
    pts = np.array(simple, dtype=np.float64)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    u = np.concatenate([[0.0], np.cumsum(seg)])
    if u[-1] < 1e-6:
        return simple
    u /= u[-1]
    grid = np.linspace(0.0, 1.0, target)
    xs = np.interp(grid, u, pts[:, 0])
    ys = np.interp(grid, u, pts[:, 1])
    return list(zip(xs.tolist(), ys.tolist()))


def normalize_stroke(
    points: list[tuple[float, float]],
    widths_px: list[float] | None = None,
    color_rgb: tuple[int, int, int] | None = None,
    page_wh: tuple[int, int] | None = None,
) -> dict | None:
    if len(points) < 3:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    w = max(max_x - min_x, 1.0)
    h = max(max_y - min_y, 1.0)
    scale = max(w, h)
    cx = (min_x + max_x) * 0.5
    cy = (min_y + max_y) * 0.5
    norm = [((x - cx) / scale, (y - cy) / scale) for x, y in points]
    length = 0.0
    for i in range(1, len(norm)):
        length += math.hypot(norm[i][0] - norm[i - 1][0], norm[i][1] - norm[i - 1][1])

    if widths_px and len(widths_px) == len(points):
        mean_w = float(np.median(widths_px))
        step = max(1, len(widths_px) // 24)
        rel_widths = [round(float(widths_px[i]) / scale, 4) for i in range(0, len(widths_px), step)]
    else:
        mean_w = scale * 0.04
        rel_widths = [0.04]

    color = color_rgb or (40, 40, 38)
    out = {
        "points": [[round(x, 4), round(y, 4)] for x, y in norm],
        "length": round(length, 4),
        "aspect": round(w / h, 4),
        "width_rel": round(mean_w / scale, 4),
        "widths": rel_widths[:32],
        "color": [int(color[0]), int(color[1]), int(color[2])],
        "local_scale": round(scale, 2),
    }
    if page_wh:
        pw, ph = page_wh
        pmin = max(min(pw, ph), 1)
        out["page_x"] = round(cx / max(pw, 1), 4)
        out["page_y"] = round(cy / max(ph, 1), 4)
        out["page_s"] = round(scale / pmin, 4)
        # Absolute page coords so a passage can replay a real region of your drawing
        out["page_points"] = [
            [round(x / max(pw, 1), 5), round(y / max(ph, 1), 5)] for x, y in points
        ]
        path_len = 0.0
        for i in range(1, len(points)):
            path_len += math.hypot(
                (points[i][0] - points[i - 1][0]) / pmin,
                (points[i][1] - points[i - 1][1]) / pmin,
            )
        out["page_len"] = round(path_len, 4)
    return out


def sample_along_path(
    points: list[tuple[float, float]],
    bgr: np.ndarray,
    dist: np.ndarray,
    mask: np.ndarray,
) -> tuple[list[float], tuple[int, int, int]]:
    """Ink radius + average color from the real drawing along the skeleton."""
    h, w = mask.shape
    widths: list[float] = []
    colors: list[np.ndarray] = []
    for x, y in points:
        ix = int(round(x))
        iy = int(round(y))
        if not (0 <= ix < w and 0 <= iy < h):
            widths.append(2.0)
            continue
        radius = float(dist[iy, ix])
        widths.append(max(1.5, radius * 2.2))
        y0, y1 = max(0, iy - 2), min(h, iy + 3)
        x0, x1 = max(0, ix - 2), min(w, ix + 3)
        patch = bgr[y0:y1, x0:x1]
        m = mask[y0:y1, x0:x1]
        if m.any():
            pix = patch[m > 0].astype(np.float32)
            lum = 0.114 * pix[:, 0] + 0.587 * pix[:, 1] + 0.299 * pix[:, 2]
            sat = pix.max(axis=1) - pix.min(axis=1)
            score = (255 - lum) + 1.4 * sat
            keep = score >= np.percentile(score, 55)
            if keep.any():
                pix = pix[keep]
            colors.append(pix.mean(axis=0))
    if colors:
        mean = np.mean(colors, axis=0)
        color = (int(mean[2]), int(mean[1]), int(mean[0]))
    else:
        color = (45, 45, 42)
    if 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] > 170:
        color = (
            int(color[0] * 0.45 + 30),
            int(color[1] * 0.45 + 28),
            int(color[2] * 0.45 + 26),
        )
    return widths, color


def skeleton_polylines(mask: np.ndarray) -> list[list[tuple[float, float]]]:
    """Medial ink paths — the hand’s route through the mark, not the outline."""
    h, w = mask.shape
    scale = min(1.0, SKEL_SIDE / max(h, w))
    if scale < 1.0:
        small = cv2.resize(
            mask,
            (max(1, int(w * scale)), max(1, int(h * scale))),
            interpolation=cv2.INTER_NEAREST,
        )
    else:
        small = mask
        scale = 1.0
    k = np.ones((2, 2), np.uint8)
    small = cv2.morphologyEx((small * 255).astype(np.uint8), cv2.MORPH_CLOSE, k)
    skel = morphological_skeleton((small > 0).astype(np.uint8))
    polys = trace_polylines(skel)
    if scale == 1.0:
        return polys
    inv = 1.0 / scale
    return [[(x * inv, y * inv) for x, y in pl] for pl in polys]


def merge_nearby_polylines(
    polylines: list[list[tuple[float, float]]],
    join_dist: float = 10.0,
) -> list[list[tuple[float, float]]]:
    """Stitch skeleton shards whose ends nearly touch into longer gestures."""
    if len(polylines) < 2:
        return polylines
    polys = [list(p) for p in polylines if len(p) >= 3]
    changed = True
    while changed and len(polys) > 1:
        changed = False
        best = None  # (dist, i, j, mode)
        for i in range(len(polys)):
            for j in range(i + 1, len(polys)):
                a, b = polys[i], polys[j]
                ends = [
                    (math.hypot(a[-1][0] - b[0][0], a[-1][1] - b[0][1]), "ab"),
                    (math.hypot(a[-1][0] - b[-1][0], a[-1][1] - b[-1][1]), "aBr"),
                    (math.hypot(a[0][0] - b[-1][0], a[0][1] - b[-1][1]), "ba"),
                    (math.hypot(a[0][0] - b[0][0], a[0][1] - b[0][1]), "aRb"),
                ]
                dist, mode = min(ends, key=lambda t: t[0])
                if dist <= join_dist and (best is None or dist < best[0]):
                    best = (dist, i, j, mode)
        if best is None:
            break
        _, i, j, mode = best
        a, b = polys[i], polys[j]
        if mode == "ab":
            merged = a + b
        elif mode == "aBr":
            merged = a + list(reversed(b))
        elif mode == "ba":
            merged = b + a
        else:
            merged = list(reversed(a)) + b
        polys[i] = merged
        polys.pop(j)
        changed = True
    return polys


def region_fill_color(
    bgr: np.ndarray, mask: np.ndarray, contour: np.ndarray
) -> tuple[int, int, int]:
    """Dominant ink color inside a contour."""
    h, w = mask.shape
    m = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(m, [contour], -1, 1, thickness=-1)
    m = m & mask
    pix = bgr[m > 0]
    if len(pix) < 8:
        # fall back to full contour interior (includes wash not only ink mask)
        m2 = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(m2, [contour], -1, 1, thickness=-1)
        pix = bgr[m2 > 0]
    if len(pix) == 0:
        return (40, 38, 36)
    pix_f = pix.astype(np.float32)
    # Drop near-paper white fringe
    lum = 0.114 * pix_f[:, 0] + 0.587 * pix_f[:, 1] + 0.299 * pix_f[:, 2]
    pix_f = pix_f[lum < 235]
    if len(pix_f) < 4:
        return (40, 38, 36)
    sat = pix_f.max(axis=1) - pix_f.min(axis=1)
    # If chromatic wash exists, prefer it over charcoal lines
    if float(np.percentile(sat, 70)) > 28:
        chroma = pix_f[sat >= np.percentile(sat, 55)]
        if len(chroma):
            mean = chroma.mean(axis=0)
            return (int(mean[2]), int(mean[1]), int(mean[0]))
    mean = pix_f.mean(axis=0)
    return (int(mean[2]), int(mean[1]), int(mean[0]))


def extract_regions(bgr: np.ndarray, mask: np.ndarray, page_wh: tuple[int, int]) -> list[dict]:
    """Filled colored shapes — skip line-web blobs that read as black soup."""
    pw, ph = page_wh
    page_area = float(pw * ph)
    bw = (mask * 255).astype(np.uint8)
    # light close only — heavy close turns every page into one black blob
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    regions: list[dict] = []
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:50]:
        area = float(cv2.contourArea(cnt))
        if area < page_area * 0.006:
            continue
        if area > page_area * 0.88:
            continue  # whole-page scan frame
        hull = cv2.convexHull(cnt)
        hull_area = float(cv2.contourArea(hull)) or 1.0
        solidity = area / hull_area
        color = region_fill_color(bgr, mask, cnt)
        sat = max(color) - min(color)
        # Line drawings → low solidity black webs. Keep only body-like / colored forms.
        if sat < 22 and solidity < 0.42:
            continue
        if sat < 18 and area > page_area * 0.35:
            continue

        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, max(0.6, peri * 0.0018), True)
        if len(approx) < 8:
            approx = cnt
        pts = [(float(p[0][0]), float(p[0][1])) for p in approx]
        if len(pts) > 120:
            idx = np.linspace(0, len(pts) - 1, 120)
            pts = [pts[int(round(i))] for i in idx]
        stroke = normalize_stroke(pts, None, color, page_wh=page_wh)
        if not stroke:
            continue
        stroke["kind"] = "fill"
        stroke["closed"] = 1.0
        stroke["fill"] = True
        stroke["area_rel"] = round(area / page_area, 4)
        stroke["solidity"] = round(solidity, 4)
        stroke["width_rel"] = max(float(stroke.get("width_rel") or 0.04), 0.03)
        regions.append(stroke)
    return regions


def crop_to_ink(
    bgr: np.ndarray,
    gray: np.ndarray,
    pad_frac: float = 0.12,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Tight crop around ink so a small doodle isn't lost on a huge white page."""
    mask = ink_mask_from_gray(gray)
    ys, xs = np.where(mask > 0)
    if len(xs) < 40:
        return None
    h, w = gray.shape
    ink_w = int(xs.max() - xs.min())
    ink_h = int(ys.max() - ys.min())
    pad = max(8, int(pad_frac * max(ink_w, ink_h, 1)))
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(h, int(ys.max()) + pad + 1)
    if x1 - x0 < 12 or y1 - y0 < 12:
        return None
    return bgr[y0:y1, x0:x1], gray[y0:y1, x0:x1]


def ink_contour_polylines(
    mask: np.ndarray,
) -> list[tuple[list[tuple[float, float]], bool]]:
    """Drawn outlines (and holes) — better for symbols than a broken skeleton."""
    h, w = mask.shape
    pmin = float(min(h, w))
    cnts, _ = cv2.findContours(
        (mask * 255).astype(np.uint8),
        cv2.RETR_CCOMP,
        cv2.CHAIN_APPROX_NONE,
    )
    out: list[tuple[list[tuple[float, float]], bool]] = []
    for cnt in cnts:
        peri = float(cv2.arcLength(cnt, True))
        if peri < pmin * 0.10:
            continue
        approx = cv2.approxPolyDP(cnt, max(1.0, peri * 0.0032), True)
        if len(approx) < 5:
            approx = cnt
        pts = [(float(p[0][0]), float(p[0][1])) for p in approx]
        if len(pts) > 180:
            idx = np.linspace(0, len(pts) - 1, 180)
            pts = [pts[int(round(i))] for i in idx]
        if len(pts) < 5:
            continue
        out.append((pts, True))
    out.sort(key=lambda t: -len(t[0]))
    return out[:10]


def extract_from_bgr(
    bgr: np.ndarray,
    gray: np.ndarray,
    *,
    source: str = "",
    min_page_len: float = 0.05,
    max_strokes: int = MAX_STROKES_PER_IMAGE,
) -> list[dict]:
    page_wh = (bgr.shape[1], bgr.shape[0])
    pmin = float(min(page_wh))
    mask = ink_mask_from_gray(gray)
    if mask.sum() < 80:
        return []

    dist = cv2.distanceTransform((mask * 255).astype(np.uint8), cv2.DIST_L2, 5)
    regions = extract_regions(bgr, mask, page_wh)
    for r in regions:
        r["source"] = source

    try:
        polylines = skeleton_polylines(mask)
    except Exception:
        polylines = []
    polylines = merge_nearby_polylines(polylines, join_dist=max(8.0, pmin * 0.012))
    polylines.sort(key=len, reverse=True)

    strokes: list[dict] = list(regions)
    for pl in polylines[:max_strokes]:
        simple = resample_polyline(pl)
        if len(simple) < 3:
            continue
        widths, color = sample_along_path(simple, bgr, dist, mask)
        stroke = normalize_stroke(simple, widths, color, page_wh=page_wh)
        if not stroke:
            continue
        if float(stroke.get("page_len") or 0) < min_page_len and float(
            stroke.get("page_s") or 0
        ) < min_page_len * 0.8:
            continue
        if stroke["length"] > 0.12:
            stroke["kind"] = "stroke"
            stroke["fill"] = False
            stroke["source"] = source
            strokes.append(stroke)
    return strokes


def extract_from_image(path: Path) -> list[dict]:
    loaded = load_drawing(path)
    if loaded is None:
        return []
    bgr, gray = loaded
    return extract_from_bgr(bgr, gray, source=path.name)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--drawings", type=Path, default=DRAWINGS)
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--limit", type=int, default=0, help="0 = all drawings")
    ap.add_argument(
        "--prefer",
        nargs="*",
        default=[],
    )
    args = ap.parse_args()

    exts = {".png", ".jpg", ".jpeg", ".webp"}
    all_paths = sorted(
        p for p in args.drawings.iterdir() if p.is_file() and p.suffix.lower() in exts
    )
    prefer = {n.lower() for n in args.prefer}
    ordered = (
        [p for p in all_paths if p.name.lower() in prefer]
        + [p for p in all_paths if p.name.lower() not in prefer]
    )
    paths = ordered if args.limit <= 0 else ordered[: args.limit]

    library: list[dict] = []
    sources: list[str] = []
    for path in paths:
        print(f"extract {path.name}…")
        strokes = extract_from_image(path)
        print(f"  → {len(strokes)} strokes")
        if strokes:
            sources.append(path.name)
            library.extend(strokes)

    if not library:
        raise SystemExit("No strokes found")

    # Cap total library size for the composer
    library.sort(key=lambda s: s["length"], reverse=True)
    library = library[:8000]

    payload = {
        "version": 3,
        "kind": "stroke_library",
        "sources": sources,
        "stroke_count": len(library),
        "strokes": library,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {args.out} ({len(library)} strokes from {len(sources)} drawings)")


if __name__ == "__main__":
    main()
