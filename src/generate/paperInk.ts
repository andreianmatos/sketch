export const PAPER = "#f6f3ee";

type Look = {
  kind?: "charcoal" | "graphite" | "wash" | "ink" | "accent" | string;
  opacity?: number;
  grain?: number;
  dry?: number;
  bleed?: number;
};

type Unit = {
  kind?: "form" | "stroke";
  fill?: boolean;
  fillColor?: [number, number, number];
  fillLook?: Look;
  fillStyle?: "airbrush" | "mist" | "blob" | "full" | string;
  fillCover?: number;
  points: [number, number][];
  widths?: number[];
  color: [number, number, number];
  width: number;
  closed?: boolean;
  pen?: string;
  look?: Look;
};

export type Passage = {
  kind: "passage";
  source?: string;
  units: Unit[];
  cx: number;
  cy: number;
};

function densify(
  pts: [number, number][],
  widths: number[],
  maxGap: number,
): { pts: [number, number][]; widths: number[] } {
  const outP: [number, number][] = [pts[0]];
  const outW: number[] = [widths[0] ?? 3];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = outP[outP.length - 1];
    const [x1, y1] = pts[i];
    const w0 = outW[outW.length - 1];
    const w1 = widths[Math.min(i, widths.length - 1)] ?? w0;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(dist / maxGap));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      outP.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      outW.push(w0 + (w1 - w0) * t);
    }
  }
  return { pts: outP, widths: outW };
}

/** Chaikin corner-cutting — softens polygon jag without inventing new shapes. */
function chaikin(
  pts: [number, number][],
  iters = 2,
  closed = false,
): [number, number][] {
  let cur = pts;
  for (let n = 0; n < iters; n++) {
    if (cur.length < 3) break;
    const next: [number, number][] = [];
    const m = cur.length;
    const lim = closed ? m : m - 1;
    if (!closed) next.push(cur[0]);
    for (let i = 0; i < lim; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % m];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) next.push(cur[m - 1]);
    cur = next;
  }
  return cur;
}

function movingAvgWidth(widths: number[], win = 5): number[] {
  const half = Math.floor(win / 2);
  return widths.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= widths.length) continue;
      s += widths[j];
      c += 1;
    }
    return s / c;
  });
}

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

export type Timing = {
  speed: number;
  drift: number;
  fade: number;
  rewind?: boolean;
  stop?: () => boolean;
  afterStamp?: () => void;
};

/** Slider 0 = crawl, 1 = dump the stroke this frame. */
export function stampRate(speed: number): number {
  const t = Math.max(0, Math.min(1, speed));
  if (t >= 0.96) return Infinity;
  const perFrame = Math.max(1, Math.pow(t, 1.35) * 92);
  return perFrame * 60;
}

function stampsThisFrame(
  speed: number,
  remaining: number,
  rewind = false,
): { n: number; delay: number } {
  const t = Math.max(0, Math.min(1, speed));
  if (rewind) {
    const n = Math.max(1, Math.round(1 + t * 5));
    const delay = 10 + (1 - t) * 32;
    return { n: Math.min(remaining, n), delay };
  }
  if (t >= 0.96) return { n: remaining, delay: 0 };
  if (t <= 0.02) return { n: 1, delay: 55 };
  const n = Math.max(1, Math.round(Math.pow(t, 1.35) * 92));
  const delay = t < 0.18 ? (0.18 - t) * 220 : 0;
  return { n: Math.min(remaining, n), delay };
}

