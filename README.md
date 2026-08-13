# Latent Archive

A drawing is not a picture. It is a sequence of marks in time — pressure, lift, return. This project studies a personal archive of scans, then draws *from that knowledge* onto a paper canvas: same hand, new page.

It does not generate pixels. It generates **strokes**, inks them with **pens clustered from the archive**, and can later **rewind a drawing along the same path** because it kept the record.

```bash
make paper          # study the archive (pens + scribbles + symbols)
npm run dev         # UI on :5173 — picker runs in the tab
```

Open [http://localhost:5173/](http://localhost:5173/). Ink: **vibe** (scratches) / **icon** (labeled motifs) / **mix**.

---

## The idea

Most image models treat a page as a grid of colors. That can imitate a *look*. It cannot imitate a *hand*, because a hand is motor: order, taper, hesitation, the way a line ends.

So the archive is turned into **polylines** (where the pen went) plus **pen character** (how the mark sat in the paper). Generation is composition in that space. Rendering is a timed sequence of dabs. Memory is per-drawing layers, so undoing one motif does not erase the one underneath.

Three questions, three layers:

| | Question | What it studies | What it is |
|---|---|---|---|
| **Pens** | *How* do you mark? | Width, taper, grain, ink | k-means on real strokes |
| **Scribbles** | *What does a gesture feel like?* | Loose pages (`drawings/*.png`) | Style dictionary + stroke VAE |
| **Symbols** | *What did you mean?* | Repeats (`drawings/flower/…`) | Kept as objects, then varied |

Pens are shared. Scribbles and symbols are not mixed into one brain: a small sequence model trained on fragments and whole flowers at once would average them. Flowers would dissolve into more scribbles.

---

## 1. Vectorization — recovering the line

Scans are raster. The model needs time-ordered paths.

**Ink mask.** Light pages use adaptive threshold; dark pages use Otsu. Morphology cleans speckle.

**Scribbles (unlabeled files).** A morphological **skeleton** follows the midline of the ink. That is the right unit for “a gesture”: not the blob of charcoal, the path the hand took. Width along the path is recovered from a distance transform; color is sampled from the scan. Neighborhoods of strokes from the *same page* are stored together so a passage can replay a real region, not a random salad of lines.

**Symbols (labeled folders).** A flower is stem + bloom in a layout. A skeleton would shatter that. Extraction prefers **contours** (outlines and holes) so the object stays an object. Page-relative coordinates are kept so stem and bloom do not teleport.

This split is not aesthetic. It is the difference between *motor primitives* and *motifs*.

---

## 2. Pens — a motor signature, not a hex color

Each real stroke is a feature vector: log width, taper (start vs end), wobble, luminance, saturation, log length. **k-means** (farthest-first init) yields a small library of pens — charcoal-fine, wash, graphite swell, accent, and so on.

A pen is the whole mark: opacity, grain, dryness, bleed, covering power. Invented or replayed lines pick from this library, so new ink still sits in *your* paper, not a generic 2px stroke.

---

## 3. Style dictionary — vocabulary of the page

From the stroke library the dictionary keeps:

- **palette** — k-means on ink colors
- **strokes / forms** — thin gestures vs compact closed shapes
- **rhythm** — typical length, turn, scale
- **sources** — which page a passage came from

At draw time, a **passage** is several marks from the same source, kept in their real relative layout. That is why the page can look like a hand working a region, rather than clip-art sprinkled on cream.

---

## 4. The neural net — a VAE on strokes (SketchRNN)

The generative model is a small **SketchRNN**-style variational autoencoder (Ha & Eck, 2017), trained in PyTorch.

**Representation.** A polyline becomes a sequence of offsets `(dx, dy, pen)`, with the last step marked as stroke end. This is translation-invariant and matches how a line is *drawn*, not how it is *shown*.

**Encoder.** An RNN reads the sequence into a latent `z ∈ ℝ⁶⁴` (mean and log-variance, reparameterized).

**Decoder.** Another RNN, conditioned on `z`, emits at each step a **mixture of 10 bivariate Gaussians** for the next offset, plus logits for pen up / end. Sampling with temperature invents a new gesture in the same distribution as the archive.

**Loss.** Reconstruction is Gaussian-mixture NLL on `(dx, dy)` plus cross-entropy on pen state, plus KL from `q(z|x)` toward `N(0,I)` (annealed so the latent does not collapse early).

Two weight files, same architecture:

- `sketchrnn.pt` — vibe, trained on unlabeled stroke fragments (length 64, ~40 epochs)
- `flower.pt` (and later `<label>.pt`) — one model per symbol folder (length 96, ~60 epochs)

The architecture is an **autoencoder**. It is not an *image* autoencoder. A conv VAE on page photos would interpolate pixels. You would lose the line as a sequence, and “undraw” would become a fade, not a reverse stroke.

**Honest runtime note.** Icon mode mostly **replays** real sketches from `flower.json` and sometimes **grafts** one bloom onto another stem. The vibe model is the path that actually *samples* the decoder. Symbols are where layout matters more than novelty; scribbles are where invention is safe.

---

## 5. Composition — putting a page together

`compose_strokes.py` answers “what is the next passage?”

- **vibe** — replay a dictionary neighborhood, or (with novelty) sample the vibe VAE
- **icon** — place a labeled symbol, lightly jittered; at higher novelty, graft stem/bloom across examples
- **mix** — often a symbol, otherwise a scratch

Placement is page-relative: an anchor, a scale, a small rotation. Pens and palette still apply. The browser picker (`composePassage.ts`) returns JSON units — polylines, widths, color, look — not a PNG. The canvas is the hand.

---

## 6. Rendering — time, not a stamp of the finished image

The UI (React, Canvas 2D) densifies each polyline and **stamps a textured tip** along it: charcoal grain, dry skips, bleed. Speed maps logarithmically to dabs per second so the slider is crawl at one end and instant at the other, without a cliff in the middle.

**Each finished drawing is its own transparent layer.** The visible page is paper × those layers (multiply). That is why two overlapping flowers can share space, and why undraw can remove one of them.

**Undraw** is not a page fade and not an eraser on the shared bitmap. A second loop, independent of drawing, waits a random interval proportional to the Undraw slider, picks an *older* drawing (it must have sat for a couple of seconds), and **replays its dabs in reverse** with `destination-out` on *that layer only*. Other drawings stay. Draw and undraw run in parallel.

The record is the science: if you never stored the path, you could only smudge the paper.

---

## Why not one model for everything?

A single unconditioned SketchRNN on mixed fragments + whole flowers will tend toward the majority class (more, simpler vibe strokes). The split is:

- **How you mark** → one pen library (already unified)
- **What to invent** → vibe VAE vs labeled retrieval/composition

A pixel autoencoder could make a cousin of the *atmosphere*. It would not give you a hand that draws, then later un-draws the same line. That needs sequences.

A stronger next step, if you want more invention of motifs, is still stroke-shaped: a class-conditioned or layout latent (“this z is a flower”) whose decoder emits several polylines, still inked with the same pens.

---

## Run

```bash
npm run dev     # publishes knowledge + UI on :5173
```

Rebuild knowledge after adding scans:

```bash
make paper      # pens + scribbles + symbols
npm run knowledge
```

Add a motif:

```bash
# drawings/<label>/*.jpg
make symbols
```

| | |
|---|---|
| UI | React, TypeScript, Vite, Canvas 2D |
| Picker | TypeScript in the browser (`src/generate/composePassage.ts`) |
| Study (local) | `make paper` — optional FastAPI (`generate/server.py`) |
| Vision | OpenCV |
| Pens / dictionary | NumPy k-means |
| Stroke VAE | PyTorch SketchRNN-style (local Invent, not on Pages yet) |
| Archive | `drawings/` files = vibe, subfolders = symbols |

---

## Deploy

The public site is **GitHub Pages**. The picker runs in the browser; there is no Python server.

1. In the GitHub repo: **Settings → Pages → Source: GitHub Actions**.
2. Push `main`. The workflow publishes `https://andreianmatos.github.io/sketch/`.
3. Walk is `https://andreianmatos.github.io/sketch/walk.html`.

Locally: `npm run knowledge` then `npm run dev`. After new scans: `make paper` then push.

The **Invent** slider still varies replay and grafts flowers. The PyTorch VAE is not in the tab yet — that stays a local `make paper` / optional `make run` tool.

```
drawings/                      vibe pages (files)
drawings/flower/               labeled symbol set
generate/
  extract_strokes.py           skeletonize unlabeled pages
  extract_icons.py             contours for labeled folders
  build_pens.py
  build_style_dictionary.py
  stroke_model/train.py        VAE on (dx, dy, pen)
  compose_strokes.py           next passage (local Python)
  publish_knowledge.py         shards for the browser picker
  server.py                    optional local API
src/generate/                  paper, layers, picker, draw / undraw
```
