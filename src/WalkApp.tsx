import { useEffect, useMemo, useState } from "react";
import PaperStudio from "./generate/PaperStudio";
import { placeAt, type Place } from "./geo/places";
import { startWatch, type GeoFix, type GeoState } from "./geo/watch";

const INITIAL: GeoState = {
  status: "idle",
  message: "Location off.",
};

function fixFromState(state: GeoState): GeoFix | null {
  if (state.status === "tracking" || state.status === "mock") return state.fix;
  return null;
}

function formatCoord(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export default function WalkApp() {
  const [geo, setGeo] = useState<GeoState>(INITIAL);

  useEffect(() => startWatch(setGeo), []);

  const fix = fixFromState(geo);
  const here: Place | null = useMemo(
    () => (fix ? placeAt(fix.lat, fix.lng, fix.accuracy) : null),
    [fix],
  );

  return (
    <PaperStudio
      drawing={Boolean(here?.draw)}
      ink={here?.ink}
      blankWhenIdle
      showPanel={false}
    >
      <div className="pointer-events-none absolute bottom-0 left-0 z-20 px-[max(1rem,env(safe-area-inset-left))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {fix ? (
          <>
            <p className="font-mono text-[11px] tabular-nums text-[#6a6a66] sm:text-[10px]">
              {formatCoord(fix.lat, fix.lng)}
            </p>
            {here && (
              <p className="text-[11px] text-[#6a6a66] sm:text-[10px]">{here.name}</p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-[#6a6a66] sm:text-[10px]">Location required.</p>
        )}
      </div>
    </PaperStudio>
  );
}
