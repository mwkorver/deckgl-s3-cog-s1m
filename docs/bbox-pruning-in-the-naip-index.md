# The NAIP index's bbox shape defeats row-group pruning

**Status:** settled, with a different change to make than the one proposed.

The bbox change loses: a struct bbox cuts bytes fetched by 41-53% on a tile that
hits and is **17.6% SLOWER** from Lambda in-region on exactly that tile, because
it needs more S3 round trips to fetch those fewer bytes. The rejection recorded
in `build_stac_index.py` stands.

But the mechanism that sank it points at a change that wins. Round trips, not
bytes, are what cost: re-encoding each partition to **two row groups and zstd**
is **21-24% faster cold** on the partitions where it applies, needs no schema
change, no consumer change, and no tiler deploy. See "What to do instead".

Bytes were the wrong metric throughout. That is the finding; the rest of this
note is the record of arriving at it.

Reproduce with `python app/api/bench_bbox_pruning.py matrix`.

The GeoParquet index this project publishes stores its bounding box in a shape
that Parquet statistics cannot use for spatial filtering. Consumers still get a
fast query, but for a different and weaker reason than they might assume. This
note records what was observed, what was then measured, and what is left.

Observed from the consumer side by `threejs-cf-zxy-s1m`, whose tiler resolves
"which COGs intersect this tile?" against this index on every cold tile.

## What was observed

The mosaic query filters on the bbox columns and then refines with
`ST_Intersects`:

```sql
from read_parquet(?, hive_partitioning=true)
where bbox[1] <= ? and bbox[3] >= ?
  and bbox[2] <= ? and bbox[4] >= ?
  and ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))
```

