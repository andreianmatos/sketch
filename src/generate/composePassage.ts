import type { Passage } from "./paperInk";
import {
  loadIcon,
  loadIndex,
  loadSource,
  pickPen,
  type IconSketch,
  type IconStroke,
  type LibUnit,
  type Pen,
} from "./knowledge";
import { Rng } from "./rng";

type Pt = [number, number];
type Look = { kind: string; opacity: number; grain: number; dry: number; bleed: number };
type Placed = {
  kind?: "form" | "stroke";
  fill?: boolean;
  fillColor?: [number, number, number];
  fillLook?: Look;
  fillStyle?: string;
  fillCover?: number;
  points: Pt[];
  widths?: number[];
  color: [number, number, number];
  width: number;
  closed?: boolean;
  pen?: string;
  look?: Look;
  source?: string;
  cx?: number;
  cy?: number;
  wasFill?: boolean;
  rawColor?: number[];
};

function clip(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function lum(c: number[]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

function chaikin(pts: Pt[], iters: number, closed: boolean): Pt[] {
  let cur = pts;
  for (let n = 0; n < iters; n++) {
    if (cur.length < 3) break;
    const next: Pt[] = [];
    const m = cur.length;
    const lim = closed ? m : m - 1;
    if (!closed) next.push(cur[0]!);
    for (let i = 0; i < lim; i++) {
      const a = cur[i]!;
      const b = cur[(i + 1) % m]!;
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) next.push(cur[m - 1]!);
    cur = next;
  }
  return cur;
}

function penLook(pen: Pen | null): Look {
  if (!pen) {
    return { kind: "ink", opacity: 0.78, grain: 0.28, dry: 0.16, bleed: 0.08 };
  }
  const name = String(pen.name || pen.kind || "ink");
  let kind = "ink";
  if (name.includes("charcoal")) kind = "charcoal";
  else if (name.includes("wash")) kind = "wash";
  else if (name.includes("graphite")) kind = "graphite";
  else if (name.includes("accent")) kind = "accent";
  return {
    kind,
    opacity: Number(pen.opacity) || 0.78,
    grain: Number(pen.grain) || 0.28,
    dry: Number(pen.dry) || 0.16,
    bleed: Number(pen.bleed) || 0.08,
  };
}

function jitterLook(look: Look, rng: Rng): Look {
  return {
    kind: look.kind,
    opacity: round3(clip(look.opacity + rng.gauss(0, 0.035), 0.3, 0.94)),
    grain: round3(clip(look.grain + rng.gauss(0, 0.04), 0.05, 0.95)),
    dry: round3(clip(look.dry + rng.gauss(0, 0.03), 0.02, 0.86)),
    bleed: round3(clip(look.bleed + rng.gauss(0, 0.025), 0.02, 0.66)),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function nearestPen(color: number[], widthRel: number, pens: Pen[]): Pen | null {
  if (!pens.length) return null;
  const wr = Math.log(Math.max(widthRel, 1e-4));
  const L = lum(color) / 255;
  let best: Pen | null = null;
  let bestD = 1e9;
  for (const p of pens) {
    const pc = p.color || [28, 26, 24];
    const plum = lum(pc) / 255;
    const pwr = Math.log(Math.max(Number(p.width_rel) || 0.05, 1e-4));
    const d = (L - plum) ** 2 * 2.4 + (wr - pwr) ** 2 * 1.5;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function rgb(c: number[]): [number, number, number] {
  return [(c[0] ?? 28) | 0, (c[1] ?? 26) | 0, (c[2] ?? 24) | 0];
}

function inkColor(color: number[], rng: Rng, kind: string | undefined): [number, number, number] {
  const r = color[0] | 0;
  const g = color[1] | 0;
  const b = color[2] | 0;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const L = lum([r, g, b]);
  const k = (kind || "").toLowerCase();
  if (k === "wash" || k === "graphite") {
    const warm = rng.int(-4, 6);
    return [
      clip(r + warm, 8, 210) | 0,
      clip(g + warm - 2, 8, 205) | 0,
      clip(b + warm - 4, 8, 200) | 0,
    ];
  }
  if (k === "accent" || (sat > 35 && rng.next() < 0.28)) {
    return [
      clip(r * 0.82 + 12, 0, 255) | 0,
      clip(g * 0.72 + 10, 0, 255) | 0,
      clip(b * 0.75 + 12, 0, 255) | 0,
    ];
  }
  if (sat > 35 || (L > 155 && k !== "wash" && k !== "graphite")) {
    const v = rng.int(12, 48);
    return [v, Math.max(0, v - 2), Math.max(0, v - 4)];
  }
  return [r, g, b];
}

function applyPen(
  n: number,
  pen: Pen | null,
  rng: Rng,
  novelty: number,
): { widths: number[]; lineW: number; color: number[]; look: Look } {
  const look = jitterLook(penLook(pen), rng);
  if (!pen) {
    const base = rng.uniform(1.6, 3.2);
    return { widths: Array(n).fill(base), lineW: base, color: [28, 26, 24], look };
  }
  const wr = Number(pen.width_rel) || 0.05;
  let base = 1.35 + Math.log1p(wr * 40) * 1.7;
  if (look.kind === "charcoal") base *= 1.12;
  if (look.kind === "wash") base *= 1.18;
  base *= 0.95 + novelty * 0.2;
  base = clip(base, 1.2, 7.4);
  const env = pen.envelope && pen.envelope.length ? pen.envelope : [1];
  const wobble = Number(pen.wobble) || 0.1;
  const noise = 1 + rng.gauss(0, 0.08 + wobble * 0.15);
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const j = t * (env.length - 1);
    const a = Math.floor(j);
    const b = Math.min(env.length - 1, a + 1);
    const f = j - a;
    const v = env[a]! * (1 - f) + env[b]! * f;
    const jitter = 1 + rng.gauss(0, 0.05 + wobble * 0.1);
    widths.push(Math.round(Math.max(0.8, base * v * noise * jitter) * 100) / 100);
  }
  const color = (pen.color || [28, 26, 24]).slice(0, 3).map((c) =>
    clip((c | 0) + rng.int(-10, 10), 0, 255),
  );
  const sorted = [...widths].sort((x, y) => x - y);
  return { widths, lineW: sorted[Math.floor(sorted.length / 2)]!, color, look };
}

function pickAnchor(
  rng: Rng,
  width: number,
  height: number,
  cx?: number,
  cy?: number,
): Pt {
  const fresh = (): Pt => {
    const mode = rng.next();
    let ax: number;
    let ay: number;
    if (mode < 0.28) {
      ax = width * rng.pick([0.07, 0.12, 0.22, 0.78, 0.88, 0.93]);
      ay = height * rng.pick([0.07, 0.14, 0.28, 0.72, 0.86, 0.93]);
      ax += rng.gauss(0, width * 0.03);
      ay += rng.gauss(0, height * 0.03);
    } else if (mode < 0.55) {
      ax = width * rng.uniform(0.05, 0.95);
      ay = height * rng.uniform(0.05, 0.95);
    } else if (mode < 0.78) {
      const ang = rng.uniform(0, Math.PI * 2);
      const rad = Math.min(width, height) * rng.uniform(0.12, 0.48);
      ax = width * 0.5 + Math.cos(ang) * rad;
      ay = height * 0.5 + Math.sin(ang) * rad;
    } else {
      ax = width * rng.uniform(0.08, 0.92);
      ay = height * rng.uniform(0.08, 0.92);
    }
    return [ax, ay];
  };
  let ax: number;
  let ay: number;
  if (cx != null && cy != null) {
    const u = rng.next();
    if (u < 0.48) {
      ax = cx + rng.gauss(0, width * 0.13);
      ay = cy + rng.gauss(0, height * 0.13);
    } else if (u < 0.78) {
      const ang = rng.uniform(0, Math.PI * 2);
      const dist = Math.min(width, height) * rng.uniform(0.16, 0.4);
      ax = cx + Math.cos(ang) * dist;
      ay = cy + Math.sin(ang) * dist;
    } else {
      [ax, ay] = fresh();
    }
  } else {
    [ax, ay] = fresh();
  }
  return [clip(ax, width * 0.04, width * 0.96), clip(ay, height * 0.04, height * 0.96)];
}

function clusterAround(units: LibUnit[], seed: LibUnit, maxN: number, radius: number): LibUnit[] {
  const sx = Number(seed.page_x) || 0.5;
  const sy = Number(seed.page_y) || 0.5;
  const scored: { d: number; u: LibUnit }[] = [];
  for (const u of units) {
    const dx = (Number(u.page_x) || 0.5) - sx;
    const dy = (Number(u.page_y) || 0.5) - sy;
    const d = Math.hypot(dx, dy);
    if (d <= radius) scored.push({ d, u });
  }
  scored.sort((a, b) => a.d - b.d);
  const picked = [seed];
  for (const { u } of scored) {
    if (u === seed) continue;
    picked.push(u);
    if (picked.length >= maxN) break;
  }
  return picked;
}

function rot2(pts: Pt[], c: number, s: number): Pt[] {
  return pts.map(([x, y]) => [x * c + y * -s, x * s + y * c] as Pt);
}

function placeLibraryCluster(
  cluster: LibUnit[],
  width: number,
  height: number,
  novelty: number,
  rng: Rng,
  pens: Pen[],
  anchor: Pt,
  fillAmount: number,
): Placed[] {
  if (!cluster.length) return [];
  const all: Pt[] = [];
  for (const u of cluster) {
    const pp = u.page_points;
    if (pp && pp.length) for (const p of pp) all.push([p[0], p[1]]);
    else all.push([Number(u.page_x) || 0.5, Number(u.page_y) || 0.5]);
  }
  let minX = Math.min(...all.map((p) => p[0]));
  let maxX = Math.max(...all.map((p) => p[0]));
  let minY = Math.min(...all.map((p) => p[1]));
  let maxY = Math.max(...all.map((p) => p[1]));
  minX = Math.max(0, minX - 0.015);
  minY = Math.max(0, minY - 0.015);
  maxX = Math.min(1, maxX + 0.015);
  maxY = Math.min(1, maxY + 0.015);
  const winW = Math.max(maxX - minX, 0.06);
  const winH = Math.max(maxY - minY, 0.06);
  const cxp = (minX + maxX) * 0.5;
  const cyp = (minY + maxY) * 0.5;
  const margin = 0.02;
  const availW = width * (1 - 2 * margin);
  const availH = height * (1 - 2 * margin);
  const cover = 0.72 + rng.uniform(0, 0.45) + novelty * 0.08;
  const fit = Math.min(availW / winW, availH / winH) * Math.min(cover, 1.35);
  const zoom = fit * (0.92 + rng.uniform(-0.06, 0.14));
  const angle = rng.uniform(-0.18, 0.18) * (0.4 + novelty);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let tx = clip(anchor[0], width * 0.06, width * 0.94);
  let ty = clip(anchor[1], height * 0.06, height * 0.94);

  const placed: Placed[] = [];
  for (const u of cluster) {
    const pp = u.page_points;
    let world: Pt[];
    const sizeRef = Math.max((Number(u.page_s) || 0.04) * zoom, 14);
    if (pp && pp.length >= 2) {
      const local = pp.map(([x, y]) => [(x - cxp) * zoom, (y - cyp) * zoom] as Pt);
      world = rot2(local, c, s).map(([x, y]) => [x + tx, y + ty] as Pt);
    } else {
      const pts = u.points;
      if (!pts || pts.length < 2) continue;
      const local = pts.map(([x, y]) => [x * sizeRef, y * sizeRef] as Pt);
      const ox = ((Number(u.page_x) || 0.5) - cxp) * zoom;
      const oy = ((Number(u.page_y) || 0.5) - cyp) * zoom;
      world = rot2(local, c, s).map(([x, y]) => [x + tx + ox, y + ty + oy] as Pt);
    }
    const xs = world.map((p) => p[0]);
    const ys = world.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (span < Math.min(width, height) * 0.022) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    if (mx < -80 || mx > width + 80 || my < -80 || my > height + 80) continue;

    const kind = u._kind || "stroke";
    const closed =
      Boolean(u.closed) || Boolean(u.fill) || (kind === "form" && (Number(u.compact) || 0) > 0.035);
    const isForm = kind === "form" || Boolean(u.fill) || closed;
    world = chaikin(world, isForm ? 2 : 1, closed);
    const wr = Number(u.width_rel) || 0.08;
    const lineW = clip(wr * sizeRef * (isForm ? 0.45 : 0.32), 1.5, 5.5);
    const rel = u.widths || [wr];
    let widths = rel.map((x) =>
      clip(Number(x) * sizeRef * (isForm ? 0.4 : 0.3) * 0.5 + lineW * 0.5, 1.4, 5.5),
    );
    while (widths.length < world.length) widths.push(widths[widths.length - 1]!);
    if (widths.length !== world.length) {
      const src = widths;
      widths = world.map((_, i) => {
        const t = world.length <= 1 ? 0 : i / (world.length - 1);
        const j = t * (src.length - 1);
        return src[Math.round(j)]!;
      });
    }
    let rawColor = u.color && u.color.length >= 3 ? u.color.slice(0, 3).map((v) => v | 0) : [28, 26, 24];
    const pen = nearestPen(rawColor, wr, pens);
    const look = jitterLook(pen ? penLook(pen) : penLook(null), rng);
    const color = inkColor(rawColor, rng, look.kind);
    placed.push({
      kind: isForm ? "form" : "stroke",
      fill: false,
      wasFill: Boolean(u.fill),
      rawColor,
      points: world.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt),
      widths: widths.map((w) => Math.round(w * 100) / 100),
      color: rgb(color),
      width: Math.round(lineW * 100) / 100,
      closed,
      source: u.source,
      pen: pen?.name,
      look,
      cx: Math.round(world[world.length - 1]![0] * 100) / 100,
      cy: Math.round(world[world.length - 1]![1] * 100) / 100,
    });
  }
  placed.sort((a, b) => {
    const pa = a.points[0];
    const pb = b.points[0];
    return (pa ? pa[0] + pa[1] : 0) - (pb ? pb[0] + pb[1] : 0);
  });
  assignFills(placed, rng, false, width, height, fillAmount);
  return placed;
}

function shoelace(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i]![0] * pts[j]![1] - pts[j]![0] * pts[i]![1];
  }
  return Math.abs(a) * 0.5;
}

function pathLen(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    n += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return n;
}

function assignFills(
  placed: Placed[],
  rng: Rng,
  prefer: boolean,
  width: number,
  height: number,
  fillAmount: number,
): void {
  const chance = clip(fillAmount, 0, 1);
  if (chance <= 0.001) return;
  const page = width * height;
  const candidates: { area: number; i: number; srcFill: boolean }[] = [];
  placed.forEach((u, i) => {
    const pts = u.points;
    if (pts.length < 4) return;
    const srcFill = Boolean(u.wasFill);
    const closed = Boolean(u.closed || srcFill);
    if (!closed) return;
    const area = shoelace(pts);
    if (area < 900 || area > page * 0.18) return;
    const peri = pathLen(pts);
    const compact = peri < 1 ? 0 : (4 * Math.PI * area) / (peri * peri + 1e-6);
    if (compact < 0.14 && !srcFill) return;
    candidates.push({ area, i, srcFill });
  });
  if (!candidates.length) return;
  if (rng.next() > chance * (prefer ? 0.9 : 0.48)) return;
  candidates.sort((a, b) => b.area - a.area);
  const nPick = candidates.length > 2 && rng.next() < 0.18 ? 2 : 1;
  const styles = ["airbrush", "mist", "blob", "full"] as const;
  const weights = [0.46, 0.24, 0.18, 0.12];
  for (const c of candidates.slice(0, nPick)) {
    const u = placed[c.i]!;
    const outline = (u.color || [28, 26, 24]).slice(0, 3);
    const raw = u.rawColor || outline;
    const fc =
      c.srcFill && Math.max(...raw) - Math.min(...raw) > 22
        ? raw.slice(0, 3)
        : outline.map((v) => clip(v * 0.7 + 40, 0, 255) | 0);
    const style = rng.choice([...styles], weights);
    u.fill = true;
    u.fillStyle = style;
    u.fillColor = fc as [number, number, number];
    u.fillLook = {
      kind: style !== "full" ? "airbrush" : "wash",
      opacity: round3(rng.uniform(0.16, style !== "full" ? 0.58 : 0.72)),
      grain: round3(rng.uniform(0.08, 0.45)),
      dry: round3(rng.uniform(0.12, 0.62)),
      bleed: round3(rng.uniform(0.22, 0.7)),
    };
    u.fillCover = round3(rng.uniform(0.22, 0.85));
  }
}

function strokePagePts(stroke: IconStroke): Pt[] | null {
  const pp = stroke.page_points;
  if (pp && pp.length >= 2) return pp.map((p) => [p[0], p[1]] as Pt);
  const pts = stroke.points;
  if (!pts || pts.length < 2) return null;
  const px = Number(stroke.page_x) || 0.5;
  const py = Number(stroke.page_y) || 0.5;
  const ps = Number(stroke.page_s) || 0.08;
  return pts.map(([x, y]) => [x * ps + px, y * ps + py] as Pt);
}

function mostStemlike(strokes: IconStroke[]): IconStroke | null {
  let best: IconStroke | null = null;
  let score = -1;
  for (const s of strokes) {
    const pts = strokePagePts(s);
    if (!pts || pts.length < 2) continue;
    const ys = pts.map((p) => p[1]);
    const xs = pts.map((p) => p[0]);
    const dy = Math.max(...ys) - Math.min(...ys);
    const dx = Math.max(...xs) - Math.min(...xs);
    const length = Number(s.page_len) || 0;
    const sc = (dy / (dx + 1e-4)) * (0.35 + length);
    if (sc > score) {
      score = sc;
      best = s;
    }
  }
  return best;
}

function graftBloom(base: IconStroke[], donor: IconStroke[]): IconStroke[] {
  const stem = mostStemlike(base);
  const donorStem = mostStemlike(donor);
  if (!stem) return base;
  const bloom = donor.filter((s) => s !== donorStem);
  if (!bloom.length) return base;
  const stemPts = strokePagePts(stem);
  if (!stemPts) return base;
  const tip = stemPts.reduce((a, b) => (b[1] < a[1] ? b : a));
  const bloomPts: Pt[] = [];
  for (const s of bloom) {
    const pts = strokePagePts(s);
    if (pts) bloomPts.push(...pts);
  }
  if (!bloomPts.length) return base;
  const cx = bloomPts.reduce((a, p) => a + p[0], 0) / bloomPts.length;
  const cy = bloomPts.reduce((a, p) => a + p[1], 0) / bloomPts.length;
  const stemSpan = Math.max(...stemPts.map((p) => p[1])) - Math.min(...stemPts.map((p) => p[1]));
  const bxs = bloomPts.map((p) => p[0]);
  const bys = bloomPts.map((p) => p[1]);
  const bloomSpan = Math.max(Math.max(...bys) - Math.min(...bys), Math.max(...bxs) - Math.min(...bxs), 1e-4);
  const scale = clip((stemSpan * 0.85) / bloomSpan, 0.45, 1.6);
  const grafted: IconStroke[] = [stem];
  for (const s of bloom) {
    const pts = strokePagePts(s);
    if (!pts) continue;
    grafted.push({
      ...s,
      page_points: pts.map(([x, y]) => [(x - cx) * scale + tip[0], (y - cy) * scale + tip[1]] as Pt),
    });
  }
  return grafted;
}

function handJitter(pts: Pt[], rng: Rng, amount: number): Pt[] {
  if (amount <= 0.002 || pts.length < 3) return pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const phX = rng.uniform(0, Math.PI * 2);
  const phY = rng.uniform(0, Math.PI * 2);
  const fx = rng.uniform(0.7, 1.7);
  const fy = rng.uniform(0.7, 1.7);
  return pts.map((p, i) => {
    const t = (i / pts.length) * 2 * Math.PI;
    return [p[0] + Math.sin(t * fx + phX) * span * amount, p[1] + Math.sin(t * fy + phY) * span * amount] as Pt;
  });
}

function motifSize(rng: Rng, width: number, height: number, novelty: number): number {
  const m = Math.min(width, height);
  const u = rng.next();
  let frac: number;
  if (u < 0.08) frac = rng.uniform(0.82, 1.28);
  else if (u < 0.2) frac = rng.uniform(0.52, 0.78);
  else frac = 0.2 + rng.uniform(0, 0.24) + novelty * 0.08;
  return m * frac;
}

function anchorForSize(
  rng: Rng,
  width: number,
  height: number,
  ax: number,
  ay: number,
  size: number,
): Pt {
  const m = Math.min(width, height);
  if (size < m * 0.5) return [ax, ay];
  if (rng.next() < 0.55) {
    ax = ax * 0.38 + width * 0.5 * 0.62;
    ay = ay * 0.38 + height * 0.5 * 0.62;
  }
  return [clip(ax, width * 0.06, width * 0.94), clip(ay, height * 0.06, height * 0.94)];
}

function placeIconStrokes(
  strokes: IconStroke[],
  width: number,
  height: number,
  novelty: number,
  rng: Rng,
  pens: Pen[],
  anchor: Pt,
  size: number,
  angle: number,
  label: string,
  fillAmount: number,
): Placed[] {
  const kept: { src: IconStroke; pts: Pt[] }[] = [];
  for (const s of strokes) {
    const pts = strokePagePts(s);
    if (pts && pts.length >= 2) kept.push({ src: s, pts });
  }
  if (!kept.length) return [];
  const all = kept.flatMap((k) => k.pts);
  const cxp = all.reduce((a, p) => a + p[0], 0) / all.length;
  const cyp = all.reduce((a, p) => a + p[1], 0) / all.length;
  const span = Math.max(
    Math.max(...all.map((p) => p[0])) - Math.min(...all.map((p) => p[0])),
    Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[1])),
    1e-4,
  );
  const scale = size / span;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const jitter = 0.012 + novelty * 0.05;
  const charcoal = pens.find((p) => String(p.name || "").includes("charcoal")) || null;
  const placed: Placed[] = [];
  for (const { src, pts } of kept) {
    let world = rot2(
      pts.map(([x, y]) => [(x - cxp) * scale, (y - cyp) * scale] as Pt),
      c,
      s,
    ).map(([x, y]) => [x + anchor[0], y + anchor[1]] as Pt);
    world = handJitter(world, rng, jitter);
    world = chaikin(world, 1, Boolean(src.closed));
    if (world.length < 2) continue;
    let pen = pickPen(rng, pens);
    if (pen && String(pen.name || "").includes("wash") && charcoal) pen = charcoal;
    const applied = applyPen(world.length, pen, rng, novelty);
    const sizeBoost = clip(size / Math.max(Math.min(width, height), 1), 0.18, 1.25);
    const thick = 0.92 + sizeBoost * 0.42;
    const lineW = clip(applied.lineW * 0.96 * thick, 1.6, 8.8);
    const widths = applied.widths.map((w) => clip(w * 0.96 * thick, 1.3, 9.2));
    const color = inkColor(applied.color, rng, applied.look.kind);
    const closed = Boolean(src.closed || src.fill);
    const isForm = src.kind === "form" || closed;
    placed.push({
      kind: isForm ? "form" : "stroke",
      fill: false,
      points: world.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt),
      widths: widths.map((w) => Math.round(w * 100) / 100),
      color: rgb(color),
      width: Math.round(lineW * 100) / 100,
      closed,
      source: `icon:${label}`,
      pen: pen?.name,
      look: applied.look,
      cx: Math.round(world[world.length - 1]![0] * 100) / 100,
      cy: Math.round(world[world.length - 1]![1] * 100) / 100,
    });
  }
  assignFills(placed, rng, true, width, height, fillAmount);
  return placed;
}

