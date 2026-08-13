#!/usr/bin/env python3
"""
Extract labeled icon libraries from drawings/<label>/ folders.

Example:
  drawings/flower/*.jpg  →  data/generate/icons/flower.json

Each image becomes one (or more) stroke sequences for training
a symbol-specific SketchRNN.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from generate.extract_strokes import (
    crop_to_ink,
    extract_from_bgr,
    ink_contour_polylines,
    ink_mask_from_gray,
    load_drawing,
    normalize_stroke,
    resample_polyline,
    sample_along_path,
)

ROOT = Path(__file__).resolve().parents[1]
DRAWINGS = ROOT / "drawings"
ICONS_OUT = ROOT / "data" / "generate" / "icons"
EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def list_icon_labels(drawings: Path) -> list[str]:
    return sorted(
        p.name
        for p in drawings.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    )


def sketch_from_image(path: Path, label: str) -> dict | None:
    loaded = load_drawing(path)
    if loaded is None:
        return None
    cropped = crop_to_ink(*loaded)
    bgr, gray = cropped if cropped else loaded
    page_wh = (bgr.shape[1], bgr.shape[0])
    mask = ink_mask_from_gray(gray)
    if int(mask.sum()) < 80:
        return None
    dist = cv2.distanceTransform((mask * 255).astype(np.uint8), cv2.DIST_L2, 5)

    strokes: list[dict] = []
    # Prefer the actual drawn outlines so a flower stays a flower
    for pts, closed in ink_contour_polylines(mask):
        simple = resample_polyline(pts, max_points=140)
        if len(simple) < 5:
            continue
        widths, color = sample_along_path(simple, bgr, dist, mask)
        stroke = normalize_stroke(simple, widths, color, page_wh=page_wh)
        if not stroke:
            continue
        stroke["kind"] = "form"
        stroke["fill"] = False
        stroke["closed"] = True
        stroke["source"] = path.name
        strokes.append(stroke)

    # If outlines were too sparse, fall back to skeleton of the cropped doodle
    if len(strokes) < 1:
        strokes = extract_from_bgr(
            bgr, gray, source=path.name, min_page_len=0.02, max_strokes=20
        )
        strokes = [s for s in strokes if not s.get("fill")]

    if not strokes:
        return None
    strokes = sorted(
        strokes,
        key=lambda s: float(s.get("page_len") or s.get("length") or 0),
        reverse=True,
    )[:8]
    return {
        "label": label,
        "source": path.name,
        "strokes": strokes,
        "n_strokes": len(strokes),
    }


def flatten_sketch_points(strokes: list[dict]) -> list[list[float]]:
    """Concatenate stroke polylines (unit points) for one training sequence."""
    # Use page_points when possible so relative layout of the flower is kept
    chunks: list[np.ndarray] = []
    for s in strokes:
        pp = s.get("page_points") or s.get("points") or []
        if len(pp) < 3:
            continue
        pts = np.asarray(pp, dtype=np.float64)
        chunks.append(pts)
    if not chunks:
        return []
    # Normalize whole sketch to unit box centered at 0
    all_pts = np.vstack(chunks)
    c = all_pts.mean(axis=0)
    all_pts = all_pts - c
    scale = max(float(np.ptp(all_pts[:, 0])), float(np.ptp(all_pts[:, 1])), 1e-6)
    out: list[list[float]] = []
    offset = 0
    for pts in chunks:
        local = (pts - c) / scale
        if out:
            # small bridge with pen implied by gap — just append
            pass
        for x, y in local:
            out.append([float(x), float(y)])
        offset += len(local)
    return out


def extract_label(label: str, drawings: Path, out_dir: Path) -> Path:
    folder = drawings / label
    if not folder.is_dir():
        raise SystemExit(f"Missing icon folder: {folder}")
    paths = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXTS
    )
    if not paths:
        raise SystemExit(f"No images in {folder}")

    sketches: list[dict] = []
    sequences: list[dict] = []
    for path in paths:
        print(f"  {label}/{path.name}…")
        sk = sketch_from_image(path, label)
        if not sk:
            print("    (no strokes)")
            continue
        sketches.append(sk)
        flat = flatten_sketch_points(sk["strokes"])
        if len(flat) >= 8:
            sequences.append(
                {
                    "label": label,
                    "source": path.name,
                    "points": flat,
                    "kind": "sketch",
                }
            )
        # also keep top individual strokes as extra examples
        for s in sk["strokes"][:4]:
            pts = s.get("points") or []
            if len(pts) >= 8:
                sequences.append(
                    {
                        "label": label,
                        "source": path.name,
                        "points": pts,
                        "kind": "stroke",
                    }
                )
        print(f"    → {sk['n_strokes']} strokes")

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{label}.json"
    payload = {
        "version": 1,
        "kind": "icon_library",
        "label": label,
        "image_count": len(sketches),
        "sequence_count": len(sequences),
        "sketches": sketches,
        "sequences": sequences,
    }
    out.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {out} ({len(sketches)} images, {len(sequences)} sequences)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--drawings", type=Path, default=DRAWINGS)
    ap.add_argument("--out", type=Path, default=ICONS_OUT)
    ap.add_argument(
        "--label",
        default="",
        help="Icon folder name under drawings/ (default: all subfolders)",
    )
    args = ap.parse_args()

    labels = [args.label] if args.label else list_icon_labels(args.drawings)
    if not labels:
        raise SystemExit(
            f"No icon folders in {args.drawings}\n"
            "Put repeats in drawings/<label>/ e.g. drawings/flower/"
        )
    print(f"icons: {', '.join(labels)}")
    for label in labels:
        extract_label(label, args.drawings, args.out)


if __name__ == "__main__":
    main()