That is the standard filter-and-refine shape, and it works: on `ca/2022` it
takes 11,070 quads down to between 4 and 26 before a single geometry is
decoded, 3.2x faster end to end than `ST_Intersects` alone, with identical
results. (Those figures are the consumer's, measured in that repo; the
byte-level numbers below are this repo's and reproducible here.)

But it is doing so **without skipping a single row group** — confirmed below,
6/6 groups read on every published-shape query measured. The saving is CPU
(geometries not decoded), not I/O (bytes not fetched). On a remote object store
that is the less valuable of the two.

## Why the statistics cannot help

Parquet stores a min and a max per column, per row group. A reader can consult
those in the footer and skip a whole row group without fetching its bytes.

STAC stores the bounding box as `bbox: DOUBLE[]` — one column holding four
numbers, `[west, south, east, north]`. Parquet encodes a list as a single
repeated **leaf** column, so values from all four positions land in the same
column chunk and the min/max is computed across the lot of them, mixed
together.

The result is a statistic that is true and useless. On `ca/2022` every row group
records a min that is a **longitude** and a max that is a **latitude**:

```
bbox, list, element   rg0   min -123.2526   max  39.0646
bbox, list, element   rg1   min -121.8786   max  42.0651
```

The footer says "this row group contains numbers between -123 and 39", from
which nothing about spatial overlap can be concluded. No group is ever skipped.

Two indexes in the same system do not have this problem, for two different
reasons:

| index | bbox shape | statistics usable? |
|---|---|---|
| Overture buildings | `STRUCT{xmin,ymin,xmax,ymax}` | yes — each field is its own leaf column |
| S1M DEM index | flat `bbox_xmin` … `DOUBLE` columns | yes — same, by a different route |
| **NAIP imagery (this one)** | **STAC `DOUBLE[]`** | **no — one shared leaf** |

### The geometry column's statistics exist, and are inert

The published files are not statistics-free. Because `build_stac_index.py`
writes `geoparquet_version 'V2'`, every row group carries GeospatialStatistics
on the geometry column — a real per-dimension box, 6/6 groups on both
`naip-analytic` and `naip-visualization`:

```
rg0 geo_bbox {xmin -123.2526, xmax -119.2458, ymin 33.1843, ymax 39.0646}
```

So "the bbox column prunes nothing" and "nothing prunes" are separate claims,
and the second one needed its own measurement. It got one: writing the same
partition with `V1` instead (0/6 groups carry `geo_bbox`) changes bytes fetched
by **under 600 bytes on every query in the matrix**. DuckDB 1.5.3 does not prune
on these statistics. They are written, correct, and unused — so the conclusion
above survives, for a reason the first draft of this note did not state.

Keep writing them anyway: they cost nothing, they are what the format specifies,
and a reader that does use them is a version bump away.

**RE-TEST TRIGGER: when a reader starts pruning on GeospatialStatistics.** That
is the assumption this whole note rests on, it is the one most likely to expire,
and it will expire quietly — nothing breaks, the index just stops being shaped
for the reader it has.

It matters because of what was done in response. Consolidating each partition to
two row groups was free *only because nothing prunes*: with an inert statistic,
extra groups cost a round trip each and buy nothing. The moment a reader can use
`geo_bbox`, row-group count stops being free and becomes a granularity
trade — a two-group file can skip at most half of itself, where the original
six-group `ca/2022` could have skipped five of six. The statistics are still
written, so the capability is not lost; only the resolution is coarser.

How to check, cheaply: rebuild one partition with `geoparquet_version 'V1'` (0/N
groups carry `geo_bbox`) and compare against `'V2'` on a tile that misses. Today
they land within 600 bytes of each other. When they stop doing so, re-run the
row-group sweep before assuming two is still right.

Worth knowing alongside this: the files declare GeoParquet `"version": "2.0.0"`,
which as of 2026-09 exists only as `v2.0.0-rc.1` (July 2024) — the latest stable
spec is 1.1.0. That is sanctioned rather than sloppy: the RC says it "uses the
2.0.0 version numbers so that writers don't need to produce weird version
numbers". But it does mean these files track a spec that can still change, and
the reader behaviour above is part of what is still settling.

## The fix is a schema change

### 1. Schema

Replace `bbox: DOUBLE[]` with a struct (`bbox: {xmin, ymin, xmax, ymax}`) or
four flat `DOUBLE` columns. Either gives each dimension its own leaf column and
therefore its own min/max. Keeping the original STAC `bbox` array alongside
costs little and avoids breaking consumers that read it.

GeoParquet **`covering`** declares to a reader which columns bound the geometry,
and this index declares none. It is worth adding — but note that DuckDB does not
need it (the struct results below are DuckDB pruning on plain column statistics,
with no covering declared) and does not write it, even when the struct is named
`bbox`. Adding it via a pyarrow rewrite **drops the geo_bbox statistics**
(verified: 6/6 groups before, 0/6 after) and produces a slightly larger, slightly
slower file. If covering is wanted, it needs a footer-metadata patch that leaves
the page data alone, not a round-trip.

### 2. Physical layout — done for one collection, not the other

This was drafted as the second half of the job. For `naip-analytic` it is
already done; for the collection the tiler actually reads it is not.

- `row_group_size` is 2048 in both, which is DuckDB's floor — it clamps to a
  multiple of its vector size, so nothing smaller is possible. Published layout
  is `[2048 × 5, 830]`.
- Clustering differs sharply. Measured mean row-group extent as a fraction of
  each file's own box, `ca/2022`:

  | collection | locality | why |
  |---|---:|---|
  | `naip-analytic` | **15.4%** | inherited from a lake that already arrived clustered |
  | `naip-visualization` | **42.2%** | nothing sorted it |

  Neither was sorted at publication time — the generator has no `ORDER BY` (see
  "Where the published files come from"). `build_stac_index.py:179` does sort, by
  `ST_Hilbert(src.geometry, region_bounds.ext)` with explicit per-region bounds,
  but it did not write these files.

So for `naip-analytic` the per-dimension statistics land on a file that is
already clustered tightly enough for them to bite. For `naip-visualization` a
Hilbert sort is real work still on the table, and it is free in the same pass as
the schema change — it is why that collection prunes to 2/6 groups on a hit where
`naip-analytic` reaches 1/6.

## What was measured

`app/api/bench_bbox_pruning.py` rewrites one partition four ways — {bbox array,
bbox struct} × {`V2` writes geo_bbox, `V1` does not} — holding row order and
row-group size fixed, then serves each over a range-honouring loopback HTTP
server and records every byte range DuckDB requests. No AWS, no charges,
deterministic.

`ca/2022`, z15-sized envelope, `bbox + geometry` predicate, DuckDB's Parquet
prefetcher left on because that is what the Lambda consumer runs with:

`collection=naip-analytic`:

| tile | variant | bytes fetched | distinct | row groups |
|---|---|---:|---:|---|
| hit | array (published) | 495,993 | 446,077 | 6/6 |
| hit | **struct** | **234,518** | **183,110** | **1/6** |
| miss (inside extent) | array (published) | 389,165 | 339,249 | 6/6 |
| miss (inside extent) | **struct** | **70,048** | **18,640** | **0/6** |

`collection=naip-visualization` — the one the tiler actually reads:

| tile | variant | bytes fetched | distinct | row groups |
|---|---|---:|---:|---|
| hit | array (published) | 499,313 | 448,118 | 6/6 |
| hit | **struct** | **294,717** | **242,032** | **2/6** |
| miss (inside extent) | array (published) | 392,746 | 341,551 | 6/6 |
| miss (inside extent) | **struct** | **72,602** | **19,917** | **0/6** |

**−53%/−41% on a hit, −82% on both misses**, and the row-group count moves from
"all of them" to "the one or two that can contain the answer". The serving
collection gains less on hits only because nothing ever sorted it — 2/6 rather
than 1/6, for the 42.2% locality above. Turning geo_bbox off changes none of it
(`array-v1` and `struct-v1` land within 600 bytes of their `V2` counterparts),
which is the evidence for the inert-statistics finding above.

The file-size effect is not consistent and should not weigh either way: the
struct variant is 14% larger than the array on `naip-analytic` and 1% smaller on
`naip-visualization`.

Two side observations from the same run: a `geometry`-only predicate reads *more*
than the bbox filter in every variant and never prunes, so the consumer's
filter-and-refine shape is right; and `struct-covering` (covering added, geo_bbox
lost to the pyarrow rewrite) is worse than `struct-v2` on every measure.

## The Lambda measurement, which reverses the conclusion

The docstring records **+6–7% on queries that DO match** for a rejected
spec-compliant schema ([build_stac_index.py:38](../app/api/build_stac_index.py:38)),
which the byte numbers above appeared to contradict. The hypothesis was that the
rejected variant changed more than the bbox — it also flattened `properties`,
taking the schema from 8 columns to ~15 — so the regression belonged to the
flattening, not the bbox.

**That hypothesis is wrong.** Measured from a Lambda in us-west-2, DuckDB 1.5.5,
against the isolated change (struct bbox only, 9 columns, everything else
identical), five cold containers per cell, variants interleaved:

| tile | array (published) | struct | |
|---|---:|---:|---|
| hit | 242.9 ms | 285.6 ms | **+17.6%** |
| miss | 208.3 ms | 111.2 ms | **−46.6%** |

Medians of cold-container first-query latency. The distributions do not overlap
on hits (array 225–255 ms, struct 270–443 ms). The miss figure lands inside the
docstring's own −41 to −47% band; the hit regression is real and larger than the
+6–7% it recorded.

### Why fewer bytes are slower

Request counts from the same queries explain it:

| tile | variant | requests | bytes |
|---|---|---:|---:|
| hit | array | 11 | 499,313 |
| hit | **struct** | **13** | **294,717** |
| miss | array | 10 | 392,746 |
| miss | **struct** | **4** | **72,602** |

On a hit, the struct's four separate bbox leaves are four column chunks to fetch
where the array had one, so pruning five row groups still costs **two extra round
trips**. In-region, S3 round trips dominate transfer for a file this size: 200 KB
saved does not pay for two more requests. On a miss the statistics prune before
any of that, so requests drop with the bytes and the win is real.

Warm containers are not the escape: with DuckDB's external file cache the whole
partition is in memory and every variant is ~46 ms, indistinguishable. The bbox
shape only matters on cold containers — which is precisely the "every cold tile"
case, and the case that just got worse.

### What this means

Do not change the schema. The workload is mostly hits — NAIP covers CONUS, so a
tile that matches nothing is an edge or coastal case — and the change trades the
common path for the rare one.

## What to do instead: fewer row groups

If round trips are the cost, the lever is whatever reduces them. Measured the
same way, on the tiler's real query (`ca/2022`, cold containers, n=5, median):

| variant | hit | vs published |
|---|---:|---:|
| published (snappy, 6 groups) | 269.8 ms | — |
| zstd, 6 groups | 247.9 ms | −8.1% |
| zstd + promoted `asset_href`/`gsd` | 281.2 ms | **+4.2%** |
| **zstd, 1 group** | **191.6 ms** | **−29.0%** |

Two things in that table are worth pausing on. Promoting the columns the tiler
digs out of JSON made it **slower** — two more column chunks, two more requests,
the same trap as the struct bbox. And the one-group variant **doubles the bytes
fetched on a hit** (1,006,568 against 554,176) while cutting requests from 11 to
4, and wins by 29% anyway.

### Where the knee is

Sweeping row-group count on the two largest partitions, warm-container method
with DuckDB's file cache disabled (which understates the effect — it reuses TLS
connections, and that is precisely the overhead fewer requests avoid):

