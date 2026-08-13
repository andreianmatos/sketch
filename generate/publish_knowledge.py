#!/usr/bin/env python3
"""Split cooked archive JSON into an index + per-source shards for the browser picker."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "generate"
OUT = ROOT / "public" / "knowledge"

KEEP_UNIT = (
    "source",
    "kind",
    "closed",
    "fill",
    "compact",
    "color",
    "width_rel",
    "widths",
    "length",
    "page_len",
    "page_x",
    "page_y",
    "page_s",
    "page_points",
    "points",
)


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "src"
    return s[:96]


def slim_unit(u: dict, kind: str) -> dict:
    out = {k: u[k] for k in KEEP_UNIT if k in u}
    out["_kind"] = kind
    return out


def source_weight(units: list[dict]) -> float:
    dark = 0.0
    for u in units:
        col = u.get("color") or [40, 40, 40]
        lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2]
        sat = max(col) - min(col)
        if lum < 80 and sat < 40:
            dark += 2.0
        elif sat > 50:
            dark += 0.15
        else:
            dark += 0.8
    return max(0.2, dark / max(len(units), 1))


def main() -> None:
    d = json.loads((DATA / "style_dictionary.json").read_text(encoding="utf-8"))
    pens = json.loads((DATA / "pens.json").read_text(encoding="utf-8"))
    by: dict[str, list[dict]] = defaultdict(list)
    for kind, key in (("form", "forms"), ("stroke", "strokes")):
        for u in d.get(key) or []:
            src = str(u.get("source") or "unknown")
            by[src].append(slim_unit(u, kind))

    src_dir = OUT / "sources"
    icon_dir = OUT / "icons"
    src_dir.mkdir(parents=True, exist_ok=True)
    icon_dir.mkdir(parents=True, exist_ok=True)
    for old in src_dir.glob("*.json"):
        old.unlink()
    for old in icon_dir.glob("*.json"):
        old.unlink()

    used: set[str] = set()
    sources = []
    for name, units in sorted(by.items()):
        s = slug(name)
        base = s
        n = 2
        while s in used:
            s = f"{base}_{n}"
            n += 1
        used.add(s)
        (src_dir / f"{s}.json").write_text(
            json.dumps({"id": name, "units": units}, separators=(",", ":")),
            encoding="utf-8",
        )
        sources.append(
            {
                "id": name,
                "file": f"sources/{s}.json",
                "n": len(units),
                "weight": round(source_weight(units), 4),
            }
        )

    icons = []
    icons_src = DATA / "icons"
    if icons_src.is_dir():
        for path in sorted(icons_src.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            sketches = []
            for sk in data.get("sketches") or []:
                strokes = sk.get("strokes") or []
                if not strokes:
                    continue
                sketches.append(
                    {
                        "source": sk.get("source"),
                        "n_strokes": int(sk.get("n_strokes") or len(strokes)),
                        "strokes": strokes,
                    }
                )
            if not sketches:
                continue
            (icon_dir / path.name).write_text(
                json.dumps({"label": path.stem, "sketches": sketches}, separators=(",", ":")),
                encoding="utf-8",
            )
            icons.append(path.stem)

    index = {
        "version": 1,
        "palette": d.get("palette") or [{"rgb": [28, 26, 24], "weight": 1}],
        "pens": pens.get("pens") or [],
        "sources": sources,
        "icons": icons,
    }
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"knowledge → {OUT}  ({len(sources)} sources, {len(icons)} icons)")


if __name__ == "__main__":
    main()
