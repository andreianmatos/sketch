export type StyleDna = {
  version: number;
  angle_bins: number;
  sources: string[];
  point_count: number;
  step_length: { mean: number; std: number };
  jitter: { mean: number; std: number };
  transitions: number[][];
  stroke_length: { mean: number; std: number; min: number; max: number };
};

export type Point = { x: number; y: number };

/** Mulberry32 — deterministic PRNG from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleBin(row: number[], rand: () => number): number {
  let r = rand();
  for (let i = 0; i < row.length; i++) {
    r -= row[i] ?? 0;
    if (r <= 0) return i;
  }
  return row.length - 1;
}

function gaussian(rand: () => number, mean: number, std: number): number {
  // Box–Muller
  const u = Math.max(1e-9, rand());
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Markov-chain stroke in the learned hand.
 * Coordinates are local to a cell centered at (0,0), half-extent `half`.
 */
export function generateStroke(
  dna: StyleDna,
  seed: number,
  half: number,
): Point[] {
  const rand = mulberry32(seed);
  const bins = dna.angle_bins;
  const twoPi = Math.PI * 2;

  // Scale DNA step sizes (image pixels) into cell space
  const scale = (half * 0.045) / Math.max(dna.step_length.mean, 1);
  const stepMean = dna.step_length.mean * scale;
  const stepStd = dna.step_length.std * scale;
  const jitStd = Math.max(dna.jitter.std * scale * 0.8, half * 0.004);

  let angleBin = Math.floor(rand() * bins);
  let angle = ((angleBin + 0.5) / bins) * twoPi - Math.PI;

  let x = (rand() - 0.5) * half * 1.2;
  let y = (rand() - 0.5) * half * 1.2;

  const targetLen = clamp(
    gaussian(rand, dna.stroke_length.mean, dna.stroke_length.std),
    dna.stroke_length.min,
    dna.stroke_length.max,
  );

  const pts: Point[] = [{ x, y }];
  for (let i = 0; i < targetLen; i++) {
    const row = dna.transitions[angleBin] ?? dna.transitions[0];
    angleBin = sampleBin(row, rand);
    const targetAngle = ((angleBin + 0.5) / bins) * twoPi - Math.PI;
    // Smooth turn toward sampled bin (hand continuity)
    let delta = targetAngle - angle;
    while (delta > Math.PI) delta -= twoPi;
    while (delta < -Math.PI) delta += twoPi;
    angle += delta * (0.55 + rand() * 0.35);

    const step = Math.max(0.15, gaussian(rand, stepMean, stepStd));
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    // Tremor perpendicular to travel
    const j = gaussian(rand, 0, jitStd);
    x += nx * step - ny * j;
    y += ny * step + nx * j;

    // Soft bounce inside the square so presence stays local
    const limit = half * 0.92;
    if (x > limit || x < -limit) {
      angle = Math.PI - angle;
      x = clamp(x, -limit, limit);
      angleBin = Math.floor(((angle + Math.PI) / twoPi) * bins) % bins;
    }
    if (y > limit || y < -limit) {
      angle = -angle;
      y = clamp(y, -limit, limit);
      angleBin = Math.floor(((angle + Math.PI) / twoPi) * bins) % bins;
    }

    pts.push({ x, y });
  }
  return pts;
}

/** How many strokes to draw for a given presence / visit intensity. */
export function strokeCountForVisits(visitCount: number): number {
  if (visitCount <= 0) return 0;
  if (visitCount === 1) return 1;
  if (visitCount <= 3) return visitCount;
  if (visitCount <= 10) return 3 + Math.floor((visitCount - 3) * 0.8);
  return Math.min(36, 8 + Math.floor((visitCount - 10) * 0.6));
}

export async function loadStyleDna(url = "/style_dna.json"): Promise<StyleDna> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load Style DNA (${res.status})`);
  return (await res.json()) as StyleDna;
}
