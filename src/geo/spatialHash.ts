/** Default map origin (WGS84). */
export const MAP_ORIGIN = {
  lat: 40.376,
  lng: -8.435,
} as const;

/** Occupancy grid cell size in meters. */
export const CELL_SIZE_M = 5;

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export type CellIndex = {
  ix: number;
  iy: number;
};

export function cellKey(ix: number, iy: number): string {
  return `${ix}:${iy}`;
}

export function parseCellKey(key: string): CellIndex {
  const [ix, iy] = key.split(":").map(Number);
  return { ix, iy };
}

/** Local east/north meters relative to the map origin. */
export function latLngToMeters(
  lat: number,
  lng: number,
  origin = MAP_ORIGIN,
): { east: number; north: number } {
  const east = (lng - origin.lng) * metersPerDegLng(origin.lat);
  const north = (lat - origin.lat) * METERS_PER_DEG_LAT;
  return { east, north };
}

export function metersToLatLng(
  east: number,
  north: number,
  origin = MAP_ORIGIN,
): { lat: number; lng: number } {
  const lat = origin.lat + north / METERS_PER_DEG_LAT;
  const lng = origin.lng + east / metersPerDegLng(origin.lat);
  return { lat, lng };
}

export function latLngToCell(
  lat: number,
  lng: number,
  cellSizeM = CELL_SIZE_M,
): CellIndex {
  const { east, north } = latLngToMeters(lat, lng);
  return {
    ix: Math.floor(east / cellSizeM),
    iy: Math.floor(north / cellSizeM),
  };
}

export function cellCenterMeters(
  ix: number,
  iy: number,
  cellSizeM = CELL_SIZE_M,
): { east: number; north: number } {
  return {
    east: (ix + 0.5) * cellSizeM,
    north: (iy + 0.5) * cellSizeM,
  };
}
