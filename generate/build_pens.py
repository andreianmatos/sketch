#!/usr/bin/env python3
"""
Study your drawings and build a library of *pens* —

A pen is a whole look, not a hex color: pressure envelope, grain,
dryness, bleed, covering power — how the mark sits in paper.

    drawings/  →  stroke_library  →  data/generate/pens.json

    make strokes
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
STROKE_LIB = ROOT / "data" / "generate" / "stroke_library.json"
ICONS_DIR = ROOT / "data" / "generate" / "icons"
OUT = ROOT / "data" / "generate" / "pens.json"

N_PENS = 8
MIN_SAMPLES = 40


def _features(stroke: dict) -> np.ndarray | None:
    """[mean_w, taper, wobble, lum, sat, length] in a comparable range."""
    wr = float(stroke.get("width_rel") or 0)
    widths = stroke.get("widths") or [wr or 0.05]
    w = np.asarray(widths, dtype=np.float64)
    if len(w) < 1:
        return None
    mean_w = float(np.median(w)) if len(w) else wr
    if mean_w <= 0:
        mean_w = 0.04
    # taper: start vs end (pen pressure / brush lift)
    head = float(np.mean(w[: max(1, len(w) // 4)]))
    tail = float(np.mean(w[-(max(1, len(w) // 4)) :]))
    taper = (tail - head) / (mean_w + 1e-6)
    # wobble: how much width varies along the stroke
    wobble = float(np.std(w) / (mean_w + 1e-6)) if len(w) > 2 else 0.0

    color = stroke.get("color") or [40, 38, 36]
    r, g, b = [float(c) for c in color[:3]]
    lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    sat = (max(r, g, b) - min(r, g, b)) / 255.0
    length = float(stroke.get("page_len") or stroke.get("length") or 0.5)
    length = min(2.5, max(0.05, length))

    return np.array(
        [
            math.log(mean_w + 1e-4),
            np.clip(taper, -1.5, 1.5),
            min(1.5, wobble),
            lum,
            sat,
            math.log(length + 1e-3),
        ],
        dtype=np.float64,
    )


def _kmeans(X: np.ndarray, k: int, iters: int = 24, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    # init: farthest-first among random subset
    n = len(X)
    k = min(k, n)
    idx0 = int(rng.integers(0, n))
    centers = [X[idx0]]
    for _ in range(1, k):
        d = np.min(((X[:, None, :] - np.asarray(centers)[None, :, :]) ** 2).sum(axis=2), axis=1)
        # sample proportional to distance^2
        p = d / (d.sum() + 1e-12)
        centers.append(X[int(rng.choice(n, p=p))])
    centers = np.asarray(centers, dtype=np.float64)
    labels = np.zeros(n, dtype=np.int32)
    for _ in range(iters):
        d = ((X[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        labels = d.argmin(axis=1)
        for i in range(k):
            members = X[labels == i]
            if len(members):
                centers[i] = members.mean(axis=0)
    return centers, labels


def _look(
    mean_w: float,
    wobble: float,
    lum: float,
    sat: float,
) -> dict:
    """Material of the mark — how ink/graphite meets paper."""
    if sat > 0.18:
        kind = "accent"
    elif lum > 0.52:
        kind = "wash"
    elif lum > 0.28:
        kind = "graphite"
    elif mean_w >= 0.09:
        kind = "charcoal"
    else:
        kind = "ink"

    if kind == "wash":
        opacity = float(np.clip(0.40 + (0.55 - lum) * 0.45, 0.30, 0.58))
    elif kind == "graphite":
        opacity = float(np.clip(0.58 + (0.40 - lum) * 0.35, 0.48, 0.74))
    elif kind == "charcoal":
        opacity = float(np.clip(0.74 + (0.22 - lum) * 0.5, 0.64, 0.92))
    elif kind == "accent":
        opacity = float(np.clip(0.70 - lum * 0.15, 0.55, 0.84))
    else:
        opacity = float(np.clip(0.86 - lum * 0.45, 0.62, 0.93))

    grain = float(
        np.clip(
            0.12
            + wobble * 0.85
            + (0.30 if kind == "charcoal" else 0.0)
            + (0.14 if kind == "graphite" else 0.0)
            - (0.06 if kind == "ink" else 0.0)
            - (0.10 if kind == "wash" else 0.0),
            0.06,
            0.95,
        )
    )
    dry = float(
        np.clip(
            wobble * 0.32
            + (0.50 if kind == "charcoal" else 0.0)
            + (0.24 if kind == "graphite" else 0.0)
            - (0.30 if kind == "wash" else 0.0)
            - (0.14 if kind == "accent" else 0.0)
            - (0.08 if kind == "ink" else 0.0),
            0.03,
            0.84,
        )
    )
    bleed = float(
        np.clip(
            (0.50 if kind == "wash" else 0.05)
            + (0.22 if kind == "accent" else 0.0)
            + (0.10 if kind == "ink" else 0.0)
            - (0.08 if kind == "charcoal" else 0.0),
            0.02,
            0.64,
        )
    )
    return {
        "kind": kind,
        "opacity": round(opacity, 3),
        "grain": round(grain, 3),
        "dry": round(dry, 3),
        "bleed": round(bleed, 3),
    }


def _name_pen(mean_w: float, taper: float, lum: float, sat: float) -> str:
    if sat > 0.18:
        ink = "accent"
    elif lum < 0.22:
        ink = "charcoal"
    elif lum < 0.45:
        ink = "graphite"
    else:
        ink = "wash"
    if mean_w < 0.045:
        body = "fine"
    elif mean_w < 0.09:
        body = "medium"
    else:
        body = "broad"
    tip = ""
    if taper < -0.25:
        tip = "-taper"
    elif taper > 0.25:
        tip = "-swell"
    return f"{ink}-{body}{tip}"


def _envelope_from_cluster(widths_list: list[list[float]], n: int = 24) -> list[float]:
    """Average width profile resampled to n samples, normalized so median≈1."""
    curves = []
    for w in widths_list:
        arr = np.asarray(w, dtype=np.float64)
        if len(arr) < 2:
            continue
        x = np.linspace(0, 1, len(arr))
        xi = np.linspace(0, 1, n)
        curves.append(np.interp(xi, x, arr))
    if not curves:
        return [1.0] * n
    m = np.mean(np.stack(curves, axis=0), axis=0)
    med = float(np.median(m)) or 1.0
    return [round(float(v / med), 4) for v in m]


def collect_strokes() -> list[dict]:
    strokes: list[dict] = []
    if STROKE_LIB.exists():
        lib = json.loads(STROKE_LIB.read_text(encoding="utf-8"))
        for s in lib.get("strokes") or []:
            if s.get("fill"):
                continue
            strokes.append(s)
    if ICONS_DIR.exists():
        for path in sorted(ICONS_DIR.glob("*.json")):
            lib = json.loads(path.read_text(encoding="utf-8"))
            for sk in lib.get("sketches") or []:
                for s in sk.get("strokes") or []:
                    if s.get("fill"):
                        continue
                    strokes.append(s)
    return strokes


def build_pens(n_pens: int = N_PENS) -> dict:
    raw = collect_strokes()
    feats: list[np.ndarray] = []
    keep: list[dict] = []
    for s in raw:
        f = _features(s)
        if f is None:
            continue
        feats.append(f)
        keep.append(s)
    if len(keep) < MIN_SAMPLES:
        raise SystemExit(
            f"Need more strokes to build pens (got {len(keep)}). "
            "Run: make strokes  (vectorize first)"
        )

    X = np.stack(feats, axis=0)
    # standardize
    mu = X.mean(axis=0)
    sd = X.std(axis=0) + 1e-6
    Z = (X - mu) / sd
    k = min(n_pens, max(3, len(keep) // 80))
    _, labels = _kmeans(Z, k)

    pens: list[dict] = []
    for i in range(k):
        members = [keep[j] for j in range(len(keep)) if labels[j] == i]
        if len(members) < 5:
            continue
        widths_all = []
        colors = []
        mean_ws = []
        tapers = []
        wobbles = []
        for s in members:
            wr = float(s.get("width_rel") or 0.05)
            wlist = s.get("widths") or [wr]
            widths_all.append([float(x) for x in wlist])
            mean_ws.append(float(np.median(wlist)))
            warr = np.asarray(wlist, dtype=np.float64)
            head = float(np.mean(warr[: max(1, len(warr) // 4)]))
            tail = float(np.mean(warr[-(max(1, len(warr) // 4)) :]))
            tapers.append((tail - head) / (mean_ws[-1] + 1e-6))
            wobbles.append(float(np.std(warr) / (mean_ws[-1] + 1e-6)) if len(warr) > 2 else 0.0)
            colors.append([float(c) for c in (s.get("color") or [40, 38, 36])[:3]])

        mean_w = float(np.median(mean_ws))
        taper = float(np.median(tapers))
        wobble = float(np.median(wobbles))
        col = np.median(np.asarray(colors), axis=0)
        rgb = [int(np.clip(v, 0, 255)) for v in col]
        lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0
        sat = (max(rgb) - min(rgb)) / 255.0
        look = _look(mean_w, wobble, lum, sat)
        weight = len(members) / len(keep)
        pens.append(
            {
                "id": f"pen_{len(pens)}",
                "name": _name_pen(mean_w, taper, lum, sat),
                "weight": round(weight, 4),
                "width_rel": round(mean_w, 4),
                "taper": round(taper, 4),
                "wobble": round(min(1.2, wobble), 4),
                "color": rgb,
                "envelope": _envelope_from_cluster(widths_all),
                "samples": len(members),
                **look,
            }
        )

    pens.sort(key=lambda p: -p["weight"])
    # renormalize weights
    s = sum(p["weight"] for p in pens) or 1.0
    for p in pens:
        p["weight"] = round(p["weight"] / s, 4)

    return {
        "version": 2,
        "kind": "pens",
        "source_strokes": len(keep),
        "pens": pens,
        "counts": {"pens": len(pens)},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=N_PENS, help="Target number of pens")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    payload = build_pens(n_pens=args.n)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {args.out} ({payload['counts']['pens']} pens from {payload['source_strokes']} strokes)")
    for p in payload["pens"]:
        print(
            f"  {p['name']:18s}  {p['kind']:9s}  "
            f"grain={p['grain']:.2f} dry={p['dry']:.2f} bleed={p['bleed']:.2f}  "
            f"rgb={p['color']}  weight={p['weight']:.2f}"
        )


if __name__ == "__main__":
    main()
