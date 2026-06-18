# Collection onboarding — point at a COG bucket, get a catalog entry

Design note for the "side app" that makes adding a collection trivial: **point it
at an S3 bucket/prefix of COGs; if they're really COGs, it probes the layout and
emits a ready catalog entry** — no hand-written Python, no hand-synced YAML.

Status: **design only.** This documents the tool and the one architectural change
it requires (a *data-driven* descriptor), so onboarding produces config the engine
can run as-is.

---

## Goal

Today, adding a collection means hand-writing a descriptor in `descriptors.py`
(parser + crawl + filter functions) *and* a `registry.yaml` entry, kept in sync by
hand. We want instead:

```
onboard s3://some-bucket/some/prefix
  → "1,240 COGs · region=ky · years 2018–2024 · 6IN/3IN · public"
  → here is your registry.yaml entry (paste it / accept it)
```

The catalog is then the **output** of a tool, not a thing humans author. A tool can
generate *config*, never bespoke code — which is why the descriptor must go
data-driven (below). That, in turn, is the real reason to make the registry the
single source of truth.

---

## What it reuses (already built)

- **COG validator** — the dependency-free TIFF-header probe that caught Colorado
  DRAPP (tiled? IFD near the front? internal overviews?). Reused verbatim as the
  accept/reject gate. (`rio cogeo validate` is the heavyweight equivalent; our
  probe needs only `urllib`+`struct`, good for a light CLI.)
- **`S3PrefixListing`** (`descriptors.py`) — the prefix crawler + filter + parse.
- **registry → geojson compile** (`collections/build_collections_geojson.py`).
- **The descriptor model** (`CollectionDescriptor`, adapters).

So the tool is mostly *orchestration* of existing pieces.

---

## The flow

```
  point at  s3://bucket/prefix  [--access auto|public|requester-pays]
      │
  1. detect access     try unsigned LIST → else signed → flag requester-pays
  2. sample keys       keep .tif/.tiff candidates under the prefix
  3. COG-VALIDATE      run the header probe on a sample
                         FAIL → reject with the reason (the DRAPP report)
  4. footprint+region  read sample headers → CRS+corners → 4326 bbox;
                         union → extent; centroid-in-states-polygon → region(s)
  5. year              regex (19|20)\d\d in path/filename → PROPOSE the token;
                         human confirms which when several match
  6. preview           "N COGs · region(s) · year range · sample properties"
  7. EMIT              a registry.yaml entry: extent from geometry +
                         a DATA-DRIVEN parse config (below)
  8. dry-run           full-crawl count + a re-validate of a wider sample
```

---

## The two unlocks (why layout inference is smaller than it looks)

The scary part is "where's the year? where's the region?" Two facts shrink it:

