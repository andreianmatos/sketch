#!/usr/bin/env python3
"""
Compose passages from the style dictionary.

A passage = several marks from the SAME drawing, kept in their real
relative layout — so the page looks like your hand, not random lines.
"""

from __future__ import annotations

import json
import math
import random
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DICT_PATH = ROOT / "data" / "generate" / "style_dictionary.json"
PENS_PATH = ROOT / "data" / "generate" / "pens.json"


@lru_cache(maxsize=1)
def load_dictionary() -> dict:
    if not DICT_PATH.exists():
        raise SystemExit(
            f"Missing {DICT_PATH}\nRun: make scribbles   (or npm run prepare)"
        )
    return json.loads(DICT_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_pens() -> list[dict]:
    if not PENS_PATH.exists():
        return []
    data = json.loads(PENS_PATH.read_text(encoding="utf-8"))
    return list(data.get("pens") or [])


def pick_pen(rng: random.Random, pens: list[dict] | None = None) -> dict | None:
    pens = pens if pens is not None else load_pens()
    if not pens:
        return None
    weights = [max(0.01, float(p.get("weight") or 0.01)) for p in pens]
    return rng.choices(pens, weights=weights, k=1)[0]


def pen_look(pen: dict | None) -> dict:
    """The whole mark: grain, dryness, bleed, covering power — not just RGB."""
    if not pen:
        return {
            "kind": "ink",
            "opacity": 0.78,
            "grain": 0.28,
            "dry": 0.16,
            "bleed": 0.08,
        }
    return {
        "kind": str(pen.get("kind") or "ink"),
        "opacity": float(pen.get("opacity") or 0.78),
        "grain": float(pen.get("grain") or 0.28),
        "dry": float(pen.get("dry") or 0.16),
        "bleed": float(pen.get("bleed") or 0.08),
    }


def look_from_rgb(color: list[int], width_rel: float = 0.05) -> dict:
    r, g, b = (int(color[0]), int(color[1]), int(color[2]))
    lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    sat = (max(r, g, b) - min(r, g, b)) / 255.0
    if sat > 0.16:
        kind = "accent"
    elif lum > 0.52:
        kind = "wash"
    elif lum > 0.28:
        kind = "graphite"
    elif width_rel >= 0.09:
        kind = "charcoal"
    else:
        kind = "ink"
    opacity = {
        "wash": float(np.clip(0.40 + (0.55 - lum) * 0.45, 0.30, 0.58)),
        "graphite": float(np.clip(0.58 + (0.40 - lum) * 0.35, 0.48, 0.74)),
        "charcoal": float(np.clip(0.74 + (0.22 - lum) * 0.5, 0.64, 0.92)),
        "accent": float(np.clip(0.70 - lum * 0.15, 0.55, 0.84)),
        "ink": float(np.clip(0.86 - lum * 0.45, 0.62, 0.93)),
    }[kind]
    grain = float(
        np.clip(
            0.16
            + (0.30 if kind == "charcoal" else 0.0)
            + (0.14 if kind == "graphite" else 0.0)
            + sat * 0.15,
            0.08,
            0.9,
        )
    )
    dry = float(
        np.clip(
            (0.50 if kind == "charcoal" else 0.12)
            + (0.20 if kind == "graphite" else 0.0)
            - (0.28 if kind == "wash" else 0.0),
            0.04,
            0.8,
        )
    )
    bleed = float(
        np.clip(
            (0.48 if kind == "wash" else 0.06)
            + (0.20 if kind == "accent" else 0.0)
            + (0.08 if kind == "ink" else 0.0),
            0.03,
            0.6,
        )
    )
    return {
        "kind": kind,
        "opacity": round(opacity, 3),
        "grain": round(grain, 3),
        "dry": round(dry, 3),
        "bleed": round(bleed, 3),
    }


def jitter_look(look: dict, rng: random.Random) -> dict:
    out = dict(look)
    out["opacity"] = float(np.clip(float(out.get("opacity") or 0.75) + rng.gauss(0, 0.035), 0.30, 0.94))
    out["grain"] = float(np.clip(float(out.get("grain") or 0.28) + rng.gauss(0, 0.04), 0.05, 0.95))
    out["dry"] = float(np.clip(float(out.get("dry") or 0.16) + rng.gauss(0, 0.03), 0.02, 0.86))
    out["bleed"] = float(np.clip(float(out.get("bleed") or 0.08) + rng.gauss(0, 0.025), 0.02, 0.66))
    for k in ("opacity", "grain", "dry", "bleed"):
        out[k] = round(float(out[k]), 3)
    return out


def _shoelace(pts: np.ndarray) -> float:
    if len(pts) < 3:
        return 0.0
    x = pts[:, 0]
    y = pts[:, 1]
    return 0.5 * float(np.abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def _path_len(pts: np.ndarray) -> float:
    if len(pts) < 2:
        return 0.0
    d = np.diff(pts, axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def _compactness(pts: np.ndarray) -> float:
    area = _shoelace(pts)
    peri = _path_len(pts)
    if peri < 1.0:
        return 0.0
    return float(4.0 * math.pi * area / (peri * peri + 1e-6))


def _marker_fill_color(
    rng: random.Random,
    palette: list[dict],
    pens: list[dict],
    outline: list[int],
) -> list[int]:
    r, g, b = (int(outline[0]), int(outline[1]), int(outline[2]))
    sat = max(r, g, b) - min(r, g, b)
    if sat > 45:
        return [
            int(np.clip(r * 0.72 + 48, 0, 255)),
            int(np.clip(g * 0.66 + 36, 0, 255)),
            int(np.clip(b * 0.70 + 42, 0, 255)),
        ]
    accents = [
        p
        for p in pens
        if p.get("kind") == "accent" or "accent" in str(p.get("name") or "")
    ]
    if accents and rng.random() < 0.75:
        p = rng.choice(accents)
        col = [int(c) for c in (p.get("color") or [220, 80, 96])[:3]]
        return [
            int(np.clip(col[0] + rng.randint(-18, 12), 0, 255)),
            int(np.clip(col[1] + rng.randint(-14, 14), 0, 255)),
            int(np.clip(col[2] + rng.randint(-12, 16), 0, 255)),
        ]
    chromatic = [
        p
        for p in palette
        if max(p.get("rgb") or [0, 0, 0]) - min(p.get("rgb") or [0, 0, 0]) > 40
    ]
    if chromatic and rng.random() < 0.55:
        weights = [max(0.01, float(p.get("weight") or 0.01)) for p in chromatic]
        p = rng.choices(chromatic, weights=weights, k=1)[0]
        return [int(v) for v in p["rgb"][:3]]
    washes = [
        p
        for p in pens
        if p.get("kind") in ("wash", "graphite") or "wash" in str(p.get("name") or "")
    ]
    if washes:
        p = rng.choice(washes)
        return [int(c) for c in (p.get("color") or [140, 128, 122])[:3]]
    return [220, 82, 98]


def _assign_marker_fills(
    placed: list[dict],
    rng: random.Random,
    palette: list[dict],
    pens: list[dict],
    *,
    prefer: bool = False,
    canvas: tuple[int, int] | None = None,
    fill_amount: float = 0.28,
) -> None:
    """Rare, varied interiors: usually airbrush mist, sometimes a real fill."""
    chance = float(max(0.0, min(1.0, fill_amount)))
    if chance <= 0.001:
        return
    page = float((canvas[0] * canvas[1]) if canvas else 1024 * 1280)
    candidates: list[tuple[float, float, int, bool]] = []
    for i, u in enumerate(placed):
        pts = np.asarray(u.get("points") or [], dtype=np.float64)
        if len(pts) < 4:
            continue
        src_fill = bool(u.get("wasFill"))
        closed = bool(u.get("closed") or src_fill)
        if not closed:
            continue
        area = _shoelace(pts)
        if area < 900 or area > page * 0.18:
            continue
        compact = _compactness(pts)
        if compact < 0.14 and not src_fill:
            continue
        candidates.append((area, compact, i, src_fill))
    if not candidates:
        return

    # Most passages stay line-only; fill_amount turns that up or down
    if rng.random() > chance * (0.9 if prefer else 0.48):
        return

    candidates.sort(reverse=True)
    n_pick = 1
    if len(candidates) > 2 and rng.random() < 0.18:
        n_pick = 2
    picked = [c[2] for c in candidates[:n_pick]]

    styles = ["airbrush", "mist", "blob", "full"]
    weights = [0.46, 0.24, 0.18, 0.12]

    for i in picked:
        u = placed[i]
        outline = [int(c) for c in (u.get("color") or [28, 26, 24])[:3]]
        raw = u.get("rawColor") or outline
        src_fill = bool(u.get("wasFill"))
        if src_fill and max(raw) - min(raw) > 22:
            fc = [int(c) for c in raw[:3]]
        else:
            fc = _marker_fill_color(rng, palette, pens, outline)
        style = rng.choices(styles, weights=weights, k=1)[0]
        chromatic = max(fc) - min(fc) > 40
        u["fill"] = True
        u["fillStyle"] = style
        u["fillColor"] = fc
        u["fillLook"] = {
            "kind": "airbrush" if style != "full" else ("accent" if chromatic else "wash"),
            "opacity": round(float(rng.uniform(0.16, 0.58 if style != "full" else 0.72)), 3),
            "grain": round(float(rng.uniform(0.08, 0.45)), 3),
            "dry": round(float(rng.uniform(0.12, 0.62)), 3),
            "bleed": round(float(rng.uniform(0.22, 0.70)), 3),
        }
        u["fillCover"] = round(float(rng.uniform(0.22, 0.85)), 3)


def nearest_pen(
    color: list[int],
    width_rel: float,
    pens: list[dict] | None = None,
) -> dict | None:
    pens = pens if pens is not None else load_pens()
    if not pens:
        return None
    r, g, b = (int(color[0]), int(color[1]), int(color[2]))
    lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    wr = math.log(max(width_rel, 1e-4))
    best: dict | None = None
    best_d = 1e9
    for p in pens:
        pr, pg, pb = (int(c) for c in (p.get("color") or [28, 26, 24])[:3])
        plum = (0.299 * pr + 0.587 * pg + 0.114 * pb) / 255.0
        pwr = math.log(max(float(p.get("width_rel") or 0.05), 1e-4))
        d = (lum - plum) ** 2 * 2.4 + (wr - pwr) ** 2 * 1.5
        if d < best_d:
            best_d = d
            best = p
    return best


def apply_pen(
    n_points: int,
    *,
    pen: dict | None,
    rng: random.Random,
    canvas_scale: float,
    novelty: float = 0.2,
) -> tuple[list[float], float, list[int], dict]:
    """
    Turn a pen into widths + color + the material look (grain, dry, bleed).
    canvas_scale ≈ min(width,height) so width_rel maps to pixels.
    """
    look = jitter_look(pen_look(pen), rng)
    if pen is None:
        base = float(rng.uniform(1.6, 3.2))
        return [base] * n_points, base, [28, 26, 24], look

    wr = float(pen.get("width_rel") or 0.05)
    # Need enough pixels for grain / tooth to read — not a 1px vector hair
    base = 1.35 + math.log1p(wr * 40) * 1.7
    if look["kind"] == "charcoal":
        base *= 1.12
    elif look["kind"] == "wash":
        base *= 1.18
    base *= 0.95 + novelty * 0.2
    base = float(max(1.2, min(7.4, base)))
    env = pen.get("envelope") or [1.0]
    e = np.asarray(env, dtype=np.float64)
    if len(e) < 2:
        e = np.ones(8)
    xi = np.linspace(0, 1, len(e))
    x = np.linspace(0, 1, max(n_points, 2))
    profile = np.interp(x, xi, e)
    wobble = float(pen.get("wobble") or 0.1)
    noise = 1.0 + rng.gauss(0, 0.08 + wobble * 0.15)
    widths = []
    for v in profile:
        jitter = 1.0 + rng.gauss(0, 0.05 + wobble * 0.1)
        widths.append(round(float(max(0.8, base * v * noise * jitter)), 2))
    color = [int(c) for c in (pen.get("color") or [28, 26, 24])[:3]]
    color = [
        int(np.clip(c + rng.randint(-10, 10), 0, 255)) for c in color
    ]
    return widths, float(np.median(widths)), color, look


_sketchrnn = None
_icon_models: dict[str, object] = {}
_icon_libs: dict[str, dict | None] = {}


def _get_sketchrnn():
    """Lazy-load personal vibe stroke model (None if not trained yet)."""
    global _sketchrnn
    if _sketchrnn is False:
        return None
    if _sketchrnn is not None:
        return _sketchrnn
    try:
        from generate.stroke_model.train import load_model

        m = load_model("cpu")
        _sketchrnn = m if m is not None else False
        return m
    except Exception:
        _sketchrnn = False
        return None


def _get_icon_model(label: str):
    if label in _icon_models:
        cached = _icon_models[label]
        return None if cached is False else cached
    try:
        from generate.stroke_model.train import load_model

        m = load_model("cpu", icon=label)
        _icon_models[label] = m if m is not None else False
        return m
    except Exception:
        _icon_models[label] = False
        return None


def stroke_model_ready() -> bool:
    return _get_sketchrnn() is not None


def load_icon_library(label: str) -> dict | None:
    if label in _icon_libs:
        return _icon_libs[label]
    from generate.stroke_model.train import ICONS_DIR

    path = ICONS_DIR / f"{label}.json"
    if not path.exists():
        _icon_libs[label] = None
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    _icon_libs[label] = data
    return data


def list_ready_icons() -> list[str]:
    from generate.stroke_model.train import ICONS_DIR

    if not ICONS_DIR.exists():
        return []
    return [p.stem for p in sorted(ICONS_DIR.glob("*.json"))]


def _all_units(d: dict) -> list[dict]:
    out = []
    for u in d.get("forms") or []:
        out.append({**u, "_kind": "form"})
    for u in d.get("strokes") or []:
        out.append({**u, "_kind": "stroke"})
    return out


def _by_source(units: list[dict]) -> dict[str, list[dict]]:
    m: dict[str, list[dict]] = {}
    for u in units:
        src = u.get("source") or "?"
        m.setdefault(src, []).append(u)
    return m


def _cluster_around(units: list[dict], seed_u: dict, max_n: int, radius: float) -> list[dict]:
    """Marks from the same page near a seed mark (page coords)."""
    sx = float(seed_u.get("page_x") or 0.5)
    sy = float(seed_u.get("page_y") or 0.5)
    scored = []
    for u in units:
        dx = float(u.get("page_x") or 0.5) - sx
        dy = float(u.get("page_y") or 0.5) - sy
        dist = math.hypot(dx, dy)
        if dist <= radius:
            scored.append((dist, u))
    scored.sort(key=lambda t: t[0])
    picked = [seed_u]
    for _, u in scored:
        if u is seed_u:
            continue
        picked.append(u)
        if len(picked) >= max_n:
            break
    return picked


def _chaikin(pts: np.ndarray, iters: int = 2, closed: bool = False) -> np.ndarray:
    """Corner-cutting for smoother hand-like curves."""
    cur = pts.astype(np.float64)
    for _ in range(iters):
        if len(cur) < 3:
            break
        nxt = []
        m = len(cur)
        lim = m if closed else m - 1
        if not closed:
            nxt.append(cur[0])
        for i in range(lim):
            a = cur[i]
            b = cur[(i + 1) % m]
            nxt.append(0.75 * a + 0.25 * b)
            nxt.append(0.25 * a + 0.75 * b)
        if not closed:
            nxt.append(cur[-1])
        cur = np.asarray(nxt, dtype=np.float64)
    return cur


def _ink_color(
    color: list[int],
    rng: random.Random,
    palette: list[dict],
    kind: str | None = None,
) -> list[int]:
    """
    Keep the pen's material. Wash stays translucent gray, graphite stays
    mid-tone, charcoal stays dark. Color is an accent, not the whole look.
    """
    r, g, b = (int(color[0]), int(color[1]), int(color[2]))
    sat = max(r, g, b) - min(r, g, b)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    k = (kind or "").lower()

    if k in ("wash", "graphite"):
        # keep the gray — crushing to black makes it read as a vector stroke
        warm = rng.randint(-4, 6)
        return [
            int(np.clip(r + warm, 8, 210)),
            int(np.clip(g + warm - 2, 8, 205)),
            int(np.clip(b + warm - 4, 8, 200)),
        ]

    if k == "accent" or (sat > 35 and rng.random() < 0.28):
        return [
            int(np.clip(r * 0.82 + 12, 0, 255)),
            int(np.clip(g * 0.72 + 10, 0, 255)),
            int(np.clip(b * 0.75 + 12, 0, 255)),
        ]

    if sat > 35:
        v = int(rng.randint(12, 42))
        return [v, max(0, v - 2), max(0, v - 3)]

    if lum > 155 and k not in ("wash", "graphite"):
        v = int(rng.randint(18, 48))
        return [v, max(0, v - 2), max(0, v - 4)]

    return [r, g, b]


def _place_passage_units(
    cluster: list[dict],
    *,
    width: int,
    height: int,
    novelty: float,
    seed: int,
    palette: list[dict],
    anchor: tuple[float, float] | None = None,
    fill_amount: float = 0.28,
) -> list[dict]:
    """
    Place a neighborhood onto the canvas.

    Spreads across the page (not glued to center). Colors biased to black ink.
    """
    rng = random.Random(seed)
    if not cluster:
        return []

    all_x: list[float] = []
    all_y: list[float] = []
    for u in cluster:
        pp = u.get("page_points") or []
        if pp:
            for x, y in pp:
                all_x.append(float(x))
                all_y.append(float(y))
        else:
            all_x.append(float(u.get("page_x") or 0.5))
            all_y.append(float(u.get("page_y") or 0.5))

    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    pad = 0.015
    min_x = max(0.0, min_x - pad)
    min_y = max(0.0, min_y - pad)
    max_x = min(1.0, max_x + pad)
    max_y = min(1.0, max_y + pad)
    win_w = max(max_x - min_x, 0.06)
    win_h = max(max_y - min_y, 0.06)
    cx_p = (min_x + max_x) * 0.5
    cy_p = (min_y + max_y) * 0.5

    # Spread across the whole sheet — edges and corners count
    margin = 0.02
    avail_w = width * (1.0 - 2 * margin)
    avail_h = height * (1.0 - 2 * margin)
    cover = 0.72 + rng.uniform(0.0, 0.45) + novelty * 0.08
    fit = min(avail_w / win_w, avail_h / win_h) * min(cover, 1.35)
    zoom = fit * (0.92 + rng.uniform(-0.06, 0.14))
    angle = rng.uniform(-0.18, 0.18) * (0.4 + novelty)

    if anchor is not None:
        tx, ty = anchor
    else:
        tx = width * (margin + rng.random() * (1.0 - 2 * margin))
        ty = height * (margin + rng.random() * (1.0 - 2 * margin))
    tx = float(np.clip(tx, width * 0.06, width * 0.94))
    ty = float(np.clip(ty, height * 0.06, height * 0.94))

    c, s = math.cos(angle), math.sin(angle)
    rot = np.array([[c, -s], [s, c]])
    pens = load_pens()

    placed: list[dict] = []
    for u in cluster:
        pp = u.get("page_points") or []
        if len(pp) >= 2:
            pts = np.array(pp, dtype=np.float64)
            local = np.empty_like(pts)
            local[:, 0] = (pts[:, 0] - cx_p) * zoom
            local[:, 1] = (pts[:, 1] - cy_p) * zoom
            world = local @ rot.T
            world[:, 0] += tx
            world[:, 1] += ty
            size_ref = max(float(u.get("page_s") or 0.04) * zoom, 14.0)
        else:
            pts = np.array(u["points"], dtype=np.float64)
            if len(pts) < 2:
                continue
            size_ref = max(float(u.get("page_s") or 0.04) * zoom, 14.0)
            local = pts * size_ref
            ox = (float(u.get("page_x") or 0.5) - cx_p) * zoom
            oy = (float(u.get("page_y") or 0.5) - cy_p) * zoom
            world = local @ rot.T
            world[:, 0] += tx + ox
            world[:, 1] += ty + oy

        span = float(
            max(world[:, 0].max() - world[:, 0].min(), world[:, 1].max() - world[:, 1].min())
        )
        if span < min(width, height) * 0.022:
            continue

        if (
            world[:, 0].mean() < -80
            or world[:, 0].mean() > width + 80
            or world[:, 1].mean() < -80
            or world[:, 1].mean() > height + 80
        ):
            continue

        kind = u.get("_kind") or "stroke"
        closed = bool(u.get("closed")) or bool(u.get("fill")) or (
            kind == "form" and float(u.get("compact") or 0) > 0.035
        )
        is_form = kind == "form" or bool(u.get("fill")) or closed
        world = _chaikin(world, iters=2 if is_form else 1, closed=closed)

        wr = float(u.get("width_rel") or 0.08)
        line_w = max(
            1.5,
            min(5.5, wr * size_ref * (0.45 if is_form else 0.32)),
        )
        rel_ws = u.get("widths") or [wr]
        widths = [
            max(1.4, min(5.5, float(x) * size_ref * (0.4 if is_form else 0.3) * 0.5 + line_w * 0.5))
            for x in rel_ws
        ]
        while len(widths) < len(world):
            widths.append(widths[-1])
        if len(widths) != len(world):
            idx = np.linspace(0, len(widths) - 1, len(world))
            widths = [widths[int(round(i))] for i in idx]
        if len(widths) >= 3:
            warr = np.asarray(widths, dtype=np.float64)
            widths = (
                0.25 * np.roll(warr, 1) + 0.5 * warr + 0.25 * np.roll(warr, -1)
            ).tolist()

        if u.get("color") and len(u["color"]) >= 3:
            raw_color = [int(v) for v in u["color"][:3]]
        else:
            color_idx = int(u.get("color_idx") or 0)
            if 0 <= color_idx < len(palette):
                raw_color = [int(v) for v in palette[color_idx]["rgb"]]
            else:
                raw_color = [28, 26, 24]
        pen = nearest_pen(raw_color, wr, pens)
        look = jitter_look(pen_look(pen) if pen else look_from_rgb(raw_color, wr), rng)
        color = _ink_color(raw_color, rng, palette, look.get("kind"))

        placed.append(
            {
                "kind": "form" if is_form else "stroke",
                "fill": False,
                "wasFill": bool(u.get("fill")),
                "rawColor": raw_color,
                "points": [[round(float(x), 2), round(float(y), 2)] for x, y in world],
                "widths": [round(float(w), 2) for w in widths],
                "color": color,
                "width": round(line_w, 2),
                "closed": closed,
                "source": u.get("source"),
                "pen": (pen or {}).get("name"),
                "look": look,
                "cx": round(float(world[-1, 0]), 2),
                "cy": round(float(world[-1, 1]), 2),
                "heading": 0.0,
            }
        )
    placed.sort(
        key=lambda u: (u["points"][0][1] + u["points"][0][0]) if u["points"] else 0
    )
    _assign_marker_fills(
        placed,
        rng,
        palette,
        pens,
        prefer=False,
        canvas=(width, height),
        fill_amount=fill_amount,
    )
    return placed


def _pick_anchor(
    rng: random.Random,
    width: int,
    height: int,
    cx: float | None,
    cy: float | None,
) -> tuple[float, float]:
    """A hand drifts across the sheet — nearby, then a step, then a new region."""

    def fresh() -> tuple[float, float]:
        mode = rng.random()
        if mode < 0.28:
            ax = width * rng.choice([0.07, 0.12, 0.22, 0.78, 0.88, 0.93])
            ay = height * rng.choice([0.07, 0.14, 0.28, 0.72, 0.86, 0.93])
            ax += rng.gauss(0, width * 0.03)
            ay += rng.gauss(0, height * 0.03)
        elif mode < 0.55:
            ax = width * rng.uniform(0.05, 0.95)
            ay = height * rng.uniform(0.05, 0.95)
        elif mode < 0.78:
            ang = rng.uniform(0, math.tau)
            rad = min(width, height) * rng.uniform(0.12, 0.48)
            ax = width * 0.5 + math.cos(ang) * rad
            ay = height * 0.5 + math.sin(ang) * rad
        else:
            ax = width * rng.uniform(0.08, 0.92)
            ay = height * rng.uniform(0.08, 0.92)
        return ax, ay

    if cx is not None and cy is not None:
        u = rng.random()
        if u < 0.48:
            ax = float(cx) + rng.gauss(0, width * 0.13)
            ay = float(cy) + rng.gauss(0, height * 0.13)
        elif u < 0.78:
            ang = rng.uniform(0, math.tau)
            dist = min(width, height) * rng.uniform(0.16, 0.4)
            ax = float(cx) + math.cos(ang) * dist
            ay = float(cy) + math.sin(ang) * dist
        else:
            ax, ay = fresh()
    else:
        ax, ay = fresh()
    ax = float(np.clip(ax, width * 0.04, width * 0.96))
    ay = float(np.clip(ay, height * 0.04, height * 0.96))
    return ax, ay


def _motif_size(rng: random.Random, width: int, height: int, novelty: float) -> float:
    """Usual small-to-mid icons, with occasional sheet-filling forms."""
    m = float(min(width, height))
    u = rng.random()
    if u < 0.08:
        frac = rng.uniform(0.82, 1.28)
    elif u < 0.2:
        frac = rng.uniform(0.52, 0.78)
    else:
        frac = 0.2 + rng.uniform(0.0, 0.24) + novelty * 0.08
    return m * frac


def _anchor_for_size(
    rng: random.Random,
    width: int,
    height: int,
    ax: float,
    ay: float,
    size: float,
) -> tuple[float, float]:
    """Big forms sit more on the page; sometimes they still spill off an edge."""
    m = float(min(width, height))
    if size < m * 0.5:
        return ax, ay
    if rng.random() < 0.55:
        ax = ax * 0.38 + width * 0.5 * 0.62
        ay = ay * 0.38 + height * 0.5 * 0.62
    else:
        edge = rng.choice(
            [
                (width * rng.uniform(0.12, 0.28), height * rng.uniform(0.2, 0.8)),
                (width * rng.uniform(0.72, 0.88), height * rng.uniform(0.2, 0.8)),
                (width * rng.uniform(0.2, 0.8), height * rng.uniform(0.12, 0.28)),
                (width * rng.uniform(0.2, 0.8), height * rng.uniform(0.72, 0.88)),
            ]
        )
        ax, ay = edge
    return (
        float(np.clip(ax, width * 0.06, width * 0.94)),
        float(np.clip(ay, height * 0.06, height * 0.94)),
    )


def _invent_passage(
    *,
    width: int,
    height: int,
    novelty: float,
    seed: int,
    palette: list[dict],
    cx: float | None,
    cy: float | None,
) -> dict | None:
    """Invent new gestures with the vibe stroke model (not library copies)."""
    model = _get_sketchrnn()
    if model is None:
        return None

    from generate.stroke_model.train import sample_stroke

    rng = random.Random(seed)
    ax, ay = _pick_anchor(rng, width, height, cx, cy)
    n_marks = int(3 + novelty * 8 + rng.randint(0, 3))
    temp = 0.35 + novelty * 0.55
    rhythm = load_dictionary().get("rhythm") or {}
    base_len = float(rhythm.get("stroke_length_p50") or 0.8)

    placed: list[dict] = []
    cursor_x, cursor_y = ax, ay
    heading = rng.uniform(0, math.tau)
    canvas_scale = float(min(width, height))

    for _ in range(n_marks):
        pts_n = sample_stroke(model, temperature=temp, device="cpu")
        if len(pts_n) < 4:
            continue
        pts = np.asarray(pts_n, dtype=np.float64)
        span = max(float(np.ptp(pts[:, 0])), float(np.ptp(pts[:, 1])), 1e-3)
        if rng.random() < 0.1:
            target = min(width, height) * rng.uniform(0.42, 0.88)
        else:
            target = min(width, height) * (0.08 + novelty * 0.1 + rng.uniform(0, 0.12))
        target *= 0.7 + min(1.4, base_len)
        scale = target / span
        angle = heading + rng.gauss(0, 0.35)
        c, s = math.cos(angle), math.sin(angle)
        rot = np.array([[c, -s], [s, c]])
        world = (pts * scale) @ rot.T
        world[:, 0] += cursor_x
        world[:, 1] += cursor_y
        world = _chaikin(world, iters=1, closed=False)

        if (
            world[:, 0].mean() < -40
            or world[:, 0].mean() > width + 40
            or world[:, 1].mean() < -40
            or world[:, 1].mean() > height + 40
        ):
            cursor_x = width * rng.uniform(0.05, 0.95)
            cursor_y = height * rng.uniform(0.05, 0.95)
            continue

        pen = pick_pen(rng)
        widths, line_w, pen_color, look = apply_pen(
            len(world),
            pen=pen,
            rng=rng,
            canvas_scale=canvas_scale,
            novelty=novelty,
        )
        color = _ink_color(pen_color, rng, palette, look.get("kind"))
        placed.append(
            {
                "kind": "stroke",
                "fill": False,
                "points": [[round(float(x), 2), round(float(y), 2)] for x, y in world],
                "widths": widths,
                "color": color,
                "width": round(line_w, 2),
                "closed": False,
                "source": "invented",
                "pen": (pen or {}).get("name"),
                "look": look,
                "cx": round(float(world[-1, 0]), 2),
                "cy": round(float(world[-1, 1]), 2),
                "heading": 0.0,
            }
        )
        cursor_x = float(world[-1, 0]) + rng.gauss(0, min(width, height) * 0.07)
        cursor_y = float(world[-1, 1]) + rng.gauss(0, min(width, height) * 0.07)
        heading += rng.gauss(0, 0.5)
        cursor_x = float(np.clip(cursor_x, width * 0.03, width * 0.97))
        cursor_y = float(np.clip(cursor_y, height * 0.03, height * 0.97))

    if not placed:
        return None
    last = placed[-1]
    return {
        "kind": "passage",
        "source": "invented",
        "engine": "stroke_model",
        "units": placed,
        "cx": last["cx"],
        "cy": last["cy"],
        "heading": 0.0,
    }


def _stroke_page_pts(stroke: dict) -> np.ndarray | None:
    """Recover page-relative polyline so a flower keeps stem + bloom layout."""
    pp = stroke.get("page_points") or []
    if len(pp) >= 2:
        return np.asarray(pp, dtype=np.float64)
    pts = stroke.get("points") or []
    if len(pts) < 2:
        return None
    local = np.asarray(pts, dtype=np.float64)
    px = float(stroke.get("page_x") or 0.5)
    py = float(stroke.get("page_y") or 0.5)
    ps = float(stroke.get("page_s") or 0.08)
    return local * ps + np.array([px, py], dtype=np.float64)


def _most_stemlike(strokes: list[dict]) -> dict | None:
    best: dict | None = None
    score = -1.0
    for s in strokes:
        pts = _stroke_page_pts(s)
        if pts is None or len(pts) < 2:
            continue
        dy = float(np.ptp(pts[:, 1]))
        dx = float(np.ptp(pts[:, 0]))
        length = float(s.get("page_len") or 0.0)
        sc = (dy / (dx + 1e-4)) * (0.35 + length)
        if sc > score:
            score = sc
            best = s
    return best


def _graft_bloom(base: list[dict], donor: list[dict]) -> list[dict]:
    """Keep one flower's stem, set another flower's bloom on the tip."""
    stem = _most_stemlike(base)
    donor_stem = _most_stemlike(donor)
    if stem is None:
        return base
    bloom = [s for s in donor if s is not donor_stem]
    if not bloom:
        return base
    stem_pts = _stroke_page_pts(stem)
    if stem_pts is None:
        return base
    tip = stem_pts[int(np.argmin(stem_pts[:, 1]))]
    bloom_pts = []
    for s in bloom:
        pts = _stroke_page_pts(s)
        if pts is not None:
            bloom_pts.append(pts)
    if not bloom_pts:
        return base
    packed = np.vstack(bloom_pts)
    center = packed.mean(axis=0)
    # scale donor bloom toward this stem's size
    stem_span = max(float(np.ptp(stem_pts[:, 1])), 1e-4)
    bloom_span = max(float(np.ptp(packed[:, 1])), float(np.ptp(packed[:, 0])), 1e-4)
    scale = float(np.clip(stem_span * 0.85 / bloom_span, 0.45, 1.6))
    grafted = [stem]
    for s in bloom:
        pts = _stroke_page_pts(s)
        if pts is None:
            continue
        world = (pts - center) * scale + tip
        new = dict(s)
        new["page_points"] = [[float(x), float(y)] for x, y in world]
        grafted.append(new)
    return grafted


def _hand_jitter(pts: np.ndarray, rng: random.Random, amount: float) -> np.ndarray:
    if amount <= 0.002 or len(pts) < 3:
        return pts
    n = len(pts)
    span = max(float(np.ptp(pts[:, 0])), float(np.ptp(pts[:, 1])), 1.0)
    t = np.linspace(0.0, 2.0 * math.pi, n, endpoint=False)
    ph_x = rng.uniform(0, math.tau)
    ph_y = rng.uniform(0, math.tau)
    fx = rng.uniform(0.7, 1.7)
    fy = rng.uniform(0.7, 1.7)
    dx = np.sin(t * fx + ph_x) * span * amount
    dy = np.sin(t * fy + ph_y) * span * amount
    out = pts.copy()
    out[:, 0] += dx
    out[:, 1] += dy
    return out


def _place_icon_strokes(
    strokes: list[dict],
    *,
    width: int,
    height: int,
    novelty: float,
    rng: random.Random,
    palette: list[dict],
    anchor: tuple[float, float],
    size: float,
    angle: float,
    label: str,
    fill_amount: float = 0.28,
) -> list[dict]:
    packed: list[np.ndarray] = []
    kept: list[tuple[dict, np.ndarray]] = []
    for s in strokes:
        pts = _stroke_page_pts(s)
        if pts is None or len(pts) < 2:
            continue
        packed.append(pts)
        kept.append((s, pts))
    if not kept:
        return []

    all_pts = np.vstack(packed)
    cx_p = float(all_pts[:, 0].mean())
    cy_p = float(all_pts[:, 1].mean())
    span = max(float(np.ptp(all_pts[:, 0])), float(np.ptp(all_pts[:, 1])), 1e-4)
    scale = size / span
    c, s = math.cos(angle), math.sin(angle)
    rot = np.array([[c, -s], [s, c]])
    canvas_scale = float(min(width, height))
    jitter = 0.012 + novelty * 0.05
    tx, ty = anchor

    pens = load_pens()
    charcoal = next((p for p in pens if "charcoal" in str(p.get("name") or "")), None)

    placed: list[dict] = []
    for src, pts in kept:
        local = np.empty_like(pts)
        local[:, 0] = (pts[:, 0] - cx_p) * scale
        local[:, 1] = (pts[:, 1] - cy_p) * scale
        world = local @ rot.T
        world[:, 0] += tx
        world[:, 1] += ty
        world = _hand_jitter(world, rng, jitter)
        world = _chaikin(world, iters=1, closed=bool(src.get("closed")))
        if len(world) < 2:
            continue

        pen = pick_pen(rng, pens)
        if pen and "wash" in str(pen.get("name") or "") and charcoal is not None:
            pen = charcoal
        widths, line_w, pen_color, look = apply_pen(
            len(world),
            pen=pen,
            rng=rng,
            canvas_scale=canvas_scale,
            novelty=novelty,
        )
        # Icons are line drawings — keep them a bit darker and firmer.
        # Huge forms get a slightly heavier pen so they don't look like hair-thin giants.
        size_boost = float(np.clip(size / max(canvas_scale, 1.0), 0.18, 1.25))
        thick = 0.92 + size_boost * 0.42
        line_w = float(max(1.6, min(8.8, line_w * 0.96 * thick)))
        widths = [float(max(1.3, min(9.2, w * 0.96 * thick))) for w in widths]
        color = _ink_color(pen_color, rng, palette, look.get("kind"))
        closed = bool(src.get("closed") or src.get("fill"))
        is_form = src.get("kind") == "form" or closed
        placed.append(
            {
                "kind": "form" if is_form else "stroke",
                "fill": False,
                "points": [[round(float(x), 2), round(float(y), 2)] for x, y in world],
                "widths": [round(float(w), 2) for w in widths],
                "color": color,
                "width": round(line_w, 2),
                "closed": closed,
                "source": f"icon:{label}",
                "pen": (pen or {}).get("name"),
                "look": look,
                "cx": round(float(world[-1, 0]), 2),
                "cy": round(float(world[-1, 1]), 2),
                "heading": 0.0,
            }
        )
    _assign_marker_fills(
        placed,
        rng,
        palette,
        pens,
        prefer=True,
        canvas=(width, height),
        fill_amount=fill_amount,
    )
    return placed


def _invent_icon_passage(
    *,
    label: str,
    width: int,
    height: int,
    novelty: float,
    seed: int,
    palette: list[dict],
    cx: float | None,
    cy: float | None,
    fill_amount: float = 0.28,
) -> dict | None:
    """Place a real labeled symbol (stem + bloom kept together), lightly varied."""
    lib = load_icon_library(label)
    if not lib:
        return None
    sketches = [
        sk
        for sk in (lib.get("sketches") or [])
        if sk.get("strokes") and int(sk.get("n_strokes") or 0) >= 1
        and sum(len(s.get("page_points") or s.get("points") or []) for s in sk["strokes"]) >= 12
    ]
    if not sketches:
        return None

    rng = random.Random(seed)
    rich = [sk for sk in sketches if int(sk.get("n_strokes") or 0) >= 2]
    sketch = rng.choice(rich if rich and rng.random() < 0.88 else sketches)
    strokes = list(sketch["strokes"])
    if novelty > 0.35 and len(sketches) > 1 and rng.random() < min(0.7, 0.25 + novelty):
        donor = rng.choice([sk for sk in sketches if sk is not sketch] or sketches)
        strokes = _graft_bloom(strokes, list(donor.get("strokes") or []))

    ax, ay = _pick_anchor(rng, width, height, cx, cy)
    n_marks = 1 + (1 if novelty > 0.5 and rng.random() < 0.35 else 0)
    placed: list[dict] = []
    cursor = (ax, ay)

    for i in range(n_marks):
        if i > 0:
            sketch = rng.choice(sketches)
            strokes = list(sketch.get("strokes") or [])
            cursor = (
                float(np.clip(cursor[0] + rng.gauss(0, width * 0.28), width * 0.05, width * 0.95)),
                float(np.clip(cursor[1] + rng.gauss(0, height * 0.28), height * 0.05, height * 0.95)),
            )
        size = _motif_size(rng, width, height, novelty)
        if i > 0:
            size *= 0.62
        cursor = _anchor_for_size(rng, width, height, cursor[0], cursor[1], size)
        angle = rng.uniform(-0.22, 0.22) * (0.45 + novelty)
        units = _place_icon_strokes(
            strokes,
            width=width,
            height=height,
            novelty=novelty,
            rng=rng,
            palette=palette,
            anchor=cursor,
            size=size,
            angle=angle,
            label=label,
            fill_amount=fill_amount,
        )
        if units:
            placed.extend(units)
            last = units[-1]
            cursor = (float(last["cx"]), float(last["cy"]))

    if not placed:
        return None
    last = placed[-1]
    return {
        "kind": "passage",
        "source": f"icon:{label}",
        "engine": f"icon:{label}",
        "units": placed,
        "cx": last["cx"],
        "cy": last["cy"],
        "heading": 0.0,
    }


def next_passage_library(
    *,
    width: int,
    height: int,
    novelty: float,
    seed: int,
    prefer_source: str | None,
    cx: float | None,
    cy: float | None,
    palette: list[dict],
    d: dict,
    fill_amount: float = 0.28,
) -> dict:
    """Replay a neighborhood from one of your drawings."""
    rng = random.Random(seed)
    units = _all_units(d)
    by_src = _by_source(units)
    sources = [s for s, us in by_src.items() if len(us) >= 3]
    if not sources:
        sources = list(by_src.keys())

    if prefer_source and prefer_source in by_src and rng.random() < 0.35:
        source = prefer_source
    else:
        src_w = []
        for s in sources:
            us = by_src[s]
            dark = 0.0
            for u in us:
                col = u.get("color") or [40, 40, 40]
                lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2]
                sat = max(col) - min(col)
                if lum < 80 and sat < 40:
                    dark += 2.0
                elif sat > 50:
                    dark += 0.15
                else:
                    dark += 0.8
            src_w.append(max(0.2, dark / max(len(us), 1)))
        source = rng.choices(sources, weights=src_w, k=1)[0]

    pool = by_src[source]
    weights = []
    for u in pool:
        col = u.get("color") or [40, 40, 38]
        lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2]
        sat = max(col) - min(col)
        w = (
            0.3
            + float(u.get("length") or 0.1)
            + float(u.get("page_len") or 0) * 0.4
            + (1.5 if lum < 70 else 0.0)
            + (1.0 if sat < 25 else 0.0)
            - (0.7 if sat > 60 else 0.0)
            + (0.6 if u.get("_kind") == "stroke" else 0.2)
        )
        weights.append(max(0.05, w))
    seed_u = rng.choices(pool, weights=weights, k=1)[0]

    radius = 0.32 + novelty * 0.2
    n_marks = int(rng.randint(8, 18) + novelty * 5)
    cluster = _cluster_around(pool, seed_u, max_n=n_marks, radius=radius)
    ax, ay = _pick_anchor(rng, width, height, cx, cy)

    placed = _place_passage_units(
        cluster,
        width=width,
        height=height,
        novelty=novelty,
        seed=seed,
        palette=palette,
        anchor=(ax, ay),
        fill_amount=fill_amount,
    )
    last = placed[-1] if placed else None
    return {
        "kind": "passage",
        "source": source,
        "engine": "library",
        "units": placed,
        "cx": last["cx"] if last else ax,
        "cy": last["cy"] if last else ay,
        "heading": 0.0,
    }


def next_passage(
    *,
    width: int = 1024,
    height: int = 1280,
    novelty: float = 0.15,
    seed: int = 0,
    prefer_source: str | None = None,
    cx: float | None = None,
    cy: float | None = None,
    mode: str = "vibe",
    icon: str | None = None,
    fill_amount: float = 0.28,
) -> dict:
    """
    mode:
      vibe  — library passages + vibe stroke invent (scratches)
      icon  — invent labeled symbols (requires trained icon model)
      mix   — both: icons + vibe scratches on the page
    """
    rng = random.Random(seed)
    d = load_dictionary()
    palette = d.get("palette") or [{"rgb": [28, 26, 24], "weight": 1}]
    ready_icons = list_ready_icons()
    label = icon if icon in ready_icons else (ready_icons[0] if ready_icons else None)
    mode = mode if mode in ("vibe", "icon", "mix") else "vibe"

    def vibe_pass() -> dict:
        invent_p = 0.0
        if _get_sketchrnn() is not None:
            invent_p = min(0.92, 0.12 + novelty * 0.95)
        if invent_p > 0 and rng.random() < invent_p:
            invented = _invent_passage(
                width=width,
                height=height,
                novelty=novelty,
                seed=seed,
                palette=palette,
                cx=cx,
                cy=cy,
            )
            if invented and invented["units"]:
                if novelty < 0.85 and rng.random() < 0.35:
                    lib = next_passage_library(
                        width=width,
                        height=height,
                        novelty=max(0.05, novelty * 0.5),
                        seed=seed + 17,
                        prefer_source=prefer_source,
                        cx=invented["cx"],
                        cy=invented["cy"],
                        palette=palette,
                        d=d,
                        fill_amount=fill_amount,
                    )
                    if lib["units"]:
                        invented["units"].extend(lib["units"][:2])
                return invented
        return next_passage_library(
            width=width,
            height=height,
            novelty=novelty,
            seed=seed,
            prefer_source=prefer_source,
            cx=cx,
            cy=cy,
            palette=palette,
            d=d,
            fill_amount=fill_amount,
        )

    def icon_pass() -> dict | None:
        if not label:
            return None
        return _invent_icon_passage(
            label=label,
            width=width,
            height=height,
            novelty=novelty,
            seed=seed,
            palette=palette,
            cx=cx,
            cy=cy,
            fill_amount=fill_amount,
        )

    if mode == "icon":
        got = icon_pass()
        if got and got["units"]:
            # light vibe accents under high invent
            if novelty > 0.45 and rng.random() < 0.25 and _get_sketchrnn() is not None:
                accents = _invent_passage(
                    width=width,
                    height=height,
                    novelty=novelty * 0.5,
                    seed=seed + 31,
                    palette=palette,
                    cx=got["cx"],
                    cy=got["cy"],
                )
                if accents and accents["units"]:
                    got["units"].extend(accents["units"][:2])
            return got
        return vibe_pass()

    if mode == "mix":
        # Prefer icons often; fill with vibe scratches the rest of the time
        want_icon = label is not None and rng.random() < (0.62 + novelty * 0.25)
        if want_icon:
            got = icon_pass()
            if got and got["units"]:
                if rng.random() < 0.4:
                    lib = next_passage_library(
                        width=width,
                        height=height,
                        novelty=max(0.05, novelty * 0.4),
                        seed=seed + 19,
                        prefer_source=prefer_source,
                        cx=got["cx"],
                        cy=got["cy"],
                        palette=palette,
                        d=d,
                        fill_amount=fill_amount,
                    )
                    if lib["units"]:
                        got["units"].extend(lib["units"][:3])
                return got
        return vibe_pass()

    return vibe_pass()


def next_style_unit(**kwargs) -> dict:
    """
    API compatibility: return first unit of a passage, OR if caller expects
    a single unit, still prefer passage via next_passage on /api/stroke.
    """
    # Single-unit fallback (rarely used now)
    p = next_passage(**kwargs)
    if p["units"]:
        u = p["units"][0]
        u["source"] = p["source"]
        return u
    raise SystemExit("Empty passage")


def next_vector_stroke(**kwargs) -> dict:
    return next_style_unit(**kwargs)


def compose_strokes(
    *,
    width: int = 1024,
    height: int = 1280,
    density: float = 1.0,
    novelty: float = 0.15,
    seed: int = 0,
    paper: str = "white",
    mode: str = "vibe",
    icon: str | None = None,
) -> Image.Image:
    if paper == "cream":
        bg = (243, 238, 230)
    elif paper == "black":
        bg = (12, 12, 12)
    else:
        bg = (250, 250, 248)

    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    n_passages = max(1, min(4, int(1 + density * 2)))
    source = None
    rng = random.Random(seed)

    for i in range(n_passages):
        passage = next_passage(
            width=width,
            height=height,
            novelty=novelty,
            seed=seed + i * 9973,
            prefer_source=source if (source and rng.random() < 0.7) else None,
            mode=mode,
            icon=icon,
        )
        source = passage.get("source")
        for s in passage["units"]:
            pts = [(p[0], p[1]) for p in s["points"]]
            if len(pts) < 2:
                continue
            color = tuple(int(c) for c in s["color"])
            w = max(1, int(round(s["width"])))
            path = list(pts)
            if s.get("closed") or s.get("kind") == "form":
                path = path + [pts[0]]
            draw.line(path, fill=color, width=w, joint="curve")
    return img
