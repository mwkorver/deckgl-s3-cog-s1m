# NAIP GeoParquet Coverage Index — public dataset (`s3://naip-stac-catalog`)

A cloud-native, queryable coverage index over the USDA **NAIP** 4-band COG tiles
in the public `naip-analytic` bucket. One row per quarter-quad COG, as a
Hive-partitioned **GeoParquet** dataset. Read-only, `us-west-2`.

> [!IMPORTANT]
> **This index is not STAC.** It is a purpose-built schema (see below), and the
> bucket name `naip-stac-catalog` is historical — a bucket cannot be renamed in
> place. The read API in this repo *does* serve valid STAC Items built from these
> rows (STAC 1.1.0 + projection v2.0.0 + grid v1.1.0), but the Parquet itself is
> not STAC. If STAC interoperability is the goal, the thing to adopt is
> [stac-geoparquet](https://github.com/stac-utils/stac-geoparquet), which
> specifies how STAC Items are stored in GeoParquet. That is a schema change, not
> a rename.

> [!WARNING]
> **The bucket currently has Requester Pays enabled** (`get-bucket-request-payment`
> returns `Payer: Requester`), which overrides the anonymous-read grants in
> `bucket-policy.json`. Anonymous requests fail with *"Anonymous users cannot
> invoke requests against Requester Pays buckets."* Every example below therefore
> authenticates and passes the request-payer flag. This contradicts the public-read
> intent the bucket policy encodes — decide which one is right before submitting
> the registry record, since a Registry of Open Data listing implies open access.

This directory holds the artifacts to publish it on the
[Registry of Open Data on AWS](https://registry.opendata.aws):

| File | What it is |
|------|------------|
| `naip-geoparquet-coverage-index.yaml` | the RODA registry record (PR it to `awslabs/open-data-registry`) |
| `bucket-policy.json` | anonymous `GetObject` (manifest-index) + `ListBucket` + `GetBucketLocation` — currently overridden by Requester Pays |
| `cors.json` | browser/DuckDB-wasm access (GET/HEAD from any origin) |

## Data layout

```
s3://naip-stac-catalog/
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

Both the index bucket and the imagery bucket are requester-pays, so DuckDB needs
credentials and `s3_requester_pays`:

```sql
-- DuckDB: which WA 2023 tiles exist, and where?
INSTALL httpfs; LOAD httpfs;
INSTALL aws; LOAD aws;
CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'us-west-2');
SET s3_requester_pays=true;

SELECT source_key, acq_date, quad
FROM read_parquet('s3://naip-stac-catalog/manifest-index/**/*.parquet',
                  hive_partitioning=true)
WHERE state='wa' AND naip_year=2023
LIMIT 10;

-- tile counts per state-year (coverage at a glance)
SELECT state, naip_year, count(*) tiles
FROM read_parquet('s3://naip-stac-catalog/manifest-index/**/*.parquet',
                  hive_partitioning=true)
GROUP BY state, naip_year ORDER BY state, naip_year;
```

Browse it (authenticated; `--no-sign-request` fails while Requester Pays is on):

```bash
aws s3 ls s3://naip-stac-catalog/ --request-payer requester
aws s3 ls s3://naip-stac-catalog/manifest-index/ --request-payer requester | head
```

## Publishing / maintenance (author, admin creds)

These are bucket-admin actions (`s3:CreateBucket`, `PutBucketPolicy`,
`PutBucketCors`) — run with admin/root, not the scoped deploy user.

```bash
REGION=us-west-2; B=naip-stac-catalog

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

# 4. check who pays. Returns Payer: Requester today, which defeats step 2.
#    To actually make it anonymously readable:
#      aws s3api put-bucket-request-payment --bucket $B --region $REGION \
#        --request-payment-configuration Payer=BucketOwner
#    Note that then the bucket owner pays all request + egress cost.
aws s3api get-bucket-request-payment --bucket $B --region $REGION
```

Refreshing the index as new NAIP is published is currently undocumented: the
`build_manifest_index.py` that the rest of the docs cite was removed in
`7818de7` (Phase 4a) and no replacement entry point was added. Resolve that
before publishing the registry record — a RODA dataset nobody can rebuild is
worse than no listing.
