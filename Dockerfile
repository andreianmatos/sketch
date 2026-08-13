# Hugging Face Spaces — Docker
# https://huggingface.co/docs/hub/spaces-sdks-docker
FROM node:22-slim AS ui
WORKDIR /ui
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html walk.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# CPU torch only (smaller / fits free Space)
RUN pip install --no-cache-dir -r requirements.txt \
    --extra-index-url https://download.pytorch.org/whl/cpu

COPY generate/ generate/
COPY data/generate/pens.json data/generate/pens.json
COPY data/generate/style_dictionary.json data/generate/style_dictionary.json
COPY data/generate/stroke_library.json data/generate/stroke_library.json
COPY data/generate/stroke_model/ data/generate/stroke_model/
COPY data/generate/icons/ data/generate/icons/
COPY --from=ui /ui/dist dist/

ENV PYTHONPATH=/app
ENV PORT=7860

EXPOSE 7860

CMD ["python3", "generate/server.py"]