async function libraryPassage(opts: {
  width: number;
  height: number;
  novelty: number;
  seed: number;
  preferSource?: string | null;
  cx?: number;
  cy?: number;
  fillAmount: number;
}): Promise<Passage> {
  const idx = await loadIndex();
  const rng = new Rng(opts.seed);
  const sources = idx.sources.filter((s) => s.n >= 3);
  const pool = sources.length ? sources : idx.sources;
  let meta = pool[0];
  if (opts.preferSource && rng.next() < 0.35) {
    meta = pool.find((s) => s.id === opts.preferSource) || meta;
  } else {
    meta = rng.choice(pool, pool.map((s) => s.weight));
  }
  const units = await loadSource(meta.file);
  if (!units.length) {
    return { kind: "passage", source: meta.id, units: [], cx: opts.width / 2, cy: opts.height / 2 };
  }
  const weights = units.map((u) => {
    const col = u.color || [40, 40, 38];
    const L = lum(col);
    const sat = Math.max(...col) - Math.min(...col);
    return Math.max(
      0.05,
      0.3 +
        (Number(u.length) || 0.1) +
        (Number(u.page_len) || 0) * 0.4 +
        (L < 70 ? 1.5 : 0) +
        (sat < 25 ? 1 : 0) -
        (sat > 60 ? 0.7 : 0) +
        (u._kind === "stroke" ? 0.6 : 0.2),
    );
  });
  const seedU = rng.choice(units, weights);
  const radius = 0.32 + opts.novelty * 0.2;
  const nMarks = rng.int(8, 18) + Math.floor(opts.novelty * 5);
  const cluster = clusterAround(units, seedU, nMarks, radius);
  const [ax, ay] = pickAnchor(rng, opts.width, opts.height, opts.cx, opts.cy);
  const placed = placeLibraryCluster(
    cluster,
    opts.width,
    opts.height,
    opts.novelty,
    rng,
    idx.pens,
    [ax, ay],
    opts.fillAmount,
  );
  const last = placed[placed.length - 1];
  return {
    kind: "passage",
    source: meta.id,
    units: placed,
    cx: last?.cx ?? ax,
    cy: last?.cy ?? ay,
  };
}

