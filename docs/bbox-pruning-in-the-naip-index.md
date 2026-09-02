# The NAIP index's bbox shape defeats row-group pruning

**Status:** measured. A struct bbox cuts bytes fetched by 53% on a tile that hits
and 82% on one that misses, on `ca/2022`. That is worth doing, but one number in
this repo disagrees with it and has to be reconciled first — see "What still has
to be checked".

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

### 2. Physical layout — already done

This was drafted as the second half of the job. It is not: the writer already
does both parts.

- Rows are sorted by `ST_Hilbert(src.geometry, region_bounds.ext)` with explicit
  per-region bounds ([build_stac_index.py:179](../app/api/build_stac_index.py:179)).
  Measured locality on published `ca/2022`: **15.4% mean row-group extent** as a
  fraction of the file's own box (23.9 / 12.7 / 13.8 / 14.0 / 21.9 / 5.9%).
- `row_group_size` is 2048, which is DuckDB's floor — it clamps to a multiple of
  its vector size, so nothing smaller is possible. Published layout is
  `[2048 × 5, 830]`.

So per-dimension statistics land on a file that is already clustered tightly
enough for them to bite, which is why the numbers below are as large as they are.
No re-sort is needed, and the geoparquet-io STR ordering this note previously
pointed at would replace an ordering already measured as sufficient.

## What was measured

`app/api/bench_bbox_pruning.py` rewrites one partition four ways — {bbox array,
bbox struct} × {`V2` writes geo_bbox, `V1` does not} — holding row order and
row-group size fixed, then serves each over a range-honouring loopback HTTP
server and records every byte range DuckDB requests. No AWS, no charges,
deterministic.

`ca/2022`, z15-sized envelope, `bbox + geometry` predicate, DuckDB's Parquet
prefetcher left on because that is what the Lambda consumer runs with:

| tile | variant | bytes fetched | distinct | row groups |
|---|---|---:|---:|---|
| hit | array (published) | 495,993 | 446,077 | 6/6 |
| hit | **struct** | **234,518** | **183,110** | **1/6** |
| miss (inside extent) | array (published) | 389,165 | 339,249 | 6/6 |
| miss (inside extent) | **struct** | **70,048** | **18,640** | **0/6** |

**−53% on a hit, −82% on a miss**, and the row-group count moves from "all of
them" to "the one that can contain the answer". Turning geo_bbox off changes
none of it (`array-v1` and `struct-v1` land within 600 bytes of their `V2`
counterparts), which is the evidence for the inert-statistics finding above.

Two side observations from the same run: a `geometry`-only predicate reads *more*
than the bbox filter in every variant and never prunes, so the consumer's
filter-and-refine shape is right; and `struct-covering` (covering added, geo_bbox
lost to the pyarrow rewrite) is worse than `struct-v2` on every measure.

## What still has to be checked

**The one number that disagrees.** The writer's own docstring records a
spec-compliant schema that was built, measured from Lambda, and rejected:
−32% file size and −41 to −47% on queries matching nothing, against **+6–7% on
queries that DO match** ([build_stac_index.py:38](../app/api/build_stac_index.py:38)).
The measurement here says a hit gets *better*, by a lot. The likely explanation
is that the rejected variant changed more than the bbox: it also flattened
`properties` to top-level columns, taking the schema from 8 columns to ~15, and
the docstring attributes the regression to footer parsing rather than to the
bbox. If that is right, the earlier rejection was decided by a variable that the
bbox change does not require. **Re-run the Lambda measurement against the
isolated change — struct bbox only, 9 columns, everything else identical —
before acting on either number.**

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

## Who this is for

Note the split. `threejs-cf-zxy-s1m` reads `collection=naip-visualization`,
which `build_stac_index.py` does **not** produce and cannot: the two source
buckets are not a perfect match (nj and fl have 2010/ under `naip-analytic` and
not under `naip-visualization`), so that collection has to be built from its own
bucket listing. Both collections are published, both carry the same DOUBLE[]
bbox, and both would need the change for the tiler to benefit.

Worth knowing before rewriting anything: the published files carry no
`asset_href`/`gsd` columns, which `build_stac_index.py` emits. What is live today
was not written by this repo's writer, so "change the writer" and "change the
published file" are not yet the same action.
