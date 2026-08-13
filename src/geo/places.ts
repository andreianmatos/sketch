/**
 * Map of spaces. Each entry is a pin with a small radius — not a street
 * unless you say so. Walk inks only inside a place with `draw: true`.
 *
 * Later, set `ink` on a place to bind it to a specific drawing set
 * (mode, icon, …). Leave `ink` off to use the ordinary paper.
 */
export type PlaceInk = {
  mode?: "vibe" | "icon" | "mix";
  icon?: string;
};

export type Place = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Draw only when GPS is within this many meters of the pin. */
  radiusM: number;
  /** Walk page shows drawings while you are here. */
  draw?: boolean;
  /** Optional place-specific ink. Unset = same paper as the studio. */
  ink?: PlaceInk;
};

/** Default for a mapped space: a small circle, not a road. */
export const PLACE_RADIUS_M = 45;

export const PLACES: Place[] = [
  {
    id: "vila-cha-de-sa",
    name: "Vila Chã de Sá",
    // Estrada dos Lagares (nº 104) — the street, not a 45 m pin.
    lat: 40.60852,
    lng: -7.95162,
    radiusM: 1000,
    draw: true,
  },
  {
    id: "laranjeiras",
    name: "Laranjeiras",
    lat: 38.74901,
    lng: -9.18072,
    // One neighborhood: Estrada da Luz, Laranjeiras, Alto dos Moinhos, Estrada de Benfica.
    radiusM: 900,
    draw: true,
  },
];

/** Grid / mock origin — the first mapped space. */
export const MAP_ORIGIN = {
  lat: 40.60852,
  lng: -7.95162,
} as const;

const EARTH_M = 6_371_000;

export function distanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function placeAt(
  lat: number,
  lng: number,
  accuracyM: number | null = null,
): Place | null {
  const pad = Math.min(80, Math.max(0, accuracyM ?? 0));
  let best: { place: Place; d: number } | null = null;
  for (const place of PLACES) {
    const d = distanceM(lat, lng, place.lat, place.lng);
    if (d <= place.radiusM + pad && (!best || d < best.d)) {
      best = { place, d };
    }
  }
  return best?.place ?? null;
}