1. **Region comes from geometry, not the key.** A COG header gives CRS + corners →
   reproject to 4326 → point-in-polygon against a static US-states (and country)
   layer. The footprint *tells you* it's Kentucky. This removes the single biggest
   source of bespoke per-bucket code — every collection's region "parser"
   collapses into one spatial classification. (NAIP's `state`, KY's constant `ky`,
   NZ's councils — all just fall out of "where is this pixel.") Resolved during the
   COG-header read (we have the footprint there), not during listing.
2. **Year is a near-universal regex.** `(19|20)\d\d` finds it almost everywhere;
   the only judgment is *which* token when several match (vintage vs an
   acquisition `YYYYMMDD` vs digits in a tile id). The tool proposes + previews;
   the human confirms with one click.

What's left for a human is small: confirm the year token, name the collection,
maybe pick a sub-prefix. Access, extent, COG-validity, and the tile filter are
derived.

---

## Data-driven descriptor (the pivot)

For step 7 to emit something the engine runs *without new Python*, the
per-collection parsing must be **declarative config**, interpreted by ONE generic
adapter — replacing today's bespoke `ky_key_parser` / `ky_enumerate_prefixes` /
`ky_cog_filter`:

```yaml
source:
  bucket: kyfromabove
  access: public                  # public | requester-pays
  prefix: imagery/orthos/         # root to crawl
  cog_filter:
    suffix: "_cog.tif"            # or ".tif"
    exclude: [Overviews, Metadata, TileGrid, County-Mosaics, ".ovr", ".tfw"]
  region: spatial                 # spatial | const:<v> | key:"<regex (?P<region>…)>"
  year:   { regex: "_(\\d{4})_" } # first capture = year   (or path:<segment-index>)
  properties:                     # optional extra captures, key -> regex
    resolution: { regex: "_(\\d(?:IN|FT|cm))_" }
```

A single `GenericPrefixAdapter` reads this: crawl `prefix`, apply `cog_filter`
(suffix + exclude tokens), extract `year` via regex, assign `region` per strategy
(`spatial` defers to the header-read stage), capture `properties`. No per-collection
functions. The onboarding tool writes this block; the ingest engine and the viewer
both read it.

---

## Why this makes the registry the single source of truth

Earlier we asked "why unify the YAML and the Python descriptors?" — and at three
hand-authored collections the answer was "not worth it." **The onboarding tool
changes that answer.** A tool can emit YAML config; it cannot emit reviewed Python.
So:

- Per-collection parsing becomes **data** in the registry (above), not code.
- `descriptors.py` keeps exactly **two** adapters: `ManifestIndexAdapter` (NAIP's
  special, faster, requester-pays catalog) and the new **`GenericPrefixAdapter`**
  (interprets the data-driven config). No third, fourth, … per-collection module.
- The registry is then canonical for *everything declarative*; the viewer's
  `collections.geojson` and the ingest both derive from it. No hand-syncing,
  because nothing is authored twice.

NAIP stays the deliberate special case (a published manifest index beats crawling
millions of keys, and it's requester-pays); onboarding targets the public-prefix
case, which is the rest of the RODA COG world.

---

## What's automated vs confirmed vs refused

| step | automated | human confirms | refuses / flags |
|------|-----------|----------------|-----------------|
| access mode | ✓ (probe) | — | — |
| COG validity | ✓ (header probe) | — | **reject** non-COGs (DRAPP) |
| extent bbox | ✓ (from footprints) | — | — |
| region | ✓ (spatial) | optional override | COGs with no/odd CRS |
| year | proposes | ✓ which token | **year-range** vintages (VT mosaics) |
| collection id / title | from bucket / RODA | ✓ | — |
| product selection | — | ✓ pick prefix | **multi-product** buckets (VT, NJ, CO) |

The 4 real buckets defined these edge cases: year-ranges, multi-product buckets,
mixed formats, huge buckets (needs a sampling cap). The tool **detects and asks**,
never silently guesses.

---

## COG conformance gate (the accept/reject definition)

A key is in scope iff it ends `.tif`/`.tiff`, passes `cog_filter`, and the file is
a real COG: **internally tiled** (`TileWidth` tag present), **IFD near the front**
of the file (so metadata + any tile is a couple of ranged GETs, not an EOF seek),
and **internal overviews** (chained reduced-resolution IFDs / `SubIFDs`). The probe
reports the failing condition on reject — e.g. DRAPP: "IFD at EOF, external `.ovr`,
no internal overviews."

---

## Phasing

1. **`onboard` CLI — probe & propose** (steps 1–6 + print the proposed entry). Pure
   read-only; reuses the validator + crawler; no engine changes. Highest value,
   immediately testable against KyFromAbove / NJ / Indiana to see how well year +
   region auto-detect hold up.
2. **`GenericPrefixAdapter`** — make the data-driven config actually run; port
   KyFromAbove from bespoke functions to a config block as the proof.
3. **Registry as single source of truth** — `descriptors.py` loads declarative
   fields from `registry.yaml`; keep only the two adapters.
4. **Web UI** — a thin front-end over the CLI: paste a bucket URL, see the preview,
   click "add to catalog" (writes the registry entry + recompiles the geojson).

---

## Open questions

- **Boundary layer for spatial region** — ship a small US-states (+ countries)
  GeoJSON; pick by centroid, or majority-overlap for border-straddling tiles.
  Cardinality > state (counties) is a later option.
- **Sampling strategy** for huge buckets — how many keys / which (first N,
  random, per-prefix) to validate + infer from without listing millions.
- **Writing back** — does "add to catalog" open a PR against `registry.yaml`, or
  write directly? PR keeps the catalog reviewed.
- **Year-range & multi-product** — confirm the UX for the cases the tool refuses
  to auto-resolve (pick start/end year; pick which product prefix).
