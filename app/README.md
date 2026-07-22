# Local DeckGL S3 COG S1M prototype

This directory contains a local object-key-first prototype for:

- a DuckDB + GeoParquet "lake" index of NAIP, with **no database server**
- a lightweight Python STAC-like API
- ordered search results suitable for browser-side `deck.gl-raster`

The read and ingest paths both run entirely on an in-process DuckDB connection
over a partitioned GeoParquet tree. There is no PostGIS / Postgres container —
this matches the AWS Lambda serverless profile we are targeting.

## Design choices

- GeoParquet lake as the single store (`cache/exports/naip_rgbir_duckdb/`)
- source-of-truth is `source_bucket + source_key`
- `state`, `naip_year`, `product`, `resolution_dir`, and `filename` come from the object key
- `proj_epsg` and the footprint geometry are required
- `bbox_{xmin,ymin,xmax,ymax}` are materialized columns derived from the geometry
  (so bbox-first predicates prune Parquet files + row groups, just like a lake reader)
- rows are Hilbert-clustered per `state` so the bbox stats stay selective
- result ordering is NAIP-specific:
  - `naip_year desc`
  - `acquisition_date desc`
  - `gsd asc`
  - `source_key asc`

## Services

- `api`: Python service on `localhost:8089` (DuckDB in-process; no database server)

## Deploying to AWS

> **Deployment region: `us-west-2`**
>
> This application is intentionally region-locked because its principal COG
> source buckets, including `naip-analytic`, `njogis-imagery`, and
> `kyfromabove`, are in `us-west-2`. Deploying the Lambda APIs, GeoParquet lake,
> and viewer bucket in the same region minimizes latency and avoids cross-region
> S3 transfer charges. The foundation, read, and ingest templates reject other
> regions.

The AWS deployment has three independently managed stacks:

1. `deckgl-s3-cog-s1m-foundation`: retained S3 viewer/output bucket; created once. _(The
   CloudFront CORS/cache tile proxy was removed — the viewer reads public source
   COGs directly via their own CORS.)_
2. `deckgl-s3-cog-s1m-ingest`: container-image ingest Lambda; deployed when ingest code
   or dependencies change.
3. `deckgl-s3-cog-s1m-read`: container-image read Lambda; deployed frequently.

Run deployments from the `lambda/` directory:

```bash
cd app/lambda
./deploy-foundation.sh       # once
./deploy.sh                  # ingest -> read -> viewer
./deploy.sh --read-only      # update read + viewer without rebuilding ingest
./deploy.sh --ingest-only    # update only the ingest container
./deploy-read.sh --no-viewer # update only the read Lambda
```

`deploy-foundation.sh` is create-only by default. If the stack already exists,
it prints outputs without changing anything. If a legacy bucket exists outside
the stack, it refuses to create duplicates. Intentional foundation updates
require `./deploy-foundation.sh --update`. Foundation resources are tagged
`Application=deckgl-s3-cog-s1m`. The script and CloudFormation template both
enforce deployment in `us-west-2`.

**What it does (in order):**
1. Deploys the ingest stack and reads its `IngestUrl` output.
2. Passes that URL to the read stack as the `IngestUrl` parameter.
3. Builds/deploys the read Lambda and DuckDB layer.
4. Publishes the static HTML/JS viewer to the foundation S3 bucket.

The viewer contract is unchanged: it calls the read API's `/environment`
endpoint, which returns the configured ingest URL.

The ingest Lambda requires a shared token for write endpoints. Set it when
deploying the ingest stack:

```bash
export S3_COG_INGEST_TOKEN="$(openssl rand -base64 32)"
./deploy.sh --ingest-only
```

Callers must send that value as `x-ingest-token` or `Authorization: Bearer ...`.
For a private demo viewer, keeping `S3_COG_INGEST_TOKEN` set while running
`deploy-viewer.sh` also writes `window.S3_COG_INGEST_TOKEN` into `config.js` so
the browser ingest panel sends the token. Do not do this for a public viewer.

> The shared, author-published catalog (`s3://naip-geoparquet-index/manifest-index`,
> read-only) is consumed cross-account; deployers never write to it.

**Prerequisites** (one-time setup before first deploy):

| Tool | Install |
|------|---------|
| AWS CLI v2 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| SAM CLI | `brew install aws-sam-cli` |
| Docker (arm64) | Docker CLI with `docker-compose` available |
| pnpm (for viewer) | `npm install -g pnpm` then `pnpm install && pnpm build` at repo root |

