import { Rng } from "./rng";

export type PaletteSwatch = { rgb: number[]; weight?: number };
export type Pen = {
  name?: string;
  kind?: string;
  weight?: number;
  width_rel?: number;
  wobble?: number;
  color?: number[];
  envelope?: number[];
  opacity?: number;
  grain?: number;
  dry?: number;
  bleed?: number;
};
export type LibUnit = {
  _kind?: string;
  source?: string;
  kind?: string;
  closed?: boolean;
  fill?: boolean;
  compact?: number;
  color?: number[];
  width_rel?: number;
  widths?: number[];
  length?: number;
  page_len?: number;
  page_x?: number;
  page_y?: number;
  page_s?: number;
  page_points?: [number, number][];
  points?: [number, number][];
};
export type IconStroke = LibUnit;
export type IconSketch = {
  source?: string;
  n_strokes?: number;
  strokes: IconStroke[];
};

export type KnowledgeIndex = {
  version: number;
  palette: PaletteSwatch[];
  pens: Pen[];
  sources: { id: string; file: string; n: number; weight: number }[];
  icons: string[];
};

const base = () => {
  const b = import.meta.env.BASE_URL || "/";
  return b.endsWith("/") ? b : `${b}/`;
};

let indexP: Promise<KnowledgeIndex> | null = null;
const sourceCache = new Map<string, Promise<LibUnit[]>>();
const iconCache = new Map<string, Promise<IconSketch[]>>();

export function knowledgeUrl(path: string): string {
  return `${base()}knowledge/${path.replace(/^\//, "")}`;
}

export function loadIndex(): Promise<KnowledgeIndex> {
  if (!indexP) {
    indexP = fetch(knowledgeUrl("index.json")).then(async (r) => {
      if (!r.ok) throw new Error(`knowledge ${r.status}`);
      return (await r.json()) as KnowledgeIndex;
    });
  }
  return indexP;
}

export async function loadSource(file: string): Promise<LibUnit[]> {
  let p = sourceCache.get(file);
  if (!p) {
    p = fetch(knowledgeUrl(file)).then(async (r) => {
      if (!r.ok) throw new Error(`source ${r.status}`);
      const data = (await r.json()) as { units: LibUnit[] };
      return data.units || [];
    });
    sourceCache.set(file, p);
  }
  return p;
}

export async function loadIcon(label: string): Promise<IconSketch[]> {
  let p = iconCache.get(label);
  if (!p) {
    p = fetch(knowledgeUrl(`icons/${label}.json`)).then(async (r) => {
      if (!r.ok) throw new Error(`icon ${r.status}`);
      const data = (await r.json()) as { sketches: IconSketch[] };
      return data.sketches || [];
    });
    iconCache.set(label, p);
  }
  return p;
}

export async function knowledgeHealth(): Promise<{
  ok: boolean;
  icons: string[];
  sources: number;
}> {
  try {
    const idx = await loadIndex();
    return { ok: true, icons: idx.icons || [], sources: idx.sources.length };
  } catch {
    return { ok: false, icons: [], sources: 0 };
  }
}

export function pickPen(rng: Rng, pens: Pen[]): Pen | null {
  if (!pens.length) return null;
  return rng.choice(
    pens,
    pens.map((p) => Math.max(0.01, Number(p.weight) || 0.01)),
  );
}
