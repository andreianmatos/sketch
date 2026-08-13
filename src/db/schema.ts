import Dexie, { type EntityTable } from "dexie";

export type GpsPosition = {
  id?: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  ts: number;
};

export type GridCell = {
  key: string;
  ix: number;
  iy: number;
  visitCount: number;
  firstVisitAt: number;
  lastVisitAt: number;
};

class BussacoDB extends Dexie {
  positions!: EntityTable<GpsPosition, "id">;
  cells!: EntityTable<GridCell, "key">;

  constructor() {
    super("bussaco-archive");
    this.version(1).stores({
      positions: "++id, ts",
      cells: "key, ix, iy, visitCount, lastVisitAt",
    });
  }
}

export const db = new BussacoDB();

export async function recordPosition(
  lat: number,
  lng: number,
  accuracy: number | null,
  ts = Date.now(),
): Promise<number> {
  const id = await db.positions.add({ lat, lng, accuracy, ts });
  return id as number;
}

/**
 * Increment visit_count only when entering a cell (key change).
 */
export async function enterCellIfChanged(
  ix: number,
  iy: number,
  previousKey: string | null,
  ts = Date.now(),
): Promise<{ cell: GridCell; changed: boolean }> {
  const key = `${ix}:${iy}`;
  if (previousKey === key) {
    const existing = await db.cells.get(key);
    if (existing) {
      await db.cells.update(key, { lastVisitAt: ts });
      return { cell: { ...existing, lastVisitAt: ts }, changed: false };
    }
  }

  const existing = await db.cells.get(key);
  if (existing) {
    const cell: GridCell = {
      ...existing,
      visitCount: existing.visitCount + 1,
      lastVisitAt: ts,
    };
    await db.cells.put(cell);
    return { cell, changed: true };
  }

  const cell: GridCell = {
    key,
    ix,
    iy,
    visitCount: 1,
    firstVisitAt: ts,
    lastVisitAt: ts,
  };
  await db.cells.add(cell);
  return { cell, changed: true };
}

/** Keep densifying the current cell while the walker stays put. */
export async function growCell(
  key: string,
  ts = Date.now(),
): Promise<GridCell | null> {
  const existing = await db.cells.get(key);
  if (!existing) return null;
  const cell: GridCell = {
    ...existing,
    visitCount: existing.visitCount + 1,
    lastVisitAt: ts,
  };
  await db.cells.put(cell);
  return cell;
}

export async function getAllCells(): Promise<GridCell[]> {
  return db.cells.toArray();
}

export async function getCellCount(): Promise<number> {
  return db.cells.count();
}

export async function clearArchive(): Promise<void> {
  await db.transaction("rw", db.positions, db.cells, async () => {
    await db.positions.clear();
    await db.cells.clear();
  });
}