**IAM (one-time per account):**

Create and assume the scoped demo deploy role `deckgl-s3-cog-s1m-deploy` described
in `lambda/iam/README.md`. Use short-lived SSO credentials rather than static
keys.

**Configure `.env`:**

```bash
cp .env.example .env
# Set AWS_PROFILE=deckgl-s3-cog-s1m-deploy
# Set S3_COG_LAKE_ROOT=s3://deckgl-s3-cog-s1m-<your-account-id>-us-west2/lake
# Set S1M_INDEX_URL=s3://deckgl-s3-cog-s1m-<your-account-id>-us-west2/lake/s1m/S1M_Products.parquet
# (the foundation stack creates this bucket and seeds lake/ from deckgl-s3-cog-s1m-seed-us-west2)
```

**Costs to expect:**

The dominant variable cost is **S3 requester-pays egress** from `naip-analytic`:
every COG tile the browser renders triggers a partial GET (~$0.09/GB out +
$0.0004/1000 requests). Lambda invocations and the S3-backed viewer are
negligible at light usage. Light exploration of a small area is cents or less;
sharing the viewer publicly or rendering many states at once can accumulate
meaningful charges.

The read template can create a monthly **Budget alarm**. Set these environment
variables when deploying the read stack:

```bash
BUDGET_ALERT_EMAIL=you@example.com MONTHLY_BUDGET_USD=10 ./lambda/deploy-read.sh
```

Alerts fire at 80% actual and 100% forecasted spend. After deploy, AWS sends
a confirmation email — click the link to activate it.

**Tear down:**

```bash
# Application Lambdas only; foundation bucket and data are kept:
lambda/teardown.sh --keep-bucket

# OR full teardown — both app stacks, foundation, and bucket data, behind a typed
# confirmation (does not touch the shared naip-geoparquet-index bucket):
lambda/teardown.sh
```

---

## Start

```bash
cd app
cp .env.example .env
docker-compose up --build
```

The Docker image builds the required JavaScript package outputs itself, then
copies the resulting `packages/*/dist` artifacts into the Python API image. A
host-side `pnpm build` is no longer required for self-deploy.

## AWS credentials

Local development and deployment use the SSO-assumed `deckgl-s3-cog-s1m-deploy` role:

1. Configure the `deckgl-s3-cog-s1m-deploy` profile as described in
   `lambda/iam/README.md`.
2. Authenticate the profile through AWS SSO.
3. Set `AWS_PROFILE=deckgl-s3-cog-s1m-deploy` in `.env`.

Docker Compose mounts `~/.aws` read-only so the container can resolve the
profile and its temporary session credentials. No IAM user or static access
keys are used. The API uses the role to sign requester-pays `naip-analytic`
requests server-side.

## Endpoints

- `GET /health`
- `GET /`
- `GET /collections`
- `GET /collections/naip`
- `POST /search` — reads the GeoParquet lake via the in-process DuckDB connection
- `GET /availability` — state → available NAIP years (powers the viewer dropdowns)
- `POST /s1m/tiles` — discovers USGS 3DEP Seamless 1-meter DEM tile footprints
- `POST /buildings/overture` — fetches terrain-seated building footprints from Overture Maps
- `POST /ingest/options`
- `POST /ingest/run`
- `GET /ingest/status/{job_id}`
- `GET /viewer/`

Example:

```bash
curl -sS http://localhost:8089/search \
  -H 'content-type: application/json' \
  -d '{
    "collections": ["naip"],
    "bbox": [-75.8, 38.9, -75.3, 39.1],
    "limit": 20
  }'
```

## Debug viewer

After the API is running, open:

- `http://localhost:8089/viewer/`

The viewer:

- queries `/search` using the current map extent
- draws returned footprints
- shows the returned source order in a side panel
- lets you filter by `state`, `year`, and `Max footprints` (search `limit`, capped at 1000)
- the **Year** dropdown is populated from `/availability` for the selected state, newest auto-selected
- can re-search automatically while you pan (`Auto search on pan`)

### Map layers

The control panel toggles these layers (all off by default):

- **NAIP Imagery (COG Tiles)** — renders the returned NAIP COGs directly in the
  browser via `deck.gl-raster` (MosaicLayer/COGLayer), reading the cloud-optimized
  GeoTIFFs over presigned S3 URLs. Footprints are decoupled from imagery: `/search`
  returns raw `s3://` hrefs (drawn instantly), and each COG is signed lazily,
  on demand, only when its tile enters the viewport (see below).