/** Stamp as many points as this frame's speed budget allows. */
function animateStamps(
  count: number,
  stamp: (i: number) => void,
  timing: Timing,
  startAt = 0,
): Promise<void> {
  return new Promise((resolve) => {
    let i = startAt;
    const tick = () => {
      if (timing.stop?.()) {
        resolve();
        return;
      }
      const t = Math.max(0, Math.min(1, timing.speed));
      const drift = Math.max(0, Math.min(1, timing.drift));
      if (i >= count) {
        resolve();
        return;
      }
      const { n, delay } = stampsThisFrame(t, count - i, Boolean(timing.rewind));
      const end = i + n;
      for (; i < end; i++) stamp(i);
      timing.afterStamp?.();
      if (i >= count) {
        resolve();
        return;
      }
      let wait = delay;
      if (drift > 0.08 && hash01(i * 0.37 + count) < drift * 0.18) {
        wait += (40 + hash01(i * 1.1) * 220) * drift;
      }
      if (wait > 8) window.setTimeout(() => requestAnimationFrame(tick), wait);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

type InkMark = { x: number; y: number; size: number };
export type RecordedStroke = {
  marks: InkMark[];
  layer: HTMLCanvasElement;
  ox: number;
  oy: number;
};
export type RecordedDrawing = {
  strokes: RecordedStroke[];
  at: number;
};

export type LayerBlit = {
  canvas: HTMLCanvasElement;
  x?: number;
  y?: number;
};

export function makeLayer(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function freezeStroke(
  src: HTMLCanvasElement,
  marks: InkMark[],
): RecordedStroke | null {
  if (marks.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of marks) {
    const r = Math.max(4, m.size * 0.85);
    if (m.x - r < minX) minX = m.x - r;
    if (m.y - r < minY) minY = m.y - r;
    if (m.x + r > maxX) maxX = m.x + r;
    if (m.y + r > maxY) maxY = m.y + r;
  }
  minX = Math.floor(Math.max(0, minX - 2));
  minY = Math.floor(Math.max(0, minY - 2));
  maxX = Math.ceil(Math.min(src.width, maxX + 2));
  maxY = Math.ceil(Math.min(src.height, maxY + 2));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const layer = makeLayer(w, h);
  const ctx = layer.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, minX, minY, w, h, 0, 0, w, h);
  return { marks, layer, ox: minX, oy: minY };
}

/** Keep a frozen stroke when the page size changes (rotate, window, dpr). */
export function scaleStroke(
  stroke: RecordedStroke,
  sx: number,
  sy: number,
): RecordedStroke {
  const avg = (Math.abs(sx) + Math.abs(sy)) / 2;
  const nw = Math.max(1, Math.round(stroke.layer.width * sx));
  const nh = Math.max(1, Math.round(stroke.layer.height * sy));
  const layer = makeLayer(nw, nh);
  const ctx = layer.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(stroke.layer, 0, 0, nw, nh);
  }
  return {
    marks: stroke.marks.map((m) => ({
      x: m.x * sx,
      y: m.y * sy,
      size: m.size * avg,
    })),
    layer,
    ox: stroke.ox * sx,
    oy: stroke.oy * sy,
  };
}

export function scaleCanvas(
  src: HTMLCanvasElement,
  w: number,
  h: number,
): HTMLCanvasElement {
  const next = makeLayer(w, h);
  const ctx = next.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, w, h);
  }
  return next;
}

export function presentPage(
  display: HTMLCanvasElement,
  paper: HTMLCanvasElement,
  layers: LayerBlit[],
) {
  const ctx = display.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, display.width, display.height);
  ctx.drawImage(paper, 0, 0, display.width, display.height);
  ctx.globalCompositeOperation = "multiply";
  for (const L of layers) ctx.drawImage(L.canvas, L.x ?? 0, L.y ?? 0);
  ctx.globalCompositeOperation = "source-over";
}

export type InkBreath = {
  want: number;
  nextMood: number;
};

