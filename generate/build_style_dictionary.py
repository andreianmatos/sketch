#!/usr/bin/env python3
"""
Build a style dictionary from drawings/:

  palette  — your ink colors
  strokes  — line gestures (thin, elongated)
  forms    — compact / closed shapes
  rhythm   — how you tend to move (length, turn, scale)

This is the vocabulary the paper canvas should follow.
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
STROKE_LIB = ROOT / "data" / "generate" / "stroke_library.json"
OUT = ROOT / "data" / "generate" / "style_dictionary.json"

MAX_SIDE = 900
N_COLORS = 8
MAX_STROKES = 800
MAX_FORMS = 400


def kmeans_rgb(pix: np.ndarray, k: int, iters: int = 12) -> tuple[np.ndarray, np.ndarray]:
    """Tiny k-means so we don't need sklearn."""
    rng = np.random.default_rng(0)
    # init from random pixels
    idx = rng.choice(len(pix), size=k, replace=False)
    centers = pix[idx].astype(np.float64)
    labels = np.zeros(len(pix), dtype=np.int32)
    for _ in range(iters):
        # assign
        d = ((pix[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        labels = d.argmin(axis=1)
        for i in range(k):
            members = pix[labels == i]
            if len(members):
                centers[i] = members.mean(axis=0)
    return centers, labels


def load_ink_pixels(path: Path, max_pix: int = 8000) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        return np.zeros((0, 3), dtype=np.float32)
    h, w = bgr.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1:
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if float(np.mean(gray)) < 127:
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        mask = bw > 0
    else:
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        bw = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 8
        )
        mask = bw > 0
    pix = bgr[mask]  # BGR
    if len(pix) == 0:
        return np.zeros((0, 3), dtype=np.float32)
    # drop near-paper
    lum = 0.114 * pix[:, 0] + 0.587 * pix[:, 1] + 0.299 * pix[:, 2]
    pix = pix[lum < 210]
    if len(pix) > max_pix:
        idx = np.random.choice(len(pix), max_pix, replace=False)
        pix = pix[idx]
    # BGR → RGB
    return pix[:, ::-1].astype(np.float32)


def build_palette(paths: list[Path]) -> list[dict]:
    chunks = []
    for p in paths:
        pix = load_ink_pixels(p)
        if len(pix):
            chunks.append(pix)
    if not chunks:
        return [{"rgb": [40, 38, 36], "weight": 1.0}]
    all_pix = np.vstack(chunks)
    k = min(N_COLORS, max(2, len(all_pix) // 500))
    centers, labels = kmeans_rgb(all_pix, k)
    palette = []
    # Keep vivid ink — don't drop saturated pinks/reds as "too light"
    for i, c in enumerate(centers):
        w = float((labels == i).mean())
        rgb = [int(np.clip(v, 0, 255)) for v in c]
        lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
        sat = max(rgb) - min(rgb)
        if lum > 225 and sat < 25:
            continue
        palette.append({"rgb": rgb, "weight": round(w, 4)})
    palette.sort(key=lambda x: -x["weight"])
    if not palette:
        palette = [{"rgb": [40, 38, 36], "weight": 1.0}]
    # Ensure at least one chromatic accent survives
    if all(max(p["rgb"]) - min(p["rgb"]) < 30 for p in palette):
        palette.append({"rgb": [220, 70, 90], "weight": 0.08})
    # renormalize
    s = sum(p["weight"] for p in palette) or 1.0
    for p in palette:
        p["weight"] = round(p["weight"] / s, 4)
    return palette


def nearest_palette(rgb: list[int], palette: list[dict]) -> int:
    best_i, best_d = 0, 1e18
    for i, p in enumerate(palette):
        d = sum((a - b) ** 2 for a, b in zip(rgb, p["rgb"]))
        if d < best_d:
            best_d, best_i = d, i
    return best_i


def path_stats(points: list[list[float]]) -> dict:
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 2:
        return {"length": 0, "turn": 0, "closed": 0, "compact": 0}
    seg = np.diff(pts, axis=0)
    lengths = np.linalg.norm(seg, axis=1)
    length = float(lengths.sum())
    turns = []
    for i in range(1, len(seg)):
        a, b = seg[i - 1], seg[i]
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na < 1e-8 or nb < 1e-8:
            continue
        cos = float(np.clip(np.dot(a, b) / (na * nb), -1, 1))
        turns.append(abs(math.acos(cos)))
    turn = float(np.mean(turns)) if turns else 0.0
    closed = float(np.linalg.norm(pts[0] - pts[-1]) < 0.15)
    # compactness: area proxy / perimeter
    xs, ys = pts[:, 0], pts[:, 1]
    # shoelace on open path still useful
    area = abs(float(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1)))) * 0.5
    compact = float(area / (length + 1e-6))
    return {
        "length": round(length, 4),
        "turn": round(turn, 4),
        "closed": closed,
        "compact": round(compact, 4),
    }


def classify(entry: dict, stats: dict) -> str:
    """form vs stroke from shape of the gesture."""
    if entry.get("fill") or entry.get("kind") == "fill":
        return "form"
    wr = float(entry.get("width_rel") or 0.05)
    aspect = float(entry.get("aspect") or 1.0)
    form_score = (
        (1.0 if wr > 0.16 else 0.0)
        + (1.2 if stats["closed"] > 0.5 else 0.0)
        + (1.0 if stats["compact"] > 0.04 else 0.0)
        + (0.6 if 0.55 < aspect < 1.8 else 0.0)
        - (0.8 if aspect > 3.5 else 0.0)
        - (0.5 if wr < 0.09 else 0.0)
    )
    return "form" if form_score >= 1.4 else "stroke"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--drawings", type=Path, default=DRAWINGS)
    args = ap.parse_args()

    if not STROKE_LIB.exists():
        raise SystemExit(f"Missing {STROKE_LIB}\nRun: npm run vectorize first")

    exts = {".png", ".jpg", ".jpeg", ".webp"}
    paths = sorted(
        p for p in args.drawings.iterdir() if p.is_file() and p.suffix.lower() in exts
    )
    print(f"palette from {len(paths)} drawings…")
    palette = build_palette(paths)
    print(f"  {len(palette)} colors")

    lib = json.loads(STROKE_LIB.read_text(encoding="utf-8"))
    strokes_out: list[dict] = []
    forms_out: list[dict] = []
    lengths, turns = [], []

    for s in lib.get("strokes") or []:
        pts = s.get("points") or []
        if len(pts) < 3:
            continue
        st = path_stats(pts)
        kind = classify(s, st)
        color = s.get("color") or [40, 40, 38]
        unit = {
            "points": pts,
            "page_points": s.get("page_points") or [],
            "width_rel": float(s.get("width_rel") or 0.05),
            "widths": s.get("widths") or [float(s.get("width_rel") or 0.05)],
            "color": [int(c) for c in color],
            "color_idx": nearest_palette(color, palette),
            "source": s.get("source"),
            "length": st["length"],
            "turn": st["turn"],
            "closed": st["closed"] or (1.0 if s.get("fill") else 0.0),
            "compact": st["compact"],
            "aspect": float(s.get("aspect") or 1.0),
            "page_x": float(s.get("page_x") or 0.5),
            "page_y": float(s.get("page_y") or 0.5),
            "page_s": float(s.get("page_s") or 0.05),
            "page_len": float(s.get("page_len") or st["length"]),
            "fill": bool(s.get("fill")),
            "area_rel": float(s.get("area_rel") or 0.0),
        }
        lengths.append(st["length"])
        turns.append(st["turn"])
        if kind == "form":
            forms_out.append(unit)
        else:
            strokes_out.append(unit)

    strokes_out.sort(key=lambda u: -u["length"])
    forms_out.sort(
        key=lambda u: -(
            u.get("area_rel", 0) * 3
            + u["compact"]
            + u["closed"]
            + u["width_rel"]
            + (2.0 if u.get("fill") else 0.0)
        )
    )
    strokes_out = strokes_out[:MAX_STROKES]
    forms_out = forms_out[:MAX_FORMS]

    rhythm = {
        "stroke_length_p50": float(np.median(lengths)) if lengths else 0.5,
        "stroke_length_p90": float(np.percentile(lengths, 90)) if lengths else 1.0,
        "turn_p50": float(np.median(turns)) if turns else 0.3,
        "form_ratio": round(len(forms_out) / max(len(forms_out) + len(strokes_out), 1), 3),
        "stroke_ratio": round(len(strokes_out) / max(len(forms_out) + len(strokes_out), 1), 3),
    }

    payload = {
        "version": 1,
        "kind": "style_dictionary",
        "sources": [p.name for p in paths],
        "palette": palette,
        "rhythm": rhythm,
        "forms": forms_out,
        "strokes": strokes_out,
        "counts": {"forms": len(forms_out), "strokes": len(strokes_out), "colors": len(palette)},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload), encoding="utf-8")
    print(
        f"Wrote {OUT}\n"
        f"  forms={len(forms_out)} strokes={len(strokes_out)} "
        f"form_ratio={rhythm['form_ratio']}"
    )
    print("  palette:", [p["rgb"] for p in palette[:6]])


if __name__ == "__main__":
    main()