- **USGS NAIP Reference Imagery (WMS)** — USGS NAIP imagery via WMS, for visual
  comparison against the COG-rendered imagery.

An on-map HUD reports the active zoom (`z`) for the viewer layer and the CARTO
basemap.

## Ingest

Ingest writes the GeoParquet lake with `ingest_duckdb.py`: it reads the manifest
index, enriches matching assets via EarthSearch STAC (`proj:*`, year, state,
geometry), derives footprints from `proj:bbox` + `proj:epsg`, clusters by
`ST_Hilbert`, and writes a `state=/naip_year=/product=` partitioned GeoParquet
tree under `cache/exports/naip_rgbir_duckdb/`. No Postgres, no staging table.

The Data Ingest tab in the viewer drives this through `/ingest/run`; the same
script can be run directly:

```bash
docker-compose run --rm api python ingest_duckdb.py --states ri ct de nj
docker-compose run --rm api python ingest_duckdb.py --states de --latest-year-only --limit-per-partition 5
```

The prototype treats the NAIP analytic manifest as external runtime input, not
repo data. Download or mount it into
`app/cache/naip-analytic-manifest.txt` before building the index.

### Build the manifest index (run whenever the manifest is updated)

The published manifest is a flat ~404 MB, ~7M-line list of every object key in
the bucket (FGDC sidecars, original imagery, COGs, index artifacts). Scanning it
per ingest job is the slow part of the pipeline, so `build_manifest_index.py`
does the scan **once** and writes a small queryable index containing only the
RGBIR COG tiles (`*/rgbir_cog/*.tif` — the single COG product NAIP publishes):

```bash
docker-compose run --rm api python build_manifest_index.py
```

This produces a Hive-partitioned GeoParquet-style tree at
`cache/manifest_index/state=<st>/naip_year=<yr>/` (columns: `source_key, state,
naip_year, resolution, quad, filename, product, acq_date`). For scale, the
published copy at `s3://naip-geoparquet-index/manifest-index` is 17.7 MB across
328 partition files, 1,449,485 keys.

> [!NOTE]
> AWS froze `s3://naip-analytic/manifest.txt` at 2023-03-09, so a build from the
> manifest alone cannot see anything published since. `refresh_manifest_index.py`
> covers the gap: it lists recent-year prefixes off the live bucket and merges
> only those `(state, naip_year)` partitions, leaving the frozen history intact.
>
> ```bash
> docker-compose run --rm api python refresh_manifest_index.py --years-from 2022 --dry-run
> ```

An ingest job/chunk then does a millisecond pushdown read of one
partition (e.g. `manifest_index/state=tx/naip_year=2020/`) instead of
re-streaming the 404 MB text file.

The build is idempotent — each run clears and rewrites the tree, so it can't
accumulate stale keys. **Re-run it whenever AWS publishes a new manifest**
(infrequent); it is not part of the per-ingest hot path. Inputs/outputs are
overridable via `--manifest` / `--out` (or `S3_COG_MANIFEST_PATH` /
`S3_COG_MANIFEST_INDEX`); `--manifest` may be an `s3://` URL.

### Build the Overture buildings index (run whenever Overture cuts a release)

The viewer's optional **3D buildings layer** (terrain mode) follows the same
thin-index/stream-on-demand strategy as the imagery lake. Rather than materialize
building geometry, `build_overture_buildings_index.py` scans the public Overture
buildings release's parquet **footers** (metadata only) and writes one row per
row group whose bbox intersects CONUS — file key, row-group ordinal, row count,
and bbox extent (~8.5k rows, ~190 KB):

```bash
# Build locally (anonymous read of Overture's public us-west-2 bucket)...
docker-compose run --rm api python build_overture_buildings_index.py
# ...or build and publish straight to the seed lake in one step:
docker-compose run --rm api python build_overture_buildings_index.py \
  --upload-uri s3://deckgl-s3-cog-s1m-seed-us-west2/lake/overture-buildings/index.parquet
```