| partition | published | 5-6 groups | 3 groups | **2 groups** | 1 group |
|---|---:|---:|---:|---:|---:|
| `tx/2022` (17,276 rows, 9 groups) | — | −20.7% | −29.6% | **−32.3%** | −28.1% |
| `ca/2022` (11,070 rows, 6 groups) | — | −1.8% | −23.5% | **−29.3%** | −22.9% |
| `la/2023` (3,286 rows, 2 groups) | — | +3.0% | +3.0% | +2.8% | −1.8% |

**Two is the optimum, not one.** One group is consistently worse than two — a
single chunk has to be fetched whole before decoding can start, where two overlap.
`la` is already at two groups and has nothing to gain, which is the point: the
target is a count, not a size.

Confirmed on cold containers, the honest measurement:

| partition | published | 2 groups | |
|---|---:|---:|---|
| `ca/2022` | 254.0 ms | 194.4 ms | **−23.5%** |
| `tx/2022` | 310.8 ms | 245.4 ms | **−21.0%** |

### How much of the collection this touches

Estimating rows from file size across all 79 `naip-visualization` partitions:

- 29 partitions (37%, but only 6% of rows) are already one row group — nothing to do
- 37 partitions (47%, 53% of rows) are at 2-3 groups — marginal
- 13 partitions (17%, **41% of rows**) are at 4+ groups — this is where the win is