function clamp01(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Slider trade-off: 0 keeps a full page, 1 prefers mostly empty. */
export function preferLoad(fade: number): number {
  return 0.9 - clamp01(fade) * 0.82;
}

/** How covered the page is right now (0 empty → 1 packed, ~8 drawings). */
export function pageLoad(
  archive: RecordedDrawing[],
  extra: RecordedStroke[] = [],
): number {
  let drawings = archive.length;
  let marks = 0;
  for (const d of archive) {
    for (const s of d.strokes) marks += s.marks.length;
  }
  for (const s of extra) marks += s.marks.length;
  if (extra.length) drawings += 1;
  return Math.min(1.15, 0.72 * (drawings / 8) + 0.28 * (marks / 5000));
}

export function makeInkBreath(fade: number): InkBreath {
  const prefer = preferLoad(fade);
  return {
    want: clamp01(prefer + (Math.random() - 0.5) * 0.12, 0.08, 0.92),
    nextMood: Date.now() + 14000 + Math.random() * 18000,
  };
}

/** Hold a fullness mood long enough to see: packed, sparse, or near the slider. */
export function tickBreath(breath: InkBreath, fade: number, now = Date.now()): number {
  if (now < breath.nextMood) return breath.want;
  const prefer = preferLoad(fade);
  const t = clamp01(fade);
  const emptyP = 0.1 + t * 0.22;
  const packedP = 0.1 + (1 - t) * 0.22;
  const u = Math.random();
  if (u < emptyP) breath.want = 0.04 + Math.random() * 0.1;
  else if (u < emptyP + packedP) breath.want = 0.78 + Math.random() * 0.18;
  else breath.want = clamp01(prefer + (Math.random() - 0.5) * 0.16, 0.06, 0.94);
  breath.nextMood = now + 18000 + Math.random() * 32000;
  return breath.want;
}

function expWait(mean: number, lo: number, hi: number): number {
  const u = Math.max(0.02, Math.random());
  return Math.max(lo, Math.min(hi, -Math.log(u) * mean));
}

/**
 * Wait until the next rewind. Error vs want drives the rate — the slider
 * already chose `want`, so fade is not applied again here.
 */
export function nextUndrawWait(fade: number, load: number, want: number): number {
  if (fade <= 0.001) return 400;
  const err = load - want;
  let mean = 1200;
  if (err > 0.28) mean = 160;
  else if (err > 0.12) mean = 420;
  else if (err > 0.02) mean = 900;
  else if (err > -0.1) mean = 2800;
  else if (err > -0.24) mean = 8000;
  else mean = 18000;
  return expWait(mean, 90, 28000);
}

/** Hands pause before a new passage when the page is fuller than we want. */
export function nextDrawWait(fade: number, load: number, want: number): number {
  if (fade <= 0.001) return 0;
  const err = load - want;
  if (err <= 0.04) return 0;
  if (err > 0.28) return expWait(2200, 800, 5000);
  if (err > 0.14) return expWait(900, 280, 2200);
  return expWait(280, 80, 700);
}

export function undrawBurst(load: number, want: number): number {
  const err = load - want;
  if (err > 0.32) return 2 + Math.floor(Math.random() * 3);
  if (err > 0.16) return 1 + Math.floor(Math.random() * 2);
  if (err > 0.06 && Math.random() < 0.3) return 2;
  return 1;
}

export function undrawMinAge(load: number, want: number): number {
  const err = load - want;
  if (err > 0.22) return 450;
  if (err > 0.06) return 1100;
  return 2400;
}

function pickAgedDrawing(archive: RecordedDrawing[], minAgeMs: number): number {
  const now = Date.now();
  const eligible: number[] = [];
  for (let i = 0; i < archive.length; i++) {
    if (now - archive[i].at >= minAgeMs) eligible.push(i);
  }
  if (!eligible.length) return -1;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

async function undrawStroke(
  stroke: RecordedStroke,
  timing: Timing,
): Promise<void> {
  const marks = stroke.marks;
  if (marks.length < 2) return;
  const ctx = stroke.layer.getContext("2d");
  if (!ctx) return;
  await animateStamps(marks.length, (i) => {
    const m = marks[marks.length - 1 - i];
    punchDab(ctx, m.x - stroke.ox, m.y - stroke.oy, m.size * 1.12);
  }, timing);
}

export async function undrawDrawing(
  archive: RecordedDrawing[],
  timing: Timing,
  onLift: (drawing: RecordedDrawing) => void,
  onDone: () => void,
  minAgeMs = 2200,
): Promise<boolean> {
  const idx = pickAgedDrawing(archive, minAgeMs);
  if (idx < 0) return false;
  const drawing = archive.splice(idx, 1)[0];
  onLift(drawing);
  for (let s = drawing.strokes.length - 1; s >= 0; s--) {
    if (timing.stop?.()) break;
    await undrawStroke(drawing.strokes[s], timing);
  }
  onDone();
  return true;
}

type PenLook = {
  kind: string;
  opacity: number;
  grain: number;
  dry: number;
  bleed: number;
};

function resolveLook(unit: Unit): PenLook {
  const L = unit.look || {};
  const name = (unit.pen || "").toLowerCase();
  let kind = L.kind || "ink";
  if (!L.kind) {
    if (name.includes("charcoal")) kind = "charcoal";
    else if (name.includes("graphite")) kind = "graphite";
    else if (name.includes("wash")) kind = "wash";
    else if (name.includes("accent")) kind = "accent";
  }
  return {
    kind,
    opacity: L.opacity ?? (kind === "wash" ? 0.46 : kind === "graphite" ? 0.62 : 0.8),
    grain: L.grain ?? (kind === "charcoal" ? 0.62 : kind === "graphite" ? 0.4 : 0.22),
    dry: L.dry ?? (kind === "charcoal" ? 0.52 : kind === "graphite" ? 0.28 : 0.12),
    bleed: L.bleed ?? (kind === "wash" ? 0.48 : kind === "accent" ? 0.22 : 0.08),
  };
}

let paperTile: HTMLCanvasElement | null = null;
const tipCache = new Map<string, HTMLCanvasElement>();

function getPaperTile(): HTMLCanvasElement {
  if (paperTile) return paperTile;
  const s = 256;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, s, s);
  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n =
        hash01(x * 0.37 + y * 1.13) * 0.5 + hash01(x * 0.11 + y * 0.19) * 0.5;
      const fiber =
        hash01(x * 2.17 + y * 0.09) * 0.55 + hash01(y * 3.31 + x * 0.04) * 0.2;
      const v = (n - 0.5) * 22 + (fiber - 0.35) * 14;
      d[i] = Math.max(0, Math.min(255, d[i] + v - 3));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v - 1));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v + 2));
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = i % 4 === 0 ? "#7a746c" : "#cfc6b8";
    ctx.fillRect(hash01(i * 3.1) * s, hash01(i * 7.7) * s, 1 + hash01(i + 2) * 2, 1);
  }
  ctx.globalAlpha = 1;
  paperTile = c;
  return c;
}

