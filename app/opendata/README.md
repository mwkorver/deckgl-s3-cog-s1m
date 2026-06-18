# NAIP STAC Catalog — public dataset (`s3://cog-stac-catalog`)

A cloud-native, queryable catalog of the USDA **NAIP** 4-band COG tiles in the
public `naip-analytic` bucket. One row per quarter-quad COG, as a Hive-partitioned
**GeoParquet** index. Read-only, anonymous, `us-west-2`.

This directory holds the artifacts to publish it on the
[Registry of Open Data on AWS](https://registry.opendata.aws):

| File | What it is |
|------|------------|
| `cog-stac-catalog.yaml` | the RODA registry record (PR it to `awslabs/open-data-registry`) |
| `bucket-policy.json` | anonymous `GetObject` (manifest-index) + `ListBucket` + `GetBucketLocation` |
| `cors.json` | browser/DuckDB-wasm access (GET/HEAD from any origin) |

## Data layout

```
s3://cog-stac-catalog/
  manifest-index/
    state=<st>/naip_year=<yyyy>/data_0.parquet      # Hive partitions
```

**Schema** (one row per COG tile):

| column | type | meaning |
|--------|------|---------|
| `source_key` | string | object key in `naip-analytic`, e.g. `wa/2023/60cm/rgbir_cog/45116/m_4511601_ne_11_060_20230622_20230911.tif` |
| `state` | string (partition) | 2-letter state |
| `naip_year` | int (partition) | NAIP flight year |
| `resolution` | string | `30cm` / `60cm` / `100cm` |
| `quad` | string | USGS 1° block (e.g. `45116`) |
| `filename` | string | the COG filename |
| `product` | string | `rgbir` |
| `acq_date` | date | acquisition date (parsed from the filename) |

To read the actual pixels, prefix `source_key` with `s3://naip-analytic/`
(requester-pays, 4-band RGBIR COG).

## Query it (no infra)

```sql
-- DuckDB: which WA 2023 tiles exist, and where?
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
SELECT source_key, acq_date, quad
FROM read_parquet('s3://cog-stac-catalog/manifest-index/**/*.parquet',
                  hive_partitioning=true)
WHERE state='wa' AND naip_year=2023
LIMIT 10;

-- tile counts per state-year (coverage at a glance)
SELECT state, naip_year, count(*) tiles
FROM read_parquet('s3://cog-stac-catalog/manifest-index/**/*.parquet',
                  hive_partitioning=true)
GROUP BY state, naip_year ORDER BY state, naip_year;
```

Browse anonymously (region auto-discovered via `GetBucketLocation`):

```bash
aws s3 ls s3://cog-stac-catalog/ --no-sign-request
aws s3 ls s3://cog-stac-catalog/manifest-index/ --no-sign-request | head
```

## Publishing / maintenance (author, admin creds)

These are bucket-admin actions (`s3:CreateBucket`, `PutBucketPolicy`,
`PutBucketCors`) — run with admin/root, not the scoped deploy user.

```bash
REGION=us-west-2; B=cog-stac-catalog

# 1. create (out-of-band; this is the shared cross-account bucket, NOT stack-managed)
aws s3api create-bucket --bucket $B --region $REGION \
  --create-bucket-configuration LocationConstraint=$REGION
# allow a public bucket policy (block ACLs, allow policy)
aws s3api put-public-access-block --bucket $B --region $REGION \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false

# 2. public read/list/location + 3. CORS
aws s3api put-bucket-policy --bucket $B --region $REGION --policy file://bucket-policy.json
aws s3api put-bucket-cors   --bucket $B --region $REGION --cors-configuration file://cors.json
```

Refresh the catalog as new NAIP is published (see `../api/refresh_manifest_index.py`):

```bash
python ../api/refresh_manifest_index.py --years-from 2022 \
    --index s3://cog-stac-catalog/manifest-index
```

## TODO: STAC compliance

The project is "cog-stac" but the catalog is currently a bare GeoParquet
tree. Emitting a STAC `catalog.json` / `collection.json` (or **stac-geoparquet**)
from the same rows would make it discoverable by every STAC client (pystac,
stac-browser, the QGIS STAC plugin) — the natural next step for RODA reach. The
index already carries geometry/CRS to generate it.
