export type GeoFix = {
  lat: number;
  lng: number;
  accuracy: number | null;
};

export type GeoState =
  | { status: "idle"; message: string }
  | { status: "requesting"; message: string }
  | { status: "tracking"; fix: GeoFix; message: string }
  | { status: "mock"; fix: GeoFix; message: string }
  | { status: "denied"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 15000,
};

export function startWatch(onUpdate: (state: GeoState) => void): () => void {
  if (!navigator.geolocation) {
    onUpdate({
      status: "unavailable",
      message: "Geolocation is not available in this browser.",
    });
    return () => undefined;
  }

  if (!window.isSecureContext) {
    onUpdate({
      status: "unavailable",
      message: "Location needs HTTPS (or localhost).",
    });
    return () => undefined;
  }

  onUpdate({ status: "requesting", message: "Requesting location…" });

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const fix: GeoFix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
      };
      onUpdate({
        status: "tracking",
        fix,
        message: "Location on.",
      });
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        onUpdate({
          status: "denied",
          message: "Location permission denied.",
        });
        return;
      }
      onUpdate({
        status: "error",
        message: err.message || "Location error.",
      });
    },
    GEO_OPTIONS,
  );

  return () => navigator.geolocation.clearWatch(id);
}