So it is a minority of partitions carrying a plurality of the data, and the
largest partition in the collection (`tx/2022`, 9 groups) is the biggest winner.

### Applying it

`app/api/rewrite_index_layout.py` does the re-encode. It rewrites only partitions
at 3+ row groups (31 of 79 in `naip-visualization`), computes
`row_group_size = ceil(rows / 2)` per partition. Row count, column list, row
order and resulting group count are verified against the original *before* the
live object is replaced; any mismatch leaves the live file untouched and the
staged rewrite behind. `--apply` is required, the default is a dry run, and it
refuses to write to a bucket without versioning enabled.

Exercised end to end against a scratch copy of `ca/2022` and `tx/2022`: −27.0%
and −27.7% on disk, 6 and 9 groups down to 2, `geo` metadata and per-row-group
`geo_bbox` preserved, and the tiler's query returns the same row unmodified.
Cold-Lambda gain on the script's own output measured −16% to −24% across runs.

### Applied, 2026-09-02

Both published collections were re-encoded. 31 partitions in each; the rest were
already at 1-2 groups and were left alone.

| collection | rewritten | before | after | | rows after |
|---|---:|---:|---:|---|---|
| `naip-analytic` | 31 of 82 | 31,577,619 B | 22,268,548 B | −29.5% | 295,232 |
| `naip-visualization` | 31 of 79 | 31,578,439 B | 22,403,201 B | −29.1% | 292,357 |

Both row counts match what the original index plan recorded, so nothing was lost
or duplicated. No partition anywhere is above two row groups now.

Cold-Lambda latency against the retained backups, n=5, median:

| partition | before | after | |
|---|---:|---:|---|
| `naip-visualization` `tx/2022` (9 → 2 groups) | 312.2 ms | 235.1 ms | −24.7% |
| `naip-analytic` `tx/2022` (9 → 2 groups) | 327.9 ms | 233.1 ms | −28.9% |
| `naip-analytic` `ca/2022` (6 → 2 groups) | 269.9 ms | 212.9 ms | −21.1% |

No consumer changed: the tiler reads the bucket live and picked this up on its
next cold container, with no deploy.

The `manifest-index-backup/` copies this run made were deleted once the rewrite
was verified. The bucket now has **versioning enabled** (2026-09-03) with a
lifecycle rule keeping the two newest noncurrent versions, so a future overwrite
is recoverable without an explicit backup prefix — verified by rolling one
partition back from its version id.

One thing left undone deliberately: `build_stac_index.py`'s `DEFAULT_ROW_GROUP_SIZE`
is still 2048, so a regenerated partition would revert to the slow layout. The
docstring there explains why and points at `ceil(rows/2)`; changing a writer
default is a separate decision from re-encoding published files.

### What this contradicts

`build_stac_index.py:19` calls `row_group_size 2048` load-bearing, because
DuckDB's default collapses a partition into one row group "and destroys
row-group pruning entirely". The premise is right and the conclusion inverted:
with a `DOUBLE[]` bbox there is no row-group pruning to destroy, so small groups
buy nothing and cost a round trip each. 2048 is only load-bearing in a world
where the bbox is a struct — and that world measured slower.

Also outstanding:

- **More than one partition and more than two tiles.** `ca/2022` is 11,070 rows
  in 6 groups. Denser partitions, and tiles that match many quads rather than
  one, may behave differently.
- **Latency, not just bytes.** Loopback measures transfer, not S3 TTFB, and the
  struct variant issues a different number of requests. On Lambda, request count
  can matter as much as byte count.
- **The full-collection case.** These queries are scoped by partition glob to one
  state-year. The 295,232-row whole-collection read is where the earlier −41 to
  −47% was measured.
- **Reader support for GeospatialStatistics**, which is the re-test trigger above
  and the one that would change the conclusion rather than refine it.

## Where the published files come from

Traced 2026-09-02, because "change the writer" and "change the published file"
are not the same action and the difference decides the plan.

Provenance is two steps with different owners:

1. **Data — this repo.** `ingest_duckdb.py` builds the lakes.
   `collection=naip-analytic` comes from the `collection=naip` lake;
   `collection=naip-visualization` comes from a lake built by the ad-hoc
   descriptor path, which supports that bucket by name
   ([descriptors.py:147](../app/api/descriptors.py:147)) and whose output carries
   this pipeline's exact 15-column schema.
2. **Publication — nobody.** Projecting those lakes into 9-column STAC Items was
   done once, 2026-07-26, by inline DuckDB SQL in a plan document that lives in
   no repository. `build_stac_index.py` landed six days later and writes zstd
   plus `asset_href`/`gsd`; the published files are snappy with neither.

That generator explains every property measured here: snappy (no `COMPRESSION`
option), `[2048 × 5, 830]` (`ROW_GROUP_SIZE 2000` clamped up to the floor),
`geo_bbox` present (`GEOPARQUET_VERSION 'V2'`), the `DOUBLE[]` bbox
(`[bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax] AS bbox`), and the 42.2% locality
(no `ORDER BY`). The four per-dimension doubles the fix wants already exist in
the lake it read — the array is a lossy repackaging of columns upstream.

An earlier draft of this note said `naip-visualization` "has to be built from its
own bucket listing" and so was out of reach. Building it that way is exactly what
already happened; what is missing is wiring the projection step to that lake.

Two operational facts before rewriting anything: the tiler reads this bucket
**live** — never seeded, never copied into its per-account bucket — so a fix
propagates with no redeploy and a bad write breaks every deployment at once. And
the bucket had **versioning off** when this was written, making an overwrite
unrecoverable; it was enabled on 2026-09-03, keeping the two newest noncurrent
versions.
