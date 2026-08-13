import {
  enterCellIfChanged,
  growCell,
  recordPosition,
  type GridCell,
} from "../db/schema";
import { BUSSACO_ORIGIN, latLngToCell, metersToLatLng } from "./spatialHash";

export type TrackerStatus =
  | "idle"
  | "requesting"
  | "tracking"
  | "denied"
  | "unavailable"
  | "error"
  | "mock";

export type TrackerSnapshot = {
  status: TrackerStatus;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  cellKey: string | null;
  message: string;
};

export type TrackerHandlers = {
  onSnapshot: (snap: TrackerSnapshot) => void;
  onCellUpdate: (cell: GridCell, changed: boolean) => void;
};

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 15000,
};

/** How often presence in the same cell adds another mark. */
const DWELL_MS = 900;

export class GeoTracker {
  private watchId: number | null = null;
  private mockTimer: number | null = null;
  private dwellTimer: number | null = null;
  private previousKey: string | null = null;
  private handlers: TrackerHandlers;
  private status: TrackerStatus = "idle";
  private lastLat: number | null = null;
  private lastLng: number | null = null;

  constructor(handlers: TrackerHandlers) {
    this.handlers = handlers;
  }

  get currentCellKey(): string | null {
    return this.previousKey;
  }

  start(): void {
    this.stopMock();
    if (!navigator.geolocation) {
      this.emit({
        status: "unavailable",
        lat: null,
        lng: null,
        accuracy: null,
        cellKey: this.previousKey,
        message: "Geolocation not available in this browser.",
      });
      return;
    }

    this.status = "requesting";
    this.emit({
      status: "requesting",
      lat: null,
      lng: null,
      accuracy: null,
      cellKey: this.previousKey,
      message: "Requesting location…",
    });

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => void this.handleFix(pos, "tracking"),
      (err) => this.handleError(err),
      GEO_OPTIONS,
    );
  }

  stop(): void {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.stopMock();
    this.stopDwell();
    this.status = "idle";
    this.emit({
      status: "idle",
      lat: null,
      lng: null,
      accuracy: null,
      cellKey: this.previousKey,
      message: "Tracking stopped.",
    });
  }

  /**
   * Synthetic path with pauses: move a few steps, then linger so ink grows
   * while "standing still".
   */
  startMockWalk(cycles = 12, stepMs = 280): void {
    this.stop();
    this.status = "mock";
    let east = 0;
    let north = 0;
    let heading = Math.random() * Math.PI * 2;
    let phase: "walk" | "linger" = "walk";
    let phaseLeft = 4;
    let cyclesLeft = cycles;

    this.emit({
      status: "mock",
      lat: BUSSACO_ORIGIN.lat,
      lng: BUSSACO_ORIGIN.lng,
      accuracy: 5,
      cellKey: this.previousKey,
      message: "Mock walk running…",
    });

    this.mockTimer = window.setInterval(() => {
      if (cyclesLeft <= 0 && phase === "walk" && phaseLeft <= 0) {
        this.stopMock();
        // keep dwelling on last cell so stillness still grows
        this.startDwell("mock");
        this.emit({
          status: "mock",
          lat: this.lastLat,
          lng: this.lastLng,
          accuracy: 5,
          cellKey: this.previousKey,
          message: "Mock linger — standing still, ink grows.",
        });
        return;
      }

      if (phaseLeft <= 0) {
        if (phase === "walk") {
          phase = "linger";
          phaseLeft = 5 + Math.floor(Math.random() * 4);
        } else {
          phase = "walk";
          phaseLeft = 3 + Math.floor(Math.random() * 3);
          cyclesLeft -= 1;
        }
      }

      if (phase === "walk") {
        heading += (Math.random() - 0.5) * 0.9;
        const stepM = 3 + Math.random() * 4;
        east += Math.cos(heading) * stepM;
        north += Math.sin(heading) * stepM;
        const { lat, lng } = metersToLatLng(east, north);
        void this.ingest(lat, lng, 5, "mock");
      }
      // linger: dwell timer grows the cell; no new GPS step
      phaseLeft -= 1;
    }, stepMs);
  }

  private startDwell(status: TrackerStatus): void {
    this.stopDwell();
    this.dwellTimer = window.setInterval(() => {
      void this.tickDwell(status);
    }, DWELL_MS);
  }

  private stopDwell(): void {
    if (this.dwellTimer != null) {
      window.clearInterval(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  private async tickDwell(status: TrackerStatus): Promise<void> {
    if (!this.previousKey) return;
    const cell = await growCell(this.previousKey);
    if (!cell) return;
    this.handlers.onCellUpdate(cell, true);
    this.emit({
      status,
      lat: this.lastLat,
      lng: this.lastLng,
      accuracy: 5,
      cellKey: cell.key,
      message: `Still here · marks ${cell.visitCount}`,
    });
  }

  private stopMock(): void {
    if (this.mockTimer != null) {
      window.clearInterval(this.mockTimer);
      this.mockTimer = null;
    }
  }

  private async handleFix(
    pos: GeolocationPosition,
    status: TrackerStatus,
  ): Promise<void> {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    await this.ingest(lat, lng, accuracy, status);
  }

  private async ingest(
    lat: number,
    lng: number,
    accuracy: number | null,
    status: TrackerStatus,
  ): Promise<void> {
    const ts = Date.now();
    this.lastLat = lat;
    this.lastLng = lng;
    await recordPosition(lat, lng, accuracy, ts);
    const { ix, iy } = latLngToCell(lat, lng);
    const { cell, changed } = await enterCellIfChanged(
      ix,
      iy,
      this.previousKey,
      ts,
    );
    this.previousKey = cell.key;
    this.status = status;
    this.handlers.onCellUpdate(cell, changed);
    this.startDwell(status);
    this.emit({
      status,
      lat,
      lng,
      accuracy,
      cellKey: cell.key,
      message: changed
        ? `Entered ${cell.key} · marks ${cell.visitCount}`
        : `Here · marks ${cell.visitCount}`,
    });
  }

  private handleError(err: GeolocationPositionError): void {
    const denied = err.code === err.PERMISSION_DENIED;
    this.status = denied ? "denied" : "error";
    this.stopDwell();
    this.emit({
      status: this.status,
      lat: null,
      lng: null,
      accuracy: null,
      cellKey: this.previousKey,
      message: denied
        ? "Location permission denied."
        : err.message || "Location error.",
    });
  }

  private emit(snap: TrackerSnapshot): void {
    this.handlers.onSnapshot(snap);
  }
}
