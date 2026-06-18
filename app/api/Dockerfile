FROM node:24.11.1-slim AS js-builder

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages

RUN corepack enable && \
    pnpm install --frozen-lockfile && \
    pnpm build


FROM python:3.12-slim

WORKDIR /app

COPY app/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app/api/app.py ./app.py
COPY app/api/ingest_manifest.py ./ingest_manifest.py
COPY app/viewer ./viewer

COPY --from=js-builder /workspace/packages/deck.gl-geotiff/dist /repo-root/packages/deck.gl-geotiff/dist
COPY --from=js-builder /workspace/packages/geotiff/dist /repo-root/packages/geotiff/dist
COPY --from=js-builder /workspace/packages/deck.gl-raster/dist /repo-root/packages/deck.gl-raster/dist
COPY --from=js-builder /workspace/packages/affine/dist /repo-root/packages/affine/dist
COPY --from=js-builder /workspace/packages/proj/dist /repo-root/packages/proj/dist
COPY --from=js-builder /workspace/packages/morecantile/dist /repo-root/packages/morecantile/dist
COPY --from=js-builder /workspace/packages/raster-reproject/dist /repo-root/packages/raster-reproject/dist

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
