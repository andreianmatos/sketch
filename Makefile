# Bussaco Paper — study your hand, then draw from that knowledge.
#
#   make strokes     → inspect drawings, build pens (how you mark)
#   make scribbles   → learn unlabeled vibe / scratches
#   make symbols     → learn labeled folders (flower, …) + invent
#   make paper       → all of the above
#   make run         → API + tip for UI
#
# Then: npm run dev   → http://127.0.0.1:5173/

.PHONY: help strokes pens scribbles symbols paper run model clean-models

PYTHON ?= python3
export PYTHONPATH := .

help:
	@echo ""
	@echo "  make strokes     study drawings → stroke library + pens"
	@echo "  make scribbles   learn vibe (style dictionary + stroke model)"
	@echo "  make symbols     learn labeled icons (extract + train each)"
	@echo "  make paper       strokes + scribbles + symbols"
	@echo "  make run         start API on :8787"
	@echo ""

# ── pens / stroke character ──────────────────────────────────────────
strokes: pens

pens:
	@echo "→ vectorize drawings/ (files only; folders are symbols)"
	$(PYTHON) generate/extract_strokes.py --limit 0
	@echo "→ build pens from your marks"
	$(PYTHON) generate/build_pens.py
	@echo "→ style dictionary (palette + rhythm for passages)"
	$(PYTHON) generate/build_style_dictionary.py

# ── scribbles / vibe ─────────────────────────────────────────────────
scribbles: data/generate/stroke_library.json
	@echo "→ ensure dictionary"
	$(PYTHON) generate/build_style_dictionary.py
	@echo "→ train vibe stroke model (invented scratches)"
	$(PYTHON) generate/stroke_model/train.py --epochs 40
	@echo "→ refresh pens (includes latest strokes)"
	$(PYTHON) generate/build_pens.py

data/generate/stroke_library.json:
	$(PYTHON) generate/extract_strokes.py --limit 0

# ── symbols / labeled icons ──────────────────────────────────────────
symbols:
	@echo "→ extract labeled folders under drawings/<label>/"
	$(PYTHON) generate/extract_icons.py
	@echo "→ train a model per label"
	@set -e; \
	for f in data/generate/icons/*.json; do \
	  [ -f "$$f" ] || continue; \
	  label=$$(basename "$$f" .json); \
	  echo "  train icon: $$label"; \
	  $(PYTHON) generate/stroke_model/train.py --icon "$$label" --epochs 60; \
	done
	@echo "→ refresh pens (symbols feed stroke character too)"
	$(PYTHON) generate/build_pens.py

# ── full knowledge build ─────────────────────────────────────────────
paper: pens scribbles symbols
	@echo ""
	@echo "Paper knowledge ready:"
	@echo "  pens      → data/generate/pens.json"
	@echo "  scribbles → data/generate/stroke_model/sketchrnn.pt"
	@echo "  symbols   → data/generate/stroke_model/<label>.pt"
	@echo ""
	@echo "Next:  make run"
	@echo "Then:  npm run dev"

run model:
	@echo "→ API http://127.0.0.1:8787  (UI: npm run dev → :5173)"
	@-fuser -k 8787/tcp >/dev/null 2>&1 || true
	@sleep 0.4
	$(PYTHON) generate/server.py

clean-models:
	rm -f data/generate/stroke_model/*.pt
	rm -f data/generate/pens.json
