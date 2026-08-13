/** Places where the walk page is allowed to draw. Edit this list. */
export type Place = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Draw only when GPS is within this many meters of the pin. */
  radiusM: number;
};

export const PLACES: Place[] = [
  { id: "bussaco", name: "Bussaco", lat: 40.376, lng: -8.435, radiusM: 900 },
];

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

export function placeAt(lat: number, lng: number): Place | null {
  let best: { place: Place; d: number } | null = null;
  for (const place of PLACES) {
    const d = distanceM(lat, lng, place.lat, place.lng);
    if (d <= place.radiusM && (!best || d < best.d)) {
      best = { place, d };
    }
  }
  return best?.place ?? null;
}
