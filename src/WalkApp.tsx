import { useEffect, useMemo, useState } from "react";
import PaperStudio from "./generate/PaperStudio";
import { PAPER } from "./generate/paperInk";
import { PLACES, placeAt, type Place } from "./geo/places";
import { startWatch, type GeoFix, type GeoState } from "./geo/watch";

const INITIAL: GeoState = {
  status: "idle",
  message: "Location off.",
};

function fixFromState(state: GeoState): GeoFix | null {
  if (state.status === "tracking" || state.status === "mock") return state.fix;
  return null;
}

export default function WalkApp() {
  const [geo, setGeo] = useState<GeoState>(INITIAL);
  const [wantWatch, setWantWatch] = useState(true);
  const [watchGen, setWatchGen] = useState(0);

  useEffect(() => {
    if (!wantWatch) return;
    return startWatch(setGeo);
  }, [wantWatch, watchGen]);

  const fix = fixFromState(geo);
  const here: Place | null = useMemo(
    () => (fix ? placeAt(fix.lat, fix.lng) : null),
    [fix],
  );
  const inPlace = Boolean(here);

  const pretendHere = () => {
    setWantWatch(false);
    const place = PLACES[0];
    if (!place) return;
    setGeo({
      status: "mock",
      fix: { lat: place.lat, lng: place.lng, accuracy: 8 },
      message: `Pretending ${place.name}.`,
    });
  };

  const useRealGps = () => {
    setWantWatch(true);
    setWatchGen((n) => n + 1);
  };

  const showShare = geo.status !== "tracking" && geo.status !== "mock";

  const line = inPlace
    ? here?.name ?? ""
    : geo.status === "requesting"
      ? "Requesting location…"
      : geo.status === "tracking" || geo.status === "mock"
        ? "Not here"
        : geo.message;

  return (
    <PaperStudio drawing={inPlace} blankWhenIdle showPanel={false}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="text-xs text-[#6a6a66] sm:text-[10px]">{line}</p>
      </div>

      <div
        className="absolute inset-x-0 bottom-0 z-20 px-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        style={{
          background: `linear-gradient(to top, ${PAPER} 55%, transparent)`,
        }}
      >
        <div className="pointer-events-auto flex flex-wrap gap-2">
          {showShare && (
            <button
              type="button"
              className="tap rounded-sm border border-[#2a2a28] bg-[#2a2a28] text-white"
              onClick={useRealGps}
            >
              Share location
            </button>
          )}
          {geo.status === "mock" && (
            <button
              type="button"
              className="tap rounded-sm border border-[#2a2a28] bg-[#2a2a28] text-white"
              onClick={useRealGps}
            >
              Use GPS
            </button>
          )}
          <button
            type="button"
            className="tap rounded-sm border border-[#d0d0ca] bg-white/80"
            onClick={pretendHere}
          >
            Pretend I&apos;m here
          </button>
        </div>
      </div>
    </PaperStudio>
  );
}
