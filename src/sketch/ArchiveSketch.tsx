import { useEffect, useRef } from "react";
import p5 from "p5";
import type { GridCell } from "../db/schema";
import { CELL_SIZE_M, cellCenterMeters } from "../geo/spatialHash";
import {
  generateStroke,
  strokeCountForVisits,
  type StyleDna,
} from "../style/markov";

export type ViewMode = "live" | "archive";

export type SketchProps = {
  cells: GridCell[];
  mode: ViewMode;
  followIx: number | null;
  followIy: number | null;
  styleDna: StyleDna | null;
};

type Cam = {
  x: number;
  y: number;
  zoom: number;
};

const PAPER = "#f7f7f5";
const METERS_TO_PX = 8;

function visitAlpha(count: number): number {
  if (count <= 1) return 0.22;
  if (count <= 3) return 0.34;
  if (count <= 6) return 0.48;
  if (count <= 12) return 0.62;
  return Math.min(0.9, 0.62 + (count - 12) * 0.015);
}

function visitStroke(count: number): number {
  if (count <= 1) return 0.25;
  if (count <= 10) return 0.35;
  return 0.45;
}

function drawCellMarks(
  p: p5,
  cell: GridCell,
  cellPx: number,
  zoom: number,
  fade: number,
  dna: StyleDna | null,
) {
  const center = cellCenterMeters(cell.ix, cell.iy);
  const ox = center.east * METERS_TO_PX;
  const oy = -center.north * METERS_TO_PX;
  const half = cellPx * 0.5;
  const alpha = visitAlpha(cell.visitCount) * fade;
  const weight = visitStroke(cell.visitCount);
  const n = strokeCountForVisits(cell.visitCount);

  p.noFill();
  p.stroke(42, 42, 40, Math.floor(255 * alpha));
  p.strokeWeight(weight / zoom);

  for (let i = 0; i < n; i++) {
    const seed =
      ((cell.ix * 73856093) ^ (cell.iy * 19349663) ^ (i * 83492791)) >>> 0;

    if (dna) {
      const pts = generateStroke(dna, seed, half);
      if (pts.length < 2) continue;
      p.beginShape();
      p.noFill();
      for (const pt of pts) {
        p.vertex(ox + pt.x, oy + pt.y);
      }
      p.endShape();
    } else {
      // Fallback until Style DNA loads
      const rnd = (k: number) => {
        const t = Math.sin(seed * 0.0001 + k * 12.9898) * 43758.5453;
        return t - Math.floor(t);
      };
      p.beginShape();
      p.noFill();
      const steps = 12 + (seed % 20);
      let x = (rnd(1) - 0.5) * half;
      let y = (rnd(2) - 0.5) * half;
      let ang = rnd(3) * Math.PI * 2;
      for (let s = 0; s < steps; s++) {
        ang += (rnd(10 + s) - 0.5) * 0.8;
        x += Math.cos(ang) * (half * 0.08);
        y += Math.sin(ang) * (half * 0.08);
        p.vertex(ox + x, oy + y);
      }
      p.endShape();
    }
  }
}

export function ArchiveSketch({
  cells,
  mode,
  followIx,
  followIy,
  styleDna,
}: SketchProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    cells,
    mode,
    followIx,
    followIy,
    styleDna,
  });
  const fadesRef = useRef<Map<string, number>>(new Map());

  stateRef.current = { cells, mode, followIx, followIy, styleDna };

  useEffect(() => {
    for (const cell of cells) {
      if (!fadesRef.current.has(cell.key)) {
        fadesRef.current.set(cell.key, 0);
      }
    }
  }, [cells]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const cam: Cam = { x: 0, y: 0, zoom: 1 };
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const sketch = (p: p5) => {
      p.setup = () => {
        const c = p.createCanvas(host.clientWidth, host.clientHeight);
        c.parent(host);
        p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
        p.strokeCap(p.ROUND);
        p.strokeJoin(p.ROUND);
      };

      p.windowResized = () => {
        p.resizeCanvas(host.clientWidth, host.clientHeight);
      };

      p.draw = () => {
        const s = stateRef.current;
        p.background(PAPER);

        const cellPx = CELL_SIZE_M * METERS_TO_PX;
        const liveCell =
          s.followIx != null && s.followIy != null
            ? s.cells.find((c) => c.ix === s.followIx && c.iy === s.followIy)
            : undefined;

        if (s.mode === "live") {
          const targetZoom =
            (Math.min(p.width, p.height) * 0.78) / cellPx;
          cam.zoom += (targetZoom - cam.zoom) * 0.12;

          if (liveCell) {
            const c = cellCenterMeters(liveCell.ix, liveCell.iy);
            cam.x += (c.east * METERS_TO_PX - cam.x) * 0.18;
            cam.y += (-c.north * METERS_TO_PX - cam.y) * 0.18;
          }

          p.push();
          p.translate(p.width / 2, p.height / 2);
          p.scale(cam.zoom);
          p.translate(-cam.x, -cam.y);

          if (liveCell) {
            let fade = fadesRef.current.get(liveCell.key) ?? 0;
            fade = Math.min(1, fade + 0.06);
            fadesRef.current.set(liveCell.key, fade);
            drawCellMarks(p, liveCell, cellPx, cam.zoom, fade, s.styleDna);
          }

          p.pop();
          return;
        }

        p.push();
        p.translate(p.width / 2, p.height / 2);
        p.scale(cam.zoom);
        p.translate(-cam.x, -cam.y);

        for (const cell of s.cells) {
          let fade = fadesRef.current.get(cell.key) ?? 0;
          fade = Math.min(1, fade + 0.04);
          fadesRef.current.set(cell.key, fade);
          drawCellMarks(p, cell, cellPx, cam.zoom, fade, s.styleDna);
        }

        p.pop();
      };

      p.mousePressed = () => {
        if (stateRef.current.mode !== "archive") return;
        dragging = true;
        lastX = p.mouseX;
        lastY = p.mouseY;
      };

      p.mouseDragged = () => {
        if (!dragging || stateRef.current.mode !== "archive") return;
        cam.x -= (p.mouseX - lastX) / cam.zoom;
        cam.y -= (p.mouseY - lastY) / cam.zoom;
        lastX = p.mouseX;
        lastY = p.mouseY;
      };

      p.mouseReleased = () => {
        dragging = false;
      };

      p.touchStarted = () => {
        if (stateRef.current.mode !== "archive") return false;
        dragging = true;
        const t = p.touches[0] as { x: number; y: number } | undefined;
        lastX = t?.x ?? p.mouseX;
        lastY = t?.y ?? p.mouseY;
        return false;
      };

      p.touchMoved = () => {
        if (!dragging || stateRef.current.mode !== "archive") return false;
        const t = p.touches[0] as { x: number; y: number } | undefined;
        const x = t?.x ?? p.mouseX;
        const y = t?.y ?? p.mouseY;
        cam.x -= (x - lastX) / cam.zoom;
        cam.y -= (y - lastY) / cam.zoom;
        lastX = x;
        lastY = y;
        return false;
      };

      p.touchEnded = () => {
        dragging = false;
        return false;
      };

      p.mouseWheel = (event: WheelEvent) => {
        if (stateRef.current.mode !== "archive") return false;
        const factor = event.deltaY > 0 ? 0.92 : 1.08;
        cam.zoom = Math.min(4, Math.max(0.35, cam.zoom * factor));
        return false;
      };
    };

    const instance = new p5(sketch);
    return () => {
      instance.remove();
    };
  }, []);

  return <div ref={hostRef} className="absolute inset-0" />;
}
