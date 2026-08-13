import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_HANDS,
  PAPER,
  drawUnit,
  freezeStroke,
  makeInkBreath,
  makeLayer,
  nextDrawWait,
  nextUndrawWait,
  pageLoad,
  paintPaper,
  presentPage,
  scaleCanvas,
  scaleStroke,
  sleep,
  stampRate,
  tickBreath,
  undrawBurst,
  undrawDrawing,
  undrawMinAge,
  type HandState,
  type LayerBlit,
  type Passage,
  type RecordedDrawing,
  type RecordedStroke,
  type Timing,
} from "./paperInk";

const API =
  import.meta.env.VITE_GENERATE_API ??
  (import.meta.env.DEV ? "http://127.0.0.1:8787" : "");

export type PaperStudioProps = {
  drawing: boolean;
  onDrawingChange?: (next: boolean) => void;
  blankWhenIdle?: boolean;
  showPanel?: boolean;
  children?: ReactNode;
};

export default function PaperStudio({
  drawing,
  onDrawingChange,
  blankWhenIdle = false,
  showPanel = true,
  children,
}: PaperStudioProps) {
  const [status, setStatus] = useState("");
  const [speed, setSpeed] = useState(0.66);
  const [drift, setDrift] = useState(0.06);
  const [novelty, setNovelty] = useState(0.1);
  const [mode, setMode] = useState<"vibe" | "icon" | "mix">("mix");
  const [icon, setIcon] = useState("flower");
  const [hands, setHands] = useState(1);
  const [wander, setWander] = useState(0.34);
  const [fade, setFade] = useState(0.55);
  const [fill, setFill] = useState(0.28);
  const [readyIcons, setReadyIcons] = useState<string[]>([]);
  const [passageCount, setPassageCount] = useState(0);
  const [panel, setPanel] = useState(true);
  const [trade, setTrade] = useState({ ink: 0, want: 0.45 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(true);
  const paramsRef = useRef({
    novelty,
    speed,
    drift,
    mode,
    icon,
    hands,
    wander,
    fade,
    fill,
  });
  const nRef = useRef(0);
  const sizeRef = useRef({ w: 1024, h: 1280 });
  const genRef = useRef(0);
  const archiveRef = useRef<RecordedDrawing[]>([]);
  const liveCanvasesRef = useRef<HTMLCanvasElement[]>([]);
  const liveStrokesRef = useRef<RecordedStroke[]>([]);
  const rewindingRef = useRef<RecordedDrawing | null>(null);
  const paperRef = useRef<HTMLCanvasElement | null>(null);
  const onDrawingChangeRef = useRef(onDrawingChange);
  onDrawingChangeRef.current = onDrawingChange;

  const present = useCallback(() => {
    const display = canvasRef.current;
    const paper = paperRef.current;
    if (!display || !paper) return;
    const layers: LayerBlit[] = [];
    const addDrawing = (d: RecordedDrawing) => {
      for (const s of d.strokes) {
        layers.push({ canvas: s.layer, x: s.ox, y: s.oy });
      }
    };
    for (const d of archiveRef.current) addDrawing(d);
    if (rewindingRef.current) addDrawing(rewindingRef.current);
    for (const s of liveStrokesRef.current) {
      layers.push({ canvas: s.layer, x: s.ox, y: s.oy });
    }
    for (const c of liveCanvasesRef.current) layers.push({ canvas: c });
    presentPage(display, paper, layers);
  }, []);

  const remapInk = useCallback((ow: number, oh: number, nw: number, nh: number) => {
    if (ow < 8 || oh < 8 || nw < 8 || nh < 8) return;
    const sx = nw / ow;
    const sy = nh / oh;
    if (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    const mapDrawing = (d: RecordedDrawing): RecordedDrawing => ({
      ...d,
      strokes: d.strokes.map((s) => scaleStroke(s, sx, sy)),
    });
    archiveRef.current = archiveRef.current.map(mapDrawing);
    if (rewindingRef.current) rewindingRef.current = mapDrawing(rewindingRef.current);
    liveStrokesRef.current = liveStrokesRef.current.map((s) => scaleStroke(s, sx, sy));
    liveCanvasesRef.current = liveCanvasesRef.current
      .filter((c) => c.width === ow && c.height === oh)
      .map((c) => scaleCanvas(c, nw, nh));
  }, []);

  const syncCanvas = useCallback(() => {
    const c = canvasRef.current;
    const host = wrapRef.current;
    if (!c) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, host?.clientWidth || window.innerWidth);
    const cssH = Math.max(1, host?.clientHeight || window.innerHeight);
    if (cssW < 2 || cssH < 2) return false;
    const w = Math.max(256, Math.min(3840, Math.round(cssW * dpr)));
    const h = Math.max(256, Math.min(3840, Math.round(cssH * dpr)));
    const prev = sizeRef.current;
    if (prev.w === w && prev.h === h) return false;
    // iPhone URL bar: same width, small height jitter — stretch CSS, keep backing store.
    if (prev.w === w && Math.abs(h - prev.h) < Math.round(140 * dpr)) return false;
    sizeRef.current = { w, h };
    c.width = w;
    c.height = h;
    return true;
  }, []);

  useEffect(() => {
    drawingRef.current = drawing;
  }, [drawing]);

  useEffect(() => {
    paramsRef.current = {
      novelty,
      speed,
      drift,
      mode,
      icon,
      hands,
      wander,
      fade,
      fill,
    };
  }, [novelty, speed, drift, mode, icon, hands, wander, fade, fill]);

  const randomSpot = useCallback(() => {
    const { w, h } = sizeRef.current;
    return {
      x: w * (0.04 + Math.random() * 0.92),
      y: h * (0.04 + Math.random() * 0.92),
    };
  }, []);

  const fillPaper = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const prev = { ...sizeRef.current };
    if (syncCanvas()) {
      remapInk(prev.w, prev.h, sizeRef.current.w, sizeRef.current.h);
    }
    const { w, h } = sizeRef.current;
    let paper = paperRef.current;
    if (!paper || paper.width !== w || paper.height !== h) {
      paper = makeLayer(w, h);
      paperRef.current = paper;
    }
    const pctx = paper.getContext("2d");
    if (!pctx) return;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    paintPaper(pctx, 1);
    present();
  }, [syncCanvas, present, remapInk]);

  useEffect(() => {
    if (drawing || !blankWhenIdle) return;
    archiveRef.current = [];
    liveCanvasesRef.current = [];
    liveStrokesRef.current = [];
    rewindingRef.current = null;
    nRef.current = 0;
    setPassageCount(0);
    fillPaper();
  }, [drawing, blankWhenIdle, fillPaper]);

  useEffect(() => {
    fillPaper();
    void (async () => {
      try {
        const res = await fetch(`${API}/api/health`);
        const data = await res.json();
        if (!data.ok) setStatus("Run: npm run prepare && npm run model");
        else {
          setStatus("");
          const icons = Array.isArray(data.icons) ? (data.icons as string[]) : [];
          setReadyIcons(icons);
          setIcon((prev) => (icons.includes(prev) ? prev : icons[0] || prev));
        }
      } catch {
        setStatus("Model offline — npm run model");
      }
    })();
  }, [fillPaper]);

  const fetchPassage = useCallback(async (seed: number, hand: HandState) => {
    const { novelty: n, mode: m, icon: ic, fill: fillAmt } = paramsRef.current;
    const { w, h } = sizeRef.current;
    const q = new URLSearchParams({
      novelty: String(n),
      seed: String(seed),
      width: String(w),
      height: String(h),
      mode: m,
      fill: String(fillAmt),
    });
    if (m !== "vibe" && ic) q.set("icon", ic);
    if (hand.source) q.set("source", hand.source);
    if (hand.cursor) {
      q.set("cx", String(hand.cursor.x));
      q.set("cy", String(hand.cursor.y));
    }
    const res = await fetch(`${API}/api/stroke?${q}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Passage;
  }, []);

  const paintPassage = useCallback(
    async (
      passage: Passage,
      hand: HandState,
      stop: () => boolean,
    ) => {
      if (!passage.units?.length) return;
      const { w, h } = sizeRef.current;
      const timing: Timing = {
        get speed() {
          return paramsRef.current.speed;
        },
        get drift() {
          return paramsRef.current.drift;
        },
        get fade() {
          return paramsRef.current.fade;
        },
        stop,
        afterStamp: present,
      };

      if (passage.source && Math.random() < 0.4) hand.source = passage.source;
      else hand.source = null;

      const strokes: RecordedStroke[] = [];
      try {
        for (const unit of passage.units) {
          if (stop()) break;
          const tmp = makeLayer(w, h);
          const lctx = tmp.getContext("2d");
          if (!lctx) continue;
          liveCanvasesRef.current.push(tmp);
          present();
          const draft = await drawUnit(lctx, unit, timing);
          liveCanvasesRef.current = liveCanvasesRef.current.filter((c) => c !== tmp);
          const frozen = freezeStroke(tmp, draft.marks);
          if (frozen) {
            const { w: cw, h: ch } = sizeRef.current;
            const sx = tmp.width ? cw / tmp.width : 1;
            const sy = tmp.height ? ch / tmp.height : 1;
            const stroke =
              Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01
                ? scaleStroke(frozen, sx, sy)
                : frozen;
            strokes.push(stroke);
            liveStrokesRef.current.push(stroke);
            present();
          }
          const dps = stampRate(paramsRef.current.speed);
          const gap = Number.isFinite(dps) ? Math.min(80, 180 / Math.max(12, dps / 60)) : 0;
          if (gap > 1) await sleep(gap);
        }
        if (strokes.length) {
          archiveRef.current.push({ strokes, at: Date.now() });
          if (archiveRef.current.length > 28) {
            archiveRef.current.splice(0, archiveRef.current.length - 28);
          }
        }
      } finally {
        const keep = new Set(strokes);
        liveStrokesRef.current = liveStrokesRef.current.filter((s) => !keep.has(s));
        present();
      }
      if (typeof passage.cx === "number" && typeof passage.cy === "number") {
        hand.cursor = { x: passage.cx, y: passage.cy };
      }
      nRef.current += 1;
      setPassageCount(nRef.current);
      setStatus("");
    },
    [present],
  );

  useEffect(() => {
    if (!drawing) return;
    const gen = ++genRef.current;
    const alive = () => genRef.current === gen && drawingRef.current;

    nRef.current = 0;
    archiveRef.current = [];
    liveCanvasesRef.current = [];
    liveStrokesRef.current = [];
    rewindingRef.current = null;
    setPassageCount(0);
    fillPaper();

    const breath = makeInkBreath(paramsRef.current.fade);
    const extraInk = () => [
      ...liveStrokesRef.current,
      ...(rewindingRef.current?.strokes ?? []),
    ];
    const measure = () => pageLoad(archiveRef.current, extraInk());

    const runHand = async (id: number) => {
      const hand: HandState = { cursor: randomSpot(), source: null };
      await sleep(id * 90);
      if (!alive()) return;
      let pending: Promise<Passage> | null = null;
      while (alive()) {
        const nHands = Math.max(1, Math.round(paramsRef.current.hands));
        if (id >= nHands) {
          pending = null;
          await sleep(200);
          continue;
        }
        try {
          const fade = paramsRef.current.fade;
          const load = measure();
          const want = tickBreath(breath, fade);
          const pause = nextDrawWait(fade, load, want);
          if (pause > 0) {
            setTrade({ ink: load, want });
            await sleep(pause);
            if (!alive()) continue;
          }
          if (measure() - breath.want > 0.14) {
            pending = null;
            continue;
          }
          const { wander: wdr } = paramsRef.current;
          if (Math.random() < wdr) {
            hand.cursor = randomSpot();
            hand.source = null;
            pending = null;
          }
          const passage = await (pending ??
            fetchPassage(Math.floor(Math.random() * 1_000_000_000), hand));
          if (!alive() || id >= Math.round(paramsRef.current.hands)) continue;
          pending = fetchPassage(Math.floor(Math.random() * 1_000_000_000), hand);
          await paintPassage(
            passage,
            hand,
            () => !alive() || id >= Math.round(paramsRef.current.hands),
          );
          const after = measure();
          setTrade({ ink: after, want: breath.want });
        } catch {
          if (id === 0 && alive()) {
            setStatus("Failed — npm run prepare && npm run model");
            onDrawingChangeRef.current?.(false);
          }
          break;
        }
      }
    };

    const runUndraw = async () => {
      const timing: Timing = {
        get speed() {
          return paramsRef.current.speed;
        },
        get drift() {
          return paramsRef.current.drift;
        },
        get fade() {
          return paramsRef.current.fade;
        },
        rewind: true,
        stop: () => !alive(),
        afterStamp: present,
      };
      await sleep(900 + Math.random() * 1400);
      while (alive()) {
        const fade = paramsRef.current.fade;
        if (fade <= 0.001) {
          await sleep(160);
          continue;
        }
        const load = measure();
        const want = tickBreath(breath, fade);
        setTrade({ ink: load, want });
        await sleep(nextUndrawWait(fade, load, want));
        if (!alive()) break;
        if (paramsRef.current.fade <= 0.001) continue;
        const burst = undrawBurst(
          pageLoad(archiveRef.current, liveStrokesRef.current),
          breath.want,
        );
        for (let b = 0; b < burst; b++) {
          if (!alive() || paramsRef.current.fade <= 0.001) break;
          const nowLoad = pageLoad(archiveRef.current, liveStrokesRef.current);
          const lifted = await undrawDrawing(
            archiveRef.current,
            timing,
            (d) => {
              rewindingRef.current = d;
              present();
            },
            () => {
              rewindingRef.current = null;
              present();
            },
            undrawMinAge(nowLoad, breath.want),
          );
          setTrade({
            ink: pageLoad(archiveRef.current, liveStrokesRef.current),
            want: breath.want,
          });
          if (!lifted) break;
          if (b + 1 < burst) await sleep(80 + Math.random() * 220);
        }
      }
    };

    for (let i = 0; i < MAX_HANDS; i++) void runHand(i);
    void runUndraw();

    return () => {
      genRef.current += 1;
    };
  }, [drawing, fillPaper, fetchPassage, paintPassage, randomSpot, present]);

  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fillPaper(), 80);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [fillPaper]);

  const clearPage = () => {
    archiveRef.current = [];
    liveCanvasesRef.current = [];
    liveStrokesRef.current = [];
    rewindingRef.current = null;
    fillPaper();
    nRef.current = 0;
    setPassageCount(0);
  };

  const download = () => {
    const c = canvasRef.current;
    if (!c) return;
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = `drawing_${Date.now()}.png`;
    a.click();
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      style={{ background: PAPER }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full touch-none"
        style={{ background: PAPER }}
        onClick={() => {
          if (showPanel) setPanel((v) => !v);
        }}
      />

      {status && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))]">
          <p className="text-xs text-[#6a6a66] sm:text-[10px]">{status}</p>
        </div>
      )}

      {children}

      {showPanel && panel && (
        <div
          className="sheet absolute inset-x-0 bottom-0 z-10 max-h-[min(58svh,28rem)] overflow-y-auto pointer-events-auto sm:max-h-[48vh]"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="px-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            style={{
              background: `linear-gradient(to top, ${PAPER} 72%, ${PAPER}cc 88%, transparent)`,
            }}
          >
            <div className="field grid grid-cols-1 gap-x-3 gap-y-2 text-[#5c5c58] min-[380px]:grid-cols-2 sm:grid-cols-4 sm:gap-y-1.5">
              <label className="block">
                Ink
                <select
                  className="mt-0.5 w-full rounded-sm border border-[#d0d0ca] bg-white/90 px-1.5 py-1"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "vibe" | "icon" | "mix")}
                >
                  <option value="vibe">vibe (scratches)</option>
                  <option value="icon" disabled={!readyIcons.length}>
                    icon {readyIcons.length ? `(${icon})` : "(train first)"}
                  </option>
                  <option value="mix" disabled={!readyIcons.length}>
                    mix vibe + icon
                  </option>
                </select>
              </label>
              {readyIcons.length >= 1 && (
                <label className="block">
                  Symbol
                  <select
                    className="mt-0.5 w-full rounded-sm border border-[#d0d0ca] bg-white/90 px-1.5 py-1"
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                  >
                    {readyIcons.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block" title="Independent drawing starts at once">
                Hands {hands}
                <input
                  type="range"
                  min={1}
                  max={MAX_HANDS}
                  step={1}
                  value={hands}
                  onChange={(e) => setHands(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
              </label>
              <label className="block" title="Left = one dab at a time, right = whole stroke at once">
                Speed{" "}
                {speed <= 0.04
                  ? "crawl"
                  : speed >= 0.93
                    ? "instant"
                    : speed < 0.35
                      ? "slow"
                      : speed > 0.7
                        ? "fast"
                        : "drawing"}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
                <span className="mt-0.5 flex justify-between text-[11px] text-[#9a9a94] sm:text-[9px]">
                  <span>slow</span>
                  <span>fast</span>
                </span>
              </label>
              <label className="block" title="Uneven stops and rushes">
                Drift {drift.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={drift}
                  onChange={(e) => setDrift(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
              </label>
              <label className="block">
                Invent {novelty.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={0.8}
                  step={0.05}
                  value={novelty}
                  onChange={(e) => setNovelty(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
              </label>
              <label className="block" title="How often a hand jumps to a new spot">
                Wander {wander.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={wander}
                  onChange={(e) => setWander(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
              </label>
              <label
                className="block"
                title="Keep vs lift. Hands pause when the page is fuller than this; undraw waits when it is emptier. Moods last long enough to fill, then to clear."
              >
                Undraw {fade.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={fade}
                  onChange={(e) => setFade(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
                <span className="mt-0.5 flex justify-between text-[11px] text-[#9a9a94] sm:text-[9px]">
                  <span>keep</span>
                  <span>
                    ink {trade.ink.toFixed(2)} · want {trade.want.toFixed(2)}
                  </span>
                  <span>lift</span>
                </span>
              </label>
              <label className="block" title="How often interiors get an airbrush / mist fill">
                Fill {fill.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={fill}
                  onChange={(e) => setFill(Number(e.target.value))}
                  className="mt-0.5 w-full"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="tap rounded-sm border border-[#2a2a28] bg-[#2a2a28] text-white"
                onClick={() => onDrawingChange?.(!drawing)}
              >
                {drawing ? "Pause" : "Draw"}
              </button>
              <button
                type="button"
                className="tap rounded-sm border border-[#d0d0ca] bg-white/80"
                onClick={clearPage}
              >
                New page
              </button>
              <button
                type="button"
                className="tap rounded-sm border border-[#d0d0ca] bg-white/80"
                onClick={download}
              >
                Download
              </button>
              <span className="self-center text-xs text-[#8a8a84] sm:text-[10px]">
                {passageCount}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