`/buildings/overture` bbox-prunes this index to the viewport, then reads **only
the matching row groups** straight from Overture's public S3 (anonymous, no
requester-pays) — so no footprint geometry lives in this repo or the bucket. The
index is published under the seed bucket's `lake/` prefix, so `deploy-foundation`
seeds it into each deployer's bucket automatically (no `SeedKeys` change). The
read API finds it via `S3_COG_OVERTURE_BUILDINGS_INDEX` (defaults to the seeded
`lake/overture-buildings/index.parquet`; falls back to a local clip from
`build_overture_buildings.py` for fully-offline runs). **Re-run whenever Overture
publishes a new release** (`--release`), updating the default in the script.

## Metadata strategies

`ingest_duckdb.py` supports two metadata strategies (`--strategy`):

### `manifest-earthsearch` (default)

- the manifest index defines the complete expected URL set
- EarthSearch supplies `proj:*`, `naip:year`, `naip:state`, and asset metadata
- stored footprints come from `proj:bbox` transformed from `proj:epsg` into `EPSG:4326`

Faster than opening every TIFF header; appropriate when EarthSearch coverage is
complete for the target state/year.

### `manifest-cog-headers`

- the manifest index still defines the URL inventory
- each matching COG is opened by range-read against the TIFF header
- raster-native metadata (projection, transform, size, bounds) comes directly from the file

Slower (one remote header inspection per COG) but independent of EarthSearch
completeness/freshness. Use it when EarthSearch is missing items, `proj:bbox`
looks suspect, or you need to validate metadata from the raster.

## Why DuckDB + GeoParquet

This prototype runs the whole read/ingest path with no database server, which is
exactly the AWS Lambda profile: a Lambda invocation opens an in-process DuckDB,
`read_parquet`s the lake (locally or over `s3://`), prunes by bbox columns +
row-group stats, and returns STAC features — no connection pool, no PostGIS.

## Lazy, per-tile URL signing (the innovative part)

The NAIP source bucket (`naip-analytic`) is **requester-pays** and the assets are
served over **presigned** S3 URLs signed with the Lambda execution role's
temporary STS credentials. The naive approach — batch-sign every asset URL inside
`/search` — has two problems:

1. **Latency coupling.** Nothing draws until *all* URLs are signed and the whole
   payload returns, so the first footprint waits on the last signature.
2. **Payload bloat.** Role-signed URLs carry an `X-Amz-Security-Token` (~700 bytes
   each), so a 50-feature search balloons the response with signatures the user
   may never look at (only on-screen tiles ever get fetched).

Instead, signing is **decoupled from search** and pushed to the point of use:

- **`POST /search`** returns raw `s3://` hrefs only — small, fast, and the
  footprint polygons paint immediately (server `sign-ms` is `0`). Server-side
  signing in `/search` is still available behind `S3_COG_SEARCH_SIGN_ASSETS` but is
  off by default.
- **`GET /sign?href=s3://…`** signs a *single* href on demand. The actual
  presigning still happens server-side (only the Lambda role holds the creds), but
  one URL at a time.
- The **viewer signs lazily, per tile.** `deck.gl-raster`'s `MosaicLayer` calls
  the app's `getSource(source, { signal, concurrencyLimiter, getPriority })` hook
  only for sources currently in the viewport. Our `getSource` (`resolveGeotiffSource`)
  calls `GET /sign` for that one COG, then hands the signed URL to
  `GeoTIFF.fromUrl(url, { signal, concurrencyLimiter, getPriority })`. So **only
  COGs that actually come on screen are ever signed.**

On top of the package's hook the viewer adds a thin client-side signing layer:

- a **`signedUrlCache`** keyed by `s3://` href, with a TTL just under the presign
  expiry, so panning back to a tile reuses its URL;
- **request coalescing** (`inflightSigns`) so concurrent loads of the same href
  issue a single `/sign` call;
- **403 / expired re-signing**: on a signature-expired error the cached URL +
  GeoTIFF are evicted and the tile is re-signed and reloaded.

Forwarding the layer's `concurrencyLimiter` and `getPriority` (euclidean distance
from each source's bbox center to the live viewport center) into `GeoTIFF.fromUrl`
also makes range reads fill **center-out** — tiles nearest the middle of the map
decode first, and the priority queue re-sorts as you pan.

This is the part worth lifting into other `deck.gl-raster` apps: the `getSource`
hook is the package's intended seam for turning a source descriptor into fetchable
data, and it's `async`, so per-tile credential/URL acquisition (signing,
requester-pays, token-vending) fits naturally there instead of being front-loaded
into the catalog/search response.
