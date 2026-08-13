#!/usr/bin/env python3
"""HTTP API — paper canvas from style dictionary passages."""

from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from generate.compose_strokes import (
    compose_strokes,
    list_ready_icons,
    load_dictionary,
    load_pens,
    next_passage,
    stroke_model_ready,
)

OUT_DIR = ROOT / "data" / "generate" / "outputs"
OUT_DIR.mkdir(parents=True, exist_ok=True)
DIST_DIR = ROOT / "dist"

app = FastAPI(title="Paper", version="0.8.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    try:
        d = load_dictionary()
        counts = d.get("counts") or {}
        icons = list_ready_icons()
        pens = load_pens()
        return {
            "ok": True,
            "engine": "passages+stroke_model" if stroke_model_ready() else "passages",
            "stroke_model": stroke_model_ready(),
            "icons": icons,
            "pens": [p.get("name") for p in pens],
            "pen_count": len(pens),
            "drawings": len(d.get("sources") or []),
            "forms": counts.get("forms", 0),
            "strokes": counts.get("strokes", 0),
            "colors": counts.get("colors", 0),
            "palette": [p.get("rgb") for p in (d.get("palette") or [])[:6]],
        }
    except SystemExit as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/generate")
def generate(
    density: float = Query(1.0, ge=0.2, le=2.5),
    novelty: float = Query(0.15, ge=0.0, le=1.0),
    seed: int = Query(..., ge=0),
    paper: str = Query("white"),
    width: int = Query(1024, ge=256, le=3840),
    height: int = Query(1280, ge=256, le=3840),
    mode: str = Query("vibe"),
    icon: str | None = Query(None),
) -> Response:
    if paper not in ("black", "white", "cream"):
        paper = "white"
    img = compose_strokes(
        width=width,
        height=height,
        density=density,
        novelty=novelty,
        seed=seed,
        paper=paper,
        mode=mode,
        icon=icon,
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/api/stroke")
def stroke(
    novelty: float = Query(0.15, ge=0.0, le=1.0),
    seed: int = Query(..., ge=0),
    width: int = Query(1024, ge=256, le=3840),
    height: int = Query(1280, ge=256, le=3840),
    source: str | None = Query(None),
    mode: str = Query("vibe"),
    icon: str | None = Query(None),
    fill: float = Query(0.28, ge=0.0, le=1.0),
    # unused — kept so old clients don't break
    cx: float | None = Query(None),
    cy: float | None = Query(None),
    heading: float | None = Query(None),
) -> JSONResponse:
    """A passage: vibe scratches and/or invented labeled icons."""
    return JSONResponse(
        next_passage(
            width=width,
            height=height,
            novelty=novelty,
            seed=seed,
            prefer_source=source,
            cx=cx,
            cy=cy,
            mode=mode,
            icon=icon,
            fill_amount=fill,
        )
    )


app.mount("/outputs", StaticFiles(directory=str(OUT_DIR)), name="outputs")

# Browser compose reads /knowledge/*.json (copied into dist on build).
_knowledge = DIST_DIR / "knowledge"
if not _knowledge.is_dir():
    _knowledge = ROOT / "public" / "knowledge"
if _knowledge.is_dir():
    app.mount("/knowledge", StaticFiles(directory=str(_knowledge)), name="knowledge")

# Serve built UI from the same Space (npm run build → dist/)
if DIST_DIR.is_dir() and (DIST_DIR / "index.html").exists():
    assets = DIST_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(
            DIST_DIR / "index.html",
            headers={"Cache-Control": "no-store"},
        )

    walk = DIST_DIR / "walk.html"
    if walk.exists():

        @app.get("/walk.html")
        def walk_page() -> FileResponse:
            return FileResponse(walk)


def main() -> None:
    import os

    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8787"))
    uvicorn.run("generate.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
