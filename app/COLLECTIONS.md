# Ingesting collections beyond NAIP

Design note for generalizing the Stage‑1 imagery ingest from "NAIP" to "any
state‑level COG collection." Discovery mechanism in scope: **S3 prefix listing**
(the COGs live under an `s3://` prefix we can `ListObjects`, and `region`/`year`
are inferable from the key path).

**Scope rule: COG only.** We ingest *Cloud Optimized GeoTIFF* exclusively — the
windowed chip reader (Stage 1, rasterio) needs COG/GeoTIFF. MrSID, JP2, and zipped
products are out of scope and filtered out (`cog_filter`); a dataset with no COG
representation is simply not registered. The candidate universe is therefore "the
COG aerial‑imagery collections in the AWS Registry of Open Data (RODA)" — see
[The collection registry](#the-collection-registry--the-map-lookup), which
enumerates the seven that exist today.

Status: **design only** — no code changed yet. This documents the seam to cut and
the descriptor/adapter shape, so the refactor lands deliberately.

---

## TL;DR

- The expensive core (`fetch_cog_metadata`, `ingest_manifest.py:558`) is **already
  collection‑neutral** — it reads geometry/CRS/transform/bbox/bands straight from
  COG headers and knows nothing about NAIP.
- The partition model is **already right** for state‑level collections:
  `collection / region / year`, where for any state‑level collection `region` =
  the state — same grain NAIP already uses (`state` / `naip_year`).
- What's hardcoded to NAIP is a thin shell: the **source bucket**, the **key
  parser**, the **discovery source**, and the **partition column names**.
- The generalization: turn NAIP into **descriptor #1** behind a small
  `CollectionDescriptor` + a `DiscoveryAdapter` interface. NAIP's manifest‑index
  reader becomes one adapter; a generic **S3‑prefix‑listing adapter** serves the
  new collections.

---

## The model: `collection / region / year`

Three universal partition axes — *what / where / when*:

| axis | meaning | NAIP value | KyFromAbove value |
|------|---------|------------|-------------------|
| `collection` | the dataset id | `naip` | `kyfromabove` |
| `region` | coarse spatial bucket | the state, parsed from key (`wa`) | the state, constant (`ky`) |
| `year` | acquisition/vintage year | `naip_year`, a path level (2023) | regex from product folder (2022) |

Finer, collection‑specific attributes (NAIP's `quad`, `resolution`, `product`;
another collection's tile id, band profile, sensor) live in a **`properties`
bag**, not as partitions. Keeping only `collection`/`region`/`year` as partitions keeps the tree small
and uniform across collections, while the variable per-collection detail rides
along in `properties`. (Partition **order** is an open decision — see
[Open decisions](#open-decisions).)

---

## Already generic vs NAIP‑hardcoded

| concern | where | today | after |
|---------|-------|-------|-------|
| **header → footprint** | `ingest_manifest.py:558` `fetch_cog_metadata` | generic (reads GeoTIFF tags) | unchanged; strip the `naip:` labels out of the payload into `properties` |
| **source bucket** | `ingest_manifest.py:299,301,565` literal `naip-analytic` | hardcoded | `descriptor.bucket` |
| **bucket access mode** | `ingest_manifest.py:565` `S3File(… request_payer="requester")` | hardcoded requester‑pays | `descriptor.access`: `requester-pays` (NAIP) \| `public` (unsigned, KyFromAbove) \| `private` |
| **key/filename parse** | `build_manifest_index.py:93‑104`, `parse_filename()` | NAIP key layout + DOQQ filename | `descriptor.key_parser` → `{region, year, properties}` |
| **discovery** | `build_manifest_inventory_from_index` `:219` | reads NAIP manifest index | `DiscoveryAdapter` (prefix‑listing for new collections) |
| **partition columns** | `ingest_duckdb.py:315,343‑358` (`partition_by`, Hilbert group), `:160` (reconcile keys), `build_manifest_index.py:108` | `state, naip_year, product` | `collection, region, year` (+ `properties`) |
| **read API / viewer** | `app.py` lake reads, viewer ingest panel | `state` / `naip_year` filters | `collection` selector → `region` / `year` |

The header reader is the hard part and it's done. Everything else is **naming and
configuration**.

---

## The collection descriptor

A small declarative record. NAIP is the first instance; a new state‑level
collection is just another instance.

```python
@dataclass(frozen=True)
class CollectionDescriptor:
    id: str                       # "naip", "kyfromabove", "vt-ortho", ...
    bucket: str                   # "naip-analytic" | "kyfromabove" | "vtopendata-prd"
    root_prefix: str              # "" (NAIP) | "imagery/orthos/" | "Imagery/_Tiles/VTORTHO/"
    access: str                   # "requester-pays" | "public" (unsigned) | "private"
    discovery: DiscoveryAdapter   # how to enumerate keys (below)
    cog_filter: Callable[[str], bool]            # which keys are ingestable COG tiles
    key_parser: Callable[[str], KeyFields | None]  # key -> region / year / properties

@dataclass(frozen=True)
class KeyFields:
    region: str    # NAIP: state parsed from the key ("wa").
                   # KyFromAbove: the constant "ky" — the collection *is* the state.
    year: int      # NAIP: a path component.  KyFromAbove: regex from the product folder.
    properties: dict
```

`region` is deliberately *whatever the collection says it is*: a key‑parsed field
for NAIP, a **constant** for a whole‑state collection like KyFromAbove. That is
the literal meaning of "these collections tend to be state‑level" — the
collection equals one state, so `region` has cardinality 1 and the partition tree
still lines up next to NAIP's per‑state partitions.

A descriptor is scoped to **one product within a bucket**, not a whole bucket —
that is what `root_prefix` is for. Vermont's `vtopendata-prd` holds *several*
products under different layouts (flat statewide mosaics, tiled `VTORTHO`,
`HISTORIC` scans); each is its own descriptor with its own `root_prefix`,
`key_parser`, and `cog_filter`. Registering a collection is choosing a coherent
product, not adopting a bucket wholesale.

NAIP's descriptor reproduces today's behavior exactly:

```python
NAIP = CollectionDescriptor(
    id="naip",
    bucket="naip-analytic",
    root_prefix="",                       # state/ is the top level
    access="requester-pays",
    discovery=ManifestIndex(root="s3://naip-stac-catalog/manifest-index"),
    cog_filter=lambda k: k.endswith(".tif") and "/rgbir_cog/" in k,
    key_parser=parse_naip_key,   # state/year/res/.../quad/...  ->  KeyFields
)
```

---

## The discovery adapter (S3 prefix listing)

One interface, two implementations to start:

```python
class DiscoveryAdapter(Protocol):
    def enumerate(self, regions: set[str], years: set[int] | None,
                  limit_per_partition: int) -> dict[str, ManifestRow]:
        """asset_href -> {bucket, key, region, year, properties}."""
```

- **`ManifestIndex`** — today's NAIP path (`build_manifest_inventory_from_index`),
  unchanged. NAIP's `manifest.txt` is a *pre‑published, frozen S3 listing*; we
  index it once and prune by partition. It is just a cached, optimized special
  case of prefix listing.
- **`S3PrefixListing`** — the new primary path. `ListObjectsV2` under the
  collection's prefix, filter with `cog_filter`, parse each key with
  `key_parser`.

### Deriving `region` / `year` from the key

Three patterns, all real (NAIP and KyFromAbove between them hit all three):

- **`region` in the key** (NAIP: `wa/2023/…`) — `key_parser` splits it out.
- **`region` constant** (KyFromAbove: the whole bucket is Kentucky) —
  `key_parser` returns the fixed `"ky"`; nothing to parse.
- **`year` not a clean path level** (KyFromAbove: it lives inside the product
  folder `KY_KYAPED_2022_6IN`) — `key_parser` regexes `KY_KYAPED_(\d{4})_`. As a
  last resort `year` can fall back to the COG's acquisition date (the header
  reader already extracts it), but a folder/key regex is cheaper and exact.

So `key_parser` is the single per‑collection function that absorbs *all* of a
collection's layout quirks and emits the uniform `KeyFields`. Everything
downstream sees only `region` / `year` / `properties`.

### Narrowing the listing (cost)

Listing must **not** crawl an entire multi‑million‑key bucket per job — but a
single `{region}/{year}/` prefix template is too rigid (it assumes those are the
leading path components; KyFromAbove buries `year` in a product‑folder name and
has no `region` segment at all). So the descriptor declares a **function**, not a
template. The `S3PrefixListing` adapter implements its `enumerate()` on top of a
per‑collection narrowing hook:

```python
def enumerate_prefixes(region: str, year: int) -> list[str]:
    """The S3 prefixes to ListObjectsV2 for this (region, year)."""
```

- **NAIP** returns one templated prefix → `["wa/2023/"]` (one targeted list).
- **KyFromAbove** does a cheap two‑level walk: list the product *folders* under
  `imagery/orthos/Phase*/` with `Delimiter='/'`, keep those whose names match
  `KY_KYAPED_{year}_*`, and return them →
  `["imagery/orthos/Phase2/KY_KYAPED_2022_6IN/", "imagery/orthos/Phase2/KY_KYAPED_2022_3IN/", "imagery/orthos/Phase3/KY_KYAPED_2022_Season2_3IN/"]`.
  Then `ListObjectsV2` each and apply `cog_filter`.

The folder‑name listing is tiny (a handful of `CommonPrefixes`), so even though
`year` isn't a top‑level path component the narrowing stays cheap. Only when even
the folder set is huge do you fall back to indexing once (below).

### List‑on‑demand vs build‑index‑once

- **Small / narrowable** collection → list on demand each job. Simple.
- **Large** collection (NAIP‑scale) → run a one‑time `build_*_index` (the
  `S3PrefixListing` crawl written to a partitioned Parquet index), then ingest
  jobs do a pushdown read — exactly NAIP's `build_manifest_index.py` pattern,
  generalized. The index columns become `collection / region / year` instead of
  `state / naip_year`.

---

## Completeness reconciliation comes for free

For NAIP we added `reconcile_completeness` (`ingest_duckdb.py:155`) because the
EarthSearch discovery path silently dropped tiles. With **prefix listing the
listing *is* the authoritative inventory** — there is no second source to drift
from. So "did we ingest everything?" reduces to "did every listed key parse a
header?", which `process_manifest_cog_headers` already reports as
`matched=… failed=…` (`ingest_manifest.py:684`). The reconcile step generalizes
to keying on `(collection, region, year)` and comparing listed‑vs‑ingested; a
shortfall now means *header parse failures*, not a discovery gap.

---

## Worked example: KyFromAbove (real)

[KyFromAbove](https://registry.opendata.aws/kyfromabove/) — Kentucky's statewide
aerial program, an AWS Open Data set. A clean second collection *and* a useful
contrast to NAIP: **public/unsigned** (not requester‑pays), `region` is a
**constant** (the bucket is all Kentucky), and `year` is **buried in a
product‑folder name**.

Observed layout (`aws s3 ls --no-sign-request s3://kyfromabove/imagery/orthos/`):

```
imagery/orthos/{Phase}/KY_KYAPED_{year}_{res}/{tile}_{year}_{res}_cog.tif
  e.g.  imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tif
        imagery/orthos/Phase1/KY_KYAPED_2014_1FT/...
        imagery/orthos/Phase3/KY_KYAPED_2023_Season1_3IN/...
```

- `region` — none in the key; the whole collection is Kentucky → constant `"ky"`.
- `year` — inside the product folder `KY_KYAPED_2022_6IN` → regex `_(\d{4})_`.
- `properties` — `phase` (`Phase2`), `kyaped:resolution` (`6IN`/`3IN`/`1FT` — a
  *nominal* label; true GSD comes from the COG header), `season` (Phase 3 only),
  `kyaped:tile` (`N013E300`, a northing/easting grid id).
- `cog_filter` — keep `*_cog.tif`; drop `.tfw` sidecars and the non‑tile folders
  (`Overviews/`, `Metadata/`, `TileGrid/`, `County-Mosaics/`,
  `FlightInformationData_*`).

```python
import re

def ky_key_parser(key: str) -> KeyFields | None:
    m = re.search(r"KY_KYAPED_(\d{4})(?:_Season(\d))?_(\w+?)_cog\.tif$", key)
    if not m:
        return None
    year, season, res = m.group(1), m.group(2), m.group(3)
    parts = key.split("/")
    return KeyFields(
        region="ky",                      # the collection *is* the state
        year=int(year),
        properties={
            "phase": parts[2],            # imagery/orthos/Phase2/...
            "kyaped:resolution": res,     # 6IN | 3IN | 1FT  (nominal; GSD from header)
            "season": int(season) if season else None,
            "kyaped:tile": parts[-1].split("_")[0],   # N013E300
        },
    )

def ky_enumerate_prefixes(region: str, year: int) -> list[str]:
    # list the product folders, keep KY_KYAPED_<year>_*, return them
    out = []
    for phase in ("Phase1", "Phase2", "Phase3"):
        for pre in list_common_prefixes(f"imagery/orthos/{phase}/"):  # Delimiter='/'
            if re.search(rf"/KY_KYAPED_{year}(_Season\d)?_\w+/$", pre):
                out.append(pre)
    return out

KYFROMABOVE = CollectionDescriptor(
    id="kyfromabove",
    bucket="kyfromabove",
    root_prefix="imagery/orthos/",
    access="public",                      # unsigned reads; no RequestPayer header
    discovery=S3PrefixListing(enumerate_prefixes=ky_enumerate_prefixes),
    cog_filter=lambda k: k.endswith("_cog.tif") and not any(
        seg in k for seg in ("/Overviews/", "/Metadata/", "/TileGrid/",
                             "/County-Mosaics/", "FlightInformationData")),
    key_parser=ky_key_parser,
)
```

Ingest is then `--collection kyfromabove --regions ky --years 2022`. Nothing in
the header reader, the Hilbert clustering, the GeoParquet write, the read API, or
the viewer is collection‑aware beyond the descriptor id and the `region`/`year`
columns — KyFromAbove lands at `collection=kyfromabove/region=ky/year=2022/`,
right next to `collection=naip/region=wa/year=2023/`.

> Note: KyFromAbove also publishes a STAC API, so a `Stac` adapter is possible
> later. We chose prefix listing here; the STAC endpoint is a fallback if the key
> layout ever changes underneath us.

## Worked example 2: Vermont (one bucket, several products)

[Vermont Open Geospatial](https://registry.opendata.aws/vt-opendata/) —
`s3://vtopendata-prd` (us‑east‑2, public, COG‑only). It teaches the lesson the
`root_prefix` field exists for: a single bucket carries **several products with
different layouts**, so you register the *product*, not the bucket.

Under `Imagery/` there are at least two representations of the same orthos:

```
# (a) statewide single-file mosaics, flat under Imagery/, everything in the filename
Imagery/2013_15cm_LeafOFF_4Band.tif          #  98 GB
Imagery/2018_30cm_LeafOFF_4Band.tif          # 190 GB
Imagery/2016-2019_30cm_LeafOFF_4Band.tif     # 333 GB  <- year is a RANGE

# (b) tiled VTORTHO — NAIP-shaped: year is a clean path level
Imagery/_Tiles/VTORTHO/{res}/{profile}/{year}/COGS/VT_{tile}_{yyyymmdd}.tif
  e.g.  Imagery/_Tiles/VTORTHO/0_3M/CLRIR/2013/COGS/VT_100_20130422.tif
```

Four lessons:

1. **Register the tiled product.** `root_prefix="Imagery/_Tiles/VTORTHO/"`, year
   a path level, tile id + date in the filename — its `key_parser` /
   `enumerate_prefixes` are essentially NAIP's. `res` (`0_3M`→0.3 m) and
   `profile` (`CLRIR`=4‑band, `PAN`=1‑band) are path segments → `properties`.
   This confirms the S3‑prefix adapter generalizes with no new machinery.
2. **Year‑as‑range is real** (`2016-2019`), but it only appears in the *mosaic*
   representation; the tiled product has clean single years. Picking the tiled
   product sidesteps it. If a range mosaic is ever ingested, partition by a single
   representative year (the end/most‑recent) and keep the full `year_range` in
   `properties` — see [Open decisions](#open-decisions).
3. **The model is representation‑agnostic.** Even a 333 GB statewide mosaic
   ingests cleanly: the header reader emits **one** footprint row (the statewide
   extent), and Stage‑1 cuts chips by *windowed* reads — it never downloads the
   whole COG. Tiles aren't required; they just yield a richer catalog (thousands
   of rows → finer bbox pruning) instead of one giant row.
4. **Rich properties that matter for SAM.** `LeafOFF` vs `LeafON`,
   `1Band`/`3Band`/`4Band` (PAN/RGB/RGBN), and resolutions down to 13 cm all live
   in `properties` and feed the grounding/feasibility layer — e.g. leaf‑off
   reveals the ground for building/parking detection; a 1‑band PAN mosaic is
   grayscale (a real SAM input caveat, not an ingest one).

---

## Worked example 3: New Jersey (mixed formats in one layout)

[NJ Statewide Imagery](https://registry.opendata.aws/nj-imagery/) —
`s3://njogis-imagery` (us‑west‑2, public). Year is the top level and `region` is
constant `"nj"`, so it's NAIP‑shaped and needs no new machinery — except for one
new lesson: **format is a discriminator inside the layout.**

```
2020/cog/A15B12.tif      <- COG  (ingestable)
2020/MG3/A15B12.zip      <- MrSID, zipped   |  same tile, other formats
2015/sid/...             <- SID              |  we don't ingest these
```

- `root_prefix=""`, `enumerate_prefixes("nj", 2020) -> ["2020/cog/"]`,
  `cog_filter = k: k.endswith(".tif") and "/cog/" in k`. The COG pipeline targets
  the `cog/` sibling and ignores the MrSID/JP2/zip ones.
- **Years with no `cog/` folder are simply unavailable** to a COG pipeline (NJ's
  1930/1970 scans are SID/JP2 only). Discovery returns nothing for them — correct,
  not an error. (A future MrSID/JP2 reader is a separate concern; our windowed
  chip reader is COG/GeoTIFF‑only.)
- **The grid scheme is opaque on purpose.** NJ's tile ids (`A15B12`) are a
  state‑plane grid that "varies by collection year" — we never decode it; the
  footprint comes from the **COG header**, and the tile id rides along in
  `properties` as a provenance label. This is why no per‑year grid logic is
  needed.

This sharpens the completeness rule: the denominator is the **`cog_filter`‑eligible
keys**, not every key under `{year}/` (which includes zips and sidecars).

## Pattern coverage (four real datasets)

Every quirk below is absorbed by `key_parser` + `enumerate_prefixes` + `cog_filter`;
the rest of the pipeline only ever sees `region / year / properties`.

| dataset | access | `region` | `year` | layout / new lesson |
|---------|--------|----------|--------|---------------------|
| **NAIP** | requester‑pays | key‑parsed (`wa`) | path level | per‑state tiles; pre‑published manifest index |
| **KyFromAbove** | public/unsigned | constant (`ky`) | regex from product folder | 2‑level prefix walk; `region` as a constant |
| **Vermont** | public/unsigned | constant (`vt`) | path level **or** range | one bucket, several products → `root_prefix`; mosaic *or* tiles |
| **New Jersey** | public/unsigned | constant (`nj`) | path level | mixed formats per year → `cog_filter` picks `cog/`; opaque grid |

What stays constant across all four: the **COG‑header reader produces the
footprint** (no collection ever needs its grid/tile scheme decoded), and the
**partition is always `collection / region / year`** with everything else in
`properties`.

## The collection registry & the map lookup

The worked examples above are the *ingest* mechanics for one collection. Stepping
up a level: with several collections in play, the app needs to answer **"which
collections cover where the user is looking right now?"** — pan to Kentucky and
surface NAIP + KyFromAbove; pan to Colorado and surface NAIP + Colorado. That is a
second, coarser layer above the footprint lake.

### Two layers

| layer | grain | answers | size |
|-------|-------|---------|------|
| **0 — collection registry** | one row per collection | "what collections exist, and where/when do they cover?" | tens of rows (a curated file) |
| **1 — footprint lake** | one row per COG | "which COGs are in *this* collection / region / year, and exactly where?" | millions of rows (`collection/region/year` GeoParquet) |

The registry is the **lookup table** you described. It is small, curated, and
STAC‑Collection‑shaped (each entry ≈ a STAC `Collection` with a spatial + temporal
extent). The footprint lake is the STAC `Item` level we already designed.

### Map interaction

```
viewport bbox ──▶ Layer 0: registry entries whose extent intersects the bbox
              ──▶ show collection names (NAIP, KyFromAbove, Colorado, …)
   user picks a collection + year
              ──▶ Layer 1: load that collection's footprints / imagery for the view
```

Because extents are coarse (a state polygon / CONUS / a country bbox) and there
are only tens of collections, the intersect is trivial — ship the registry to the
viewer as a tiny `collections.geojson` and filter it client‑side on `moveend`, no
server round‑trip. (The expensive, fine‑grained "exactly which tiles are here"
question stays in Layer 1, queried only after the user commits to a collection.)

### Registry entry schema

Each entry carries both halves: the **extent** (for the map lookup) and the
**descriptor** (for ingest), so the registry is the single source of truth.

```yaml
- id: kyfromabove
  title: KyFromAbove (Kentucky)
  extent:
    region_code: KY              # resolves to a state polygon for precise lookup
    bbox: [-89.6, 36.5, -81.9, 39.1]   # coarse fast-path intersect
    years: [2012, 2024]          # temporal extent (min/max; refined from Layer 1)
  source:                        # the CollectionDescriptor (ingest)
    bucket: kyfromabove
    bucket_region: us-west-2
    access: public
    root_prefix: imagery/orthos/
    discovery: s3-prefix
  notes: "GSD to 3in; LeafOFF/ON; see COLLECTIONS.md worked example 1"
```

### The RODA candidate set (enumerated 2026‑06)

Found by cloning `awslabs/open-data-registry` and grepping for datasets that are
both COG and aerial/ortho imagery. The COG **aerial‑imagery** collections (the
science/derived COG datasets — canopy height, population, NASA — are excluded):

| id | title | bucket | bucket region | access | covers |
|----|-------|--------|---------------|--------|--------|
| `naip` | NAIP | `naip-analytic` | us-west-2 | requester-pays | CONUS (all states) |
| `kyfromabove` | KyFromAbove | `kyfromabove` | us-west-2 | public | Kentucky |
| `nj-imagery` | New Jersey | `njogis-imagery` | us-west-2 | public | New Jersey |
| `vt-opendata` | Vermont | `vtopendata-prd` | us-east-2 | public | Vermont |
| `in-imagery` | Indiana | `gisimageryingov` | us-east-2 | public | Indiana |
| `colorado-imagery` | Colorado | `colorado-public-imagery` | us-west-2 | public | Colorado |
| `nz-imagery` | New Zealand | `nz-imagery` | ap-southeast-2 | public | New Zealand |

**Current region scope: us‑west‑2 only.** The buckets span three regions; to keep
inter‑region egress out of scope for now, the registry marks the **three
us‑west‑2 COG collections `active`** (NAIP, KyFromAbove, NJ) and **parks the rest**
(Vermont + Indiana in us‑east‑2, New Zealand in ap‑southeast‑2) with their layouts
preserved, ready to flip on later.

Layout readiness (independent of the region scope): **five are pinned** (NAIP,
KyFromAbove, NJ, VT, Indiana), **one is excluded** (Colorado — not a COG), and
**one still needs a probe** (NZ):

- **Indiana** (`gisimageryingov`) — the distributable COGs are under
  `imageryoptimized/statewide/<year>/<product>/<res>/`
  (e.g. `.../2025/SPW/03in/in2025_28222356_3in.tif`), **not** the ArcGIS
  cache/raw prefixes (`imagerycache/`, `archive/`, `dem*`). Pinned, but parked
  (us‑east‑2).
- **Colorado — EXCLUDED, not a COG.** Verified by reading the TIFF header of
  `DRAPP/DRAPP2020/.../GeoTIFF/S2E178c.tif`: first IFD at **EOF** (byte
  ~451.6M of 452M), **no internal overviews** (external `.tif.ovr` sidecars),
  uncompressed — a classic GDAL tiled GeoTIFF, not a COG. Its `OpenData/` is
  empty and `NAIP/` is redundant with canonical `naip-analytic`, so the bucket
  has no COG‑conforming product. The RODA record said "GeoTIFFs," not "COGs" —
  accurate. (DRAPP is also Denver‑metro, not statewide.)
- **New Zealand** is laid out **by regional council** (`auckland/`, `canterbury/`,
  …) — so its `region` is *key‑parsed*, like NAIP's states, not a constant.

That NZ point is one general lesson: **region cardinality varies** — NAIP (≈50,
key‑parsed), the single‑state collections (1, constant), NZ (16, key‑parsed) — and
the `collection/region/year` model absorbs all three with no change; only the
`key_parser`'s `region` rule differs.

### COG conformance is verified, not assumed

Colorado is the cautionary case: a folder named `GeoTIFF/` (or `cog/`, or files
named `*_cog.tif`) is a **claim**, not proof. The COG‑only scope rule therefore
needs a real **conformance gate** at registration/ingest, not a filename check.
Running that gate over the three active collections: **all three pass** — NAIP
(canonical RGBIR COG), KyFromAbove (`_cog.tif`, JPEG, IFD@byte‑192 + internal
overviews), and NJ (`cog/`, Deflate, IFD@byte‑192 + internal overviews). Only
Colorado/DRAPP failed — so the gate isn't theoretical, it already caught one.
A COG is, minimally: internally **tiled**, with the **IFD/tile‑index near the
front** of the file, and **internal overviews** (reduced‑resolution IFDs) — so a
client can read metadata + any tile in a couple of ranged GETs without seeking to
EOF. The cheap check is exactly what flagged DRAPP: read the TIFF header, confirm
`TileWidth(322)` present, first‑IFD offset small, and `SubIFDs(330)`/chained
overview IFDs present. `rio cogeo validate` is the canonical version. Non‑conforming
datasets are **excluded** (status `excluded-not-cog`); converting them
(`rio cogeo create` / `gdal_translate -of COG`) would make us a COG *producer* —
deliberately out of scope for now.

Two operational notes:

- **Cross‑region reads.** Buckets live in three regions (us‑west‑2, us‑east‑2,
  ap‑southeast‑2); the app reads them cross‑region. Functionally fine, but
  inter‑region egress has a cost — the registry stores `bucket_region` so the app
  can warn/route and so `GetBucketLocation` isn't needed at read time.
- **Event‑driven refresh exists.** Colorado publishes an SNS
  `colorado-public-imagery-object_created` topic. For collections with such a
  feed, incremental ingest can subscribe instead of re‑listing — a future
  `DiscoveryAdapter` variant. Listing remains the universal baseline.

The seed file lives at **`collections/registry.yaml`** (curated). It compiles two
ways: to `collections.geojson` for the viewer's map lookup, and to
`CollectionDescriptor`s for the ingest. Adding a collection = adding one YAML
entry, never editing pipeline code.

## Region & latency

**The deployment is single-region: `us-west-2`.** The GeoParquet lake, the read +
ingest compute, and the primary, highest-volume collection — NAIP
(`naip-analytic`) — all live there, along with Kentucky and New Jersey, so the
bulk of activity stays in-region. Making the AWS region a user/config choice is a
deliberate *later* feature, not built now.

Two active collections do source cross-region: **Indiana** (`gisimageryingov`) and
**Vermont** (`vtopendata-prd`) are in **us-east-2**. Their imagery is read
client-side by the browser, so the cross-region cost lands on the viewer's range
requests rather than on the us-west-2 compute; the metadata they are indexed into
still lives in the us-west-2 lake.

The latency reasoning, kept here so it isn't re-derived later:

- Cross-region cost is a **per-request RTT penalty** (~50 ms Oregon↔Ohio,
  ~150 ms ↔ Sydney), and COG access is request-count-bound, so it *compounds*
  (~5 ranged GETs/tile → +250 ms/tile to us-east-2). Batch ingest hides this with
  parallelism; interactive viewing does not.
- The general mitigation is to **co-locate compute with the source bucket** and
  let only *derived* data (lake rows, indexes) cross regions — one bulk transfer
  instead of a storm of cross-region range requests.

## Partition migration (`state/naip_year` → `collection/region/year`)

Mechanical rename across four files:

1. `build_manifest_index.py:108` — `partition_by (state, naip_year)` →
   `(collection, region, year)`; the SQL that splits the key (`:93‑104`) moves
   into `key_parser`.
2. `ingest_duckdb.py` — `partition_by (state, naip_year, product)` →
   `(collection, region, year)` with `product`/`resolution`/`quad` demoted into
   `properties`; the Hilbert `state_bounds` group (`:343‑358`) groups by
   `region`; `reconcile_completeness` (`:160`) keys on `(collection, region, year)`.
3. `app.py` — lake reads filter on `collection`/`region`/`year`; the
   `/ingest/options` and `/availability` path‑listing helpers walk
   `collection=/region=/year=` instead of `state=/naip_year=`.
4. viewer ingest panel — add a **collection** selector that drives the existing
   region/year pickers.

NAIP's existing tree (`state=wa/naip_year=2023/…`) is re‑laid as
`collection=naip/region=wa/year=2023/…`. This is a one‑time re‑partition of the
lake, or a backfill that writes the new layout alongside and flips the read root.

---

## Read API + viewer impact

- The lake glob gains a `collection=` level; `/search` and `/availability` add an
  optional `collection` (defaulting to `naip` for back‑compat during migration).
- The viewer's ingest panel grows a **collection** dropdown above State/Year;
  selecting a collection repopulates the region/year options from that
  collection's partitions.
- The imagery STAC catalog (`naip-stac-catalog/manifest-index`) is, by its name,
  NAIP's. A multi‑collection world wants either a catalog‑per‑collection or a
  shared `imagery-catalog` partitioned `collection/region/year` — decide when the
  second collection actually lands.

---

## Open decisions

1. **Partition order.** NAIP imagery is `state/naip_year` = `region/year`.
   Prepending `collection=` gives `collection/region/year` — the cheapest
   migration, keeping region-before-year. The alternative,
   `collection/year/region`, would re-lay the existing NAIP tree. Recommend
   **`collection/region/year`** (minimal churn; imagery is browsed
   region-first) — order is a physical prune choice, not a schema contract.
   Revisit if it causes confusion.
2. **Catalog scope.** One shared `imagery-catalog` vs catalog‑per‑collection.
3. **`properties` typing.** Struct columns (typed, get stats) vs JSON string; promote frequently‑filtered
   fields (e.g. `resolution`) to real columns.
4. **Year as a range** (Vermont mosaics: `2016-2019`). The `year` partition is an
   `int`. Policy when a product's vintage is a span: partition by a single
   representative year (recommend the end/most‑recent), keep `year_range` in
   `properties`. Avoided entirely by preferring tiled products, which carry clean
   single years.
5. **Multi‑product buckets.** One bucket can host several products (Vermont:
   mosaics, `VTORTHO` tiles, `HISTORIC`). Each is its own descriptor scoped by
   `root_prefix`; there is no bucket‑level "auto‑ingest." Decide per product
   whether to register it at all.

---

## Migration plan (phased)

1. **Descriptor + adapter seam** — ✅ **DONE.** Added `api/descriptors.py`
   (`CollectionDescriptor`, `DiscoveryAdapter`, `ManifestIndexAdapter`, the `NAIP`
   descriptor, `get_descriptor`); `ingest_duckdb.py` gained `--collection` (default
   `naip`) and routes discovery + requester‑pays through the descriptor;
   `ingest_manifest.py`'s `fetch_cog_metadata`/`process_manifest_cog_headers` take
   `request_payer` instead of hardcoding `"requester"`. Pure refactor, output
   unchanged: verified the adapter's discovery is byte‑identical to the old direct
   call, and a live `vi/2022` ingest reproduced the exact tree
   (`state=/naip_year=/product=`) + 18‑column schema, 16/16 tiles.
2. **`S3PrefixListing` adapter** — ✅ **DONE.** `descriptors.py` gained `KeyFields`
   (the key_parser contract: key → region/year/properties), the `S3PrefixListing`
   adapter (per-collection `enumerate_prefixes` narrowing hook + `cog_filter` +
   `key_parser`, emitting the generic region/year/properties row shape), and the
   concrete **KyFromAbove** descriptor (`ky_key_parser`/`ky_cog_filter`/
   `ky_enumerate_prefixes`). It is a Phase-2 PREVIEW (in `_PREVIEW`, NOT
   `_REGISTRY`) — the live NAIP pipeline is untouched, because feeding these
   generic rows to ingest needs the Phase-3 rename + a generalized COG-header
   reader. Tests (`api/test_descriptors.py`, 6/6): pure parser/filter, an offline
   FakeS3 crawl (year filter, all-years + latest-only, constant-region guard), and
   a live smoke against the real public bucket (found real ky/2022 COGs).
3. **Partition rename** — ✅ **DONE (NAIP).** Lake is now
   `collection=/region=/year=` + a `properties` JSON column. Write side
   (`ingest_duckdb.py`: `payloads_to_arrow`/`export`/`reconcile`, Hilbert by
   region) and read side (`app.py`: `_lake_read_path`, `_build_lake_inner_sql`,
   `make_stac_feature`, `/availability`, `lake_years_for_states`, glob scoped to
   `collection=*`) moved over. The external API contract is unchanged
   (`/availability` still `{states:{region:[years]}}`; `/search` still takes
   `naip:state`/`naip:year`; features still carry them) so the Phase-5 viewer work
   stays deferred. `migrate_lake_layout.py` repartitions the existing lake
   (DuckDB-only, no COG re-reads). Manifest index + env vars + `lake/` prefix
   unchanged. Validated locally (vi/2022 ingest, app smoke, migration round-trip,
   6/6 descriptor tests) and migrated/redeployed in prod.
4. **Second collection (KyFromAbove)** — ✅ **capability done.** Generic
   COG-header path: `_extract_cog_geo` (collection-neutral) + `fetch_cog_geo_generic`
   / `process_cog_headers_generic` (region/year/properties from the discovery row,
   no NAIP filename parse). `acquire_payloads` branches generic vs NAIP;
   `payloads_to_arrow` + `reconcile` handle both shapes; KyFromAbove is in the live
   `_REGISTRY`. Verified locally: 18 ky/2022 3-in tiles →
   `collection=kyfromabove/region=ky/year=2022`, searchable via
   `collection=kyfromabove`, footprints in KY; NAIP output unchanged.
   **Pushing ky into the PROD lake is bundled with Phase 5** — `/availability`
   currently unions all collections, so a live ky ingest would add a "ky" entry to
   the viewer's State dropdown that returns nothing until the collection selector +
   collection-scoped `/availability` land. Two known wrinkles for later: `gsd` is
   in the COG's CRS units (NAIP metres vs KyFromAbove feet — footprints/bbox are
   always 4326, only `gsd` needs unit-normalising), and serving KyFromAbove
   imagery in the viewer is public (no requester-pays signing, unlike NAIP).
5. **Viewer collection selector** — ✅ **DONE (live).** `/availability` is now
   collection-scoped (`?collection=`, default naip) so collections never cross-
   pollute each other's Region/Year dropdowns; `/collections` lists the
   collections actually present in the lake. The viewer gained a **Collection**
   dropdown (populated from `/collections`, labelled via `collections.geojson`)
   that drives scoped availability + `/search`; "State" relabelled "Region";
   clicking an active row in "Collections here" sets the active collection. A
   KyFromAbove ky/2022 slice (98 tiles) was ingested into the prod lake and the
   app + viewer redeployed. Verified live: NAIP unaffected; KyFromAbove searchable
   and visible under its own collection, no ky leakage into the NAIP dropdown.