async function iconPassage(opts: {
  label: string;
  width: number;
  height: number;
  novelty: number;
  seed: number;
  cx?: number;
  cy?: number;
  fillAmount: number;
}): Promise<Passage | null> {
  const sketches = (await loadIcon(opts.label)).filter((sk) => {
    const n = sk.strokes?.length || 0;
    const pts = (sk.strokes || []).reduce(
      (a, s) => a + (s.page_points?.length || s.points?.length || 0),
      0,
    );
    return n >= 1 && pts >= 12;
  });
  if (!sketches.length) return null;
  const rng = new Rng(opts.seed);
  const idx = await loadIndex();
  const rich = sketches.filter((sk) => (sk.n_strokes || sk.strokes.length) >= 2);
  let sketch: IconSketch = rng.choice(rich.length && rng.next() < 0.88 ? rich : sketches);
  let strokes = [...sketch.strokes];
  if (opts.novelty > 0.35 && sketches.length > 1 && rng.next() < Math.min(0.7, 0.25 + opts.novelty)) {
    const donor = rng.choice(sketches.filter((s) => s !== sketch).length ? sketches.filter((s) => s !== sketch) : sketches);
    strokes = graftBloom(strokes, [...donor.strokes]);
  }
  let [ax, ay] = pickAnchor(rng, opts.width, opts.height, opts.cx, opts.cy);
  const nMarks = 1 + (opts.novelty > 0.5 && rng.next() < 0.35 ? 1 : 0);
  const placed: Placed[] = [];
  let cursor: Pt = [ax, ay];
  for (let i = 0; i < nMarks; i++) {
    if (i > 0) {
      sketch = rng.choice(sketches);
      strokes = [...(sketch.strokes || [])];
      cursor = [
        clip(cursor[0] + rng.gauss(0, opts.width * 0.28), opts.width * 0.05, opts.width * 0.95),
        clip(cursor[1] + rng.gauss(0, opts.height * 0.28), opts.height * 0.05, opts.height * 0.95),
      ];
    }
    let size = motifSize(rng, opts.width, opts.height, opts.novelty);
    if (i > 0) size *= 0.62;
    cursor = anchorForSize(rng, opts.width, opts.height, cursor[0], cursor[1], size);
    const angle = rng.uniform(-0.22, 0.22) * (0.45 + opts.novelty);
    const units = placeIconStrokes(
      strokes,
      opts.width,
      opts.height,
      opts.novelty,
      rng,
      idx.pens,
      cursor,
      size,
      angle,
      opts.label,
      opts.fillAmount,
    );
    if (units.length) {
      placed.push(...units);
      const last = units[units.length - 1]!;
      cursor = [last.cx ?? cursor[0], last.cy ?? cursor[1]];
    }
  }
  if (!placed.length) return null;
  const last = placed[placed.length - 1]!;
  return {
    kind: "passage",
    source: `icon:${opts.label}`,
    units: placed,
    cx: last.cx ?? ax,
    cy: last.cy ?? ay,
  };
}