export function paintPaper(ctx: CanvasRenderingContext2D, alpha = 1) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = alpha;
  const tile = getPaperTile();
  const pat = ctx.createPattern(tile, "repeat");
  ctx.fillStyle = pat || PAPER;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Punch ink off a drawing's own layer — other drawings stay untouched. */
function punchDab(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  const r = Math.max(3.2, size * 0.72);
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function makeTip(kind: string, variant: number): HTMLCanvasElement {
  const s = 48;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  const cx = (s - 1) / 2;
  const cy = (s - 1) / 2;
  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      const dx = (px - cx) / (s * 0.48);
      const dy = (py - cy) / (s * 0.48);
      const r = Math.hypot(dx, dy);
      const n =
        hash01(px * 0.31 + py * 1.7 + variant * 19.1) * 0.55 +
        hash01(px * 1.9 + py * 0.4 + variant * 4.4) * 0.45;
      let a = 0;
      if (kind === "charcoal") {
        a = Math.max(0, 1 - r * r) * (0.28 + 0.72 * n);
        if (n < 0.28) a *= 0.12;
        if (r > 0.72 && n < 0.55) a *= 0.25;
      } else if (kind === "graphite") {
        const grain = 0.45 + 0.55 * Math.sin(px * 0.85 + n * 4 + variant);
        a = Math.max(0, 1 - r * 1.12) ** 1.35 * (0.42 + 0.58 * grain);
      } else if (kind === "wash") {
        a = Math.exp(-r * r * 1.85) * (0.42 + 0.2 * n);
      } else if (kind === "airbrush") {
        a = Math.exp(-r * r * 1.15) * (0.28 + 0.18 * n);
      } else if (kind === "accent") {
        a = Math.max(0, 1 - r) ** 0.65 * (0.62 + 0.38 * n);
        if (r > 0.78 && n < 0.4) a *= 0.35;
      } else {
        a = Math.max(0, 1 - r * 1.04) ** 0.8 * (0.7 + 0.3 * n);
        if (r > 0.68 && n < 0.42) a *= 0.3;
      }
      const i = (py * s + px) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(Math.min(255, Math.max(0, a) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function getTip(kind: string, variant: number): HTMLCanvasElement {
  const key = `${kind}:${variant}`;
  let tip = tipCache.get(key);
  if (!tip) {
    tip = makeTip(kind, variant);
    tipCache.set(key, tip);
  }
  return tip;
}

function colorizeTip(
  tip: HTMLCanvasElement,
  r: number,
  g: number,
  b: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = tip.width;
  c.height = tip.height;
  const x = c.getContext("2d");
  if (!x) return c;
  x.fillStyle = `rgb(${r},${g},${b})`;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = "destination-in";
  x.drawImage(tip, 0, 0);
  return c;
}

function centroid(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  const n = Math.max(1, pts.length);
  return [x / n, y / n];
}

function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function stampDab(
  ctx: CanvasRenderingContext2D,
  tip: HTMLCanvasElement,
  x: number,
  y: number,
  x0: number,
  y0: number,
  size: number,
  cover: number,
  bleed: number,
) {
  const dx = x - x0;
  const dy = y - y0;
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.translate(x, y);
  ctx.rotate(ang);
  if (bleed > 0.14) {
    ctx.globalAlpha = cover * 0.32 * bleed;
    ctx.drawImage(tip, -size * 0.9, -size * 0.9, size * 1.8, size * 1.8);
  }
  ctx.globalAlpha = Math.min(0.92, cover);
  ctx.drawImage(tip, -size / 2, -size / 2, size, size);
  ctx.restore();
}

type StrokeLayout = {
  pts: [number, number][];
  widths: number[];
  look: PenLook;
  baseW: number;
  r: number;
  g: number;
  b: number;
};

function layoutOutline(unit: Unit): StrokeLayout | null {
  const raw = unit.points;
  if (raw.length < 2) return null;
  const isForm = unit.kind === "form" || Boolean(unit.fill);
  const closed = Boolean(unit.closed || unit.fill) && isForm;
  const look = resolveLook(unit);

  let [r, g, b] = unit.color;
  if (0.299 * r + 0.587 * g + 0.114 * b > 200 && look.kind !== "wash") {
    r = 32;
    g = 30;
    b = 28;
  }

  const hasPenWidths = Boolean(unit.widths && unit.widths.length >= 2);
  const medianW = hasPenWidths
    ? [...(unit.widths as number[])].sort((a, b) => a - b)[
        Math.floor((unit.widths as number[]).length / 2)
      ]
    : unit.width || 3;
  const cap = look.kind === "charcoal" || look.kind === "wash" ? 8.5 : 7.2;
  const baseW = Math.max(
    1.4,
    Math.min(
      cap,
      hasPenWidths && medianW > 1.1
        ? medianW
        : (unit.width || 3) * (isForm ? 0.48 : 0.38),
    ),
  );
  const rawW = hasPenWidths
    ? (unit.widths as number[]).map((w) => Math.max(1.15, Math.min(cap, w)))
    : raw.map(() => baseW);

  const smooth = chaikin(raw, isForm ? 2 : 1, closed);
  const path = closed && smooth.length > 2 ? [...smooth, smooth[0]] : smooth;
  const wAlong = path.map((_, i) => {
    const t = path.length <= 1 ? 0 : i / (path.length - 1);
    const j = t * (rawW.length - 1);
    const a = Math.floor(j);
    const bi = Math.min(rawW.length - 1, a + 1);
    const f = j - a;
    return rawW[a] * (1 - f) + rawW[bi] * f;
  });
  const gap = Math.max(1.2, 1.4 + look.dry * 0.6);
  const { pts, widths: densW } = densify(path, movingAvgWidth(wAlong, 3), gap);
  return { pts, widths: movingAvgWidth(densW, 3), look, baseW, r, g, b };
}

type FillDab = { x: number; y: number; size: number; cover: number };

function layoutFill(unit: Unit): {
  ring: [number, number][];
  dabs: FillDab[];
  look: PenLook;
  style: string;
  cr: number;
  cg: number;
  cb: number;
} | null {
  const raw = unit.points;
  if (!unit.fill || raw.length < 4) return null;
  const closed = Boolean(unit.closed || unit.fill);
  const path = chaikin(raw, 2, closed);
  const ring = path[0] === path[path.length - 1] ? path : [...path, path[0]];
  const style = unit.fillStyle || "airbrush";
  const coverAmt = unit.fillCover ?? 0.55;
  const look: PenLook = {
    kind: unit.fillLook?.kind || "airbrush",
    opacity: unit.fillLook?.opacity ?? 0.36,
    grain: unit.fillLook?.grain ?? 0.22,
    dry: unit.fillLook?.dry ?? 0.3,
    bleed: unit.fillLook?.bleed ?? 0.5,
  };
  const [cr, cg, cb] = unit.fillColor || unit.color;
  const [cx, cy] = centroid(ring);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(8, Math.hypot(maxX - minX, maxY - minY));
  const seed = ring[0][0] * 0.17 + ring[0][1] * 0.31;
  const focus: [number, number] = [
    cx + (hash01(seed + 2) - 0.5) * span * 0.4,
    cy + (hash01(seed + 5) - 0.5) * span * 0.4,
  ];
  const nTarget =
    style === "mist"
      ? 18 + Math.floor(coverAmt * 28)
      : style === "blob"
        ? 28 + Math.floor(coverAmt * 40)
        : style === "full"
          ? 16 + Math.floor(coverAmt * 24)
          : 36 + Math.floor(coverAmt * 70);
  const reach =
    style === "blob" ? 0.28 + coverAmt * 0.18 : style === "mist" ? 0.62 : 0.52;
  const dabs: FillDab[] = [];
  let tries = 0;
  while (dabs.length < nTarget && tries < nTarget * 8) {
    tries += 1;
    const u = hash01(seed + tries * 1.7);
    const v = hash01(seed + tries * 3.9);
    const ang = u * Math.PI * 2;
    const rad = Math.pow(v, style === "blob" ? 0.7 : 0.5) * span * reach;
    const x = focus[0] + Math.cos(ang) * rad;
    const y = focus[1] + Math.sin(ang) * rad * (0.78 + look.grain * 0.3);
    const inside = pointInPoly(x, y, ring);
    if (!inside && (style === "full" || u > look.bleed * 0.55)) continue;
    if (!inside && style === "blob") continue;
    const fall = Math.max(0.15, 1 - rad / (span * reach + 1e-3));
    const size =
      span *
      (style === "mist" ? 0.18 + v * 0.28 : 0.1 + v * 0.22) *
      (0.7 + look.bleed * 0.5);
    dabs.push({
      x,
      y,
      size: Math.max(10, Math.min(span * 0.55, size)),
      cover: look.opacity * fall * (0.22 + u * 0.45),
    });
  }
  return { ring, dabs, look, style, cr, cg, cb };
}

function outlineDabAt(
  pts: [number, number][],
  widths: number[],
  look: PenLook,
  baseW: number,
  idx: number,
): { x: number; y: number; x0: number; y0: number; size: number; skip: boolean } | null {
  if (idx < 1) return null;
  const [x, y] = pts[idx];
  const [x0, y0] = pts[idx - 1];
  const w = widths[idx] ?? baseW;
  const seed = x * 0.13 + y * 0.27 + idx * 0.71;
  const dx = x - x0;
  const dy = y - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const j = (hash01(seed + 2.2) - 0.5) * look.grain * Math.max(0.8, w * 0.55);
  return {
    x: x + nx * j,
    y: y + ny * j,
    x0,
    y0,
    size: Math.max(2.2, w * (1.25 + look.bleed * 0.7 + look.grain * 0.25)),
    skip: hash01(seed) < look.dry * 0.34,
  };
}

function drawFill(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  timing: Timing,
): Promise<InkMark[]> {
  const laid = layoutFill(unit);
  if (!laid) return Promise.resolve([]);
  const { ring, dabs, look, style, cr, cg, cb } = laid;
  const tipKind = style === "full" ? "wash" : "airbrush";
  const inked = [0, 1, 2].map((v) =>
    colorizeTip(
      getTip(tipKind, v),
      Math.max(0, Math.min(255, cr + Math.round((hash01(cr + v) - 0.5) * 28))),
      Math.max(0, Math.min(255, cg + Math.round((hash01(cg + v) - 0.5) * 22))),
      Math.max(0, Math.min(255, cb + Math.round((hash01(cb + v) - 0.5) * 20))),
    ),
  );

  if (style === "full") {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]);
    ctx.closePath();
    ctx.globalAlpha = Math.min(0.62, look.opacity * 0.85);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fill();
    ctx.restore();
  }
  if (!dabs.length) return Promise.resolve([]);

  const marks: InkMark[] = [];
  return animateStamps(dabs.length, (i) => {
    const d = dabs[i];
    stampDab(ctx, inked[i % inked.length], d.x, d.y, d.x + 1, d.y, d.size, d.cover, look.bleed);
    marks.push({ x: d.x, y: d.y, size: d.size });
  }, timing).then(() => {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return marks;
  });
}

export function drawUnit(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  timing: Timing,
): Promise<{ marks: InkMark[] }> {
  const laid = layoutOutline(unit);
  if (!laid) return Promise.resolve({ marks: [] });
  const { pts, widths, look, baseW, r, g, b } = laid;
  const inked = [0, 1, 2].map((v) => {
    const dr = Math.round((hash01(r + v * 3.1) - 0.5) * 18);
    const dg = Math.round((hash01(g + v * 5.7) - 0.5) * 14);
    const db = Math.round((hash01(b + v * 8.2) - 0.5) * 12);
    return colorizeTip(
      getTip(look.kind, v),
      Math.max(0, Math.min(255, r + dr)),
      Math.max(0, Math.min(255, g + dg)),
      Math.max(0, Math.min(255, b + db)),
    );
  });

  const marks: InkMark[] = [];
  const paintOutline = () =>
    animateStamps(
      pts.length,
      (idx) => {
        const dab = outlineDabAt(pts, widths, look, baseW, idx);
        if (!dab || dab.skip) return;
        const cover =
          look.opacity *
          (0.72 + 0.28 * (1 - look.dry)) *
          (0.85 + hash01(dab.x * 0.13 + dab.y * 0.27 + 9) * 0.3);
        stampDab(ctx, inked[idx % inked.length], dab.x, dab.y, dab.x0, dab.y0, dab.size, cover, look.bleed);
        marks.push({ x: dab.x, y: dab.y, size: dab.size });
      },
      timing,
      1,
    ).then(() => {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return { marks };
    });

  if (unit.fill) {
    return drawFill(ctx, unit, timing).then((fillMarks) => {
      marks.push(...fillMarks);
      return paintOutline();
    });
  }
  return paintOutline();
}

export type HandState = {
  cursor: { x: number; y: number } | null;
  source: string | null;
};

export const MAX_HANDS = 5;