export type ComposeOpts = {
  width: number;
  height: number;
  novelty: number;
  seed: number;
  mode: "vibe" | "icon" | "mix";
  icon?: string;
  fill: number;
  source?: string | null;
  cx?: number;
  cy?: number;
};

export async function composePassage(opts: ComposeOpts): Promise<Passage> {
  const idx = await loadIndex();
  const rng = new Rng(opts.seed);
  const label =
    opts.icon && idx.icons.includes(opts.icon) ? opts.icon : idx.icons[0] || undefined;
  const mode = opts.mode === "icon" || opts.mode === "mix" ? opts.mode : "vibe";

  const vibe = () =>
    libraryPassage({
      width: opts.width,
      height: opts.height,
      novelty: opts.novelty,
      seed: opts.seed,
      preferSource: opts.source,
      cx: opts.cx,
      cy: opts.cy,
      fillAmount: opts.fill,
    });

  if (mode === "icon" && label) {
    const got = await iconPassage({
      label,
      width: opts.width,
      height: opts.height,
      novelty: opts.novelty,
      seed: opts.seed,
      cx: opts.cx,
      cy: opts.cy,
      fillAmount: opts.fill,
    });
    if (got?.units.length) return got;
  }

  if (mode === "mix" && label && rng.next() < 0.62 + opts.novelty * 0.25) {
    const got = await iconPassage({
      label,
      width: opts.width,
      height: opts.height,
      novelty: opts.novelty,
      seed: opts.seed,
      cx: opts.cx,
      cy: opts.cy,
      fillAmount: opts.fill,
    });
    if (got?.units.length) {
      if (rng.next() < 0.4) {
        const lib = await libraryPassage({
          width: opts.width,
          height: opts.height,
          novelty: Math.max(0.05, opts.novelty * 0.4),
          seed: opts.seed + 19,
          preferSource: opts.source,
          cx: got.cx,
          cy: got.cy,
          fillAmount: opts.fill,
        });
        if (lib.units.length) got.units.push(...lib.units.slice(0, 3));
      }
      return got;
    }
  }

  return vibe();
}
