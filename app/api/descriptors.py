"""Collection descriptors + discovery adapters — the Stage-1 ingest seam.

A `CollectionDescriptor` declares everything ingest needs to know about ONE
collection: its source bucket, access mode, and how its COGs are discovered. NAIP
is descriptor #1; the abstraction exists so a second collection (e.g. an
S3-prefix-listed public bucket) is added by writing a descriptor, not by editing
the pipeline.

PHASE 1 (this module): NAIP only, routed through its existing manifest-index
discovery. Pure seam — no output change. The partition layout, columns, and lake
are untouched; ingest_duckdb still writes state/naip_year/product. Later phases add
an `S3PrefixListing` adapter, a second descriptor, and the collection/region/year
partition rename (see docs/design/COLLECTIONS.md).

Design note: this module must NOT be named `collections.py` — that shadows the
stdlib `collections` used by ingest_duckdb (`from collections import Counter`).

To avoid an import cycle, the adapters import `ingest_manifest` lazily (inside the
method); `ingest_manifest` never imports this module — the functions that need the
request-payer mode take it as a parameter (default preserves current behavior).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol


# --------------------------------------------------------------------------- #
# Discovery adapters: "given regions/years, enumerate the source COGs."        #
# --------------------------------------------------------------------------- #
class DiscoveryAdapter(Protocol):
    def enumerate(
        self,
        *,
        regions: set[str],
        years: set[int] | None,
        latest_year_only: bool,
        limit_per_partition: int,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
        """Return (asset_href -> manifest_row, latest_year_by_region)."""
        ...


@dataclass(frozen=True)
class ManifestIndexAdapter:
    """Discovery by reading the pre-published, partitioned manifest index.

    A thin, transparent wrapper over the existing
    `ingest_manifest.build_manifest_inventory_from_index`, so the output is
    byte-for-byte what the direct call produced (verified by an equivalence test).

    NOT CURRENTLY WIRED TO ANY COLLECTION. NAIP used to discover through this and
    moved to `S3PrefixListing` over `naip-analytic`, because the index is a
    projection of the lake: it could only ever offer what was already ingested
    (4 years for nj where the bucket holds 7), and enumerating a year it lacked
    returned 0 assets rather than failing. See the NAIP descriptor below.

    Kept because it is faster than a bucket crawl when the wanted partitions are
    known to be in the index, and it is exercised by tests. If nothing adopts it,
    it and `build_manifest_inventory_from_index` can go together.
    """

    index_root: str | None = None  # None -> ingest_manifest.MANIFEST_INDEX_PATH

    @property
    def regions(self) -> tuple[str, ...]:
        from config import STATE_BBOXES

        return tuple(sorted(STATE_BBOXES.keys()))

    def available_years(self, region: str) -> list[int]:
        """Available years for a state, from the index's year= partitions.

        Layout is collection=<c>/region=<r>/year=<y>/. This used to scan for
        `state=<r>/` and `naip_year=` -- the layout build_manifest_index.py
        writes and the published index abandoned -- so it silently returned []
        for every state and left the ingest panel's year dropdown empty. Same
        drift that broke the index reader in d7ac3a1, in a spot that had no
        test because an empty list is indistinguishable from "no data yet".
        """
        from pathlib import Path

        from aws_s3 import get_s3_direct_client
        from config import MANIFEST_INDEX
        from ingest_manifest import INDEX_COLLECTION

        years: set[int] = set()
        root = self.index_root or str(MANIFEST_INDEX)
        scope = f"collection={INDEX_COLLECTION}/region={region}/"

        def year_of(segment: str) -> None:
            if segment.startswith("year="):
                try:
                    years.add(int(segment.split("=", 1)[1]))
                except ValueError:
                    pass

        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://") :].partition("/")
            base = (prefix.rstrip("/") + "/") if prefix else ""
            s3 = get_s3_direct_client()
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(
                Bucket=bucket, Prefix=f"{base}{scope}", Delimiter="/", RequestPayer="requester"
            ):
                for cp in page.get("CommonPrefixes", []):
                    year_of(cp["Prefix"].rstrip("/").rsplit("/", 1)[-1])
        else:
            # Local index roots are a supported mode (docker-compose calls it
            # "fully-offline runs"), and were silently unhandled here.
            for child in sorted(Path(root).joinpath(scope).glob("year=*")):
                year_of(child.name)
        return sorted(years, reverse=True)

    def enumerate(self, *, regions, years, latest_year_only, limit_per_partition):
        import ingest_manifest as im

        root = self.index_root or im.MANIFEST_INDEX_PATH
        return im.build_manifest_inventory_from_index(
            regions,
            years=years,
            latest_year_only=latest_year_only,
            limit_per_partition=limit_per_partition,
            index_root=root,
        )


# --------------------------------------------------------------------------- #
# key_parser contract + S3-prefix-listing adapter (Phase 2)                    #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class KeyFields:
    """What a collection's key_parser extracts from one S3 key. The uniform shape
    every layout quirk collapses to; everything downstream sees only this."""

    region: str  # key-parsed (NAIP states, NZ councils) or constant (ky)
    year: int  # path level, regex from a folder, or filename
    properties: dict  # collection-scoped extras (resolution, tile id, ...)


# Well-known public buckets that have S3 Requester Pays enabled, so reads/lists
# must be signed and carry RequestPayer=requester. Used to coerce the access mode
# for ad-hoc/panel ingests targeting them, so a "public" selection doesn't 403.
REQUESTER_PAYS_BUCKETS = {"naip-analytic", "naip-visualization", "naip-geoparquet-index"}

# Buckets known to hold NO cloud-optimized imagery (metadata, FGDC sidecars, and
# tile-index shapefiles only), so an ingest would find nothing usable. Reject
# ad-hoc ingests targeting them early with a clear message.
NON_COG_BUCKETS = {"naip-source"}


def s3_client_for(access: str):
    """A signed client, or an UNSIGNED one for public buckets (== --no-sign-request).

    The signed branch goes through aws_s3.get_s3_direct_client() rather than a
    bare boto3.client("s3"): that resolves credentials via get_aws_credentials(),
    which falls back to the `aws login` session cache. Plain botocore raises on
    those profiles, so in the container -- where ~/.aws is mounted read-only and
    every working profile is a login session -- a bare client fails with
    NoCredentialsError even when a valid token exists on disk.

    This only affects non-public access. KyFromAbove / NJ / Indiana are public
    and keep the unsigned client untouched.
    """
    if access == "public":
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config

        return boto3.client("s3", config=Config(signature_version=UNSIGNED))

    from aws_s3 import get_s3_direct_client

    return get_s3_direct_client()


def _common_prefixes(s3, bucket: str, prefix: str, request_payer: str | None = None) -> list[str]:
    """One level of "folders" under prefix (ListObjectsV2 with Delimiter='/')."""
    out, token = [], None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix, "Delimiter": "/"}
        if request_payer:
            kw["RequestPayer"] = request_payer
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        out.extend(cp["Prefix"] for cp in resp.get("CommonPrefixes", []))
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return out


def _iter_keys(s3, bucket: str, prefix: str, request_payer: str | None = None):
    """Lazily yield every object key under prefix (recursive, page by page). The
    caller applies cog_filter and counts COGs, so the per-partition cap counts
    INGESTABLE tiles -- not .tfw sidecars / folder markers we never use -- and
    listing stops as soon as enough COGs are found."""
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if request_payer:
            kw["RequestPayer"] = request_payer
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        for obj in resp.get("Contents", []):
            yield obj["Key"]
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break


@dataclass(frozen=True)
class S3PrefixListing:
    """Discovery by listing an S3 prefix (the universal path for public COG
    collections). Self-contained: holds the bucket, access mode, the per-collection
    `enumerate_prefixes` narrowing hook, `cog_filter`, and `key_parser`.

    Emits the GENERIC row shape (region / year / properties + source_*), which is
    the Phase-3 partition target. It is intentionally NOT yet fed to the current
    NAIP-shaped COG-header reader (that wants state/naip_year + DOQQ filenames);
    wiring a second collection end-to-end is Phase 3/4.
    """

    bucket: str
    access: str
    cog_filter: Callable[[str], bool]
    key_parser: Callable[[str], KeyFields | None]
    # (s3, bucket, region, year|None) -> the prefixes to ListObjectsV2 for it.
    enumerate_prefixes: Callable[[Any, str, str, int | None], list[str]]
    # Constant region(s) this collection covers; empty => region comes from the key.
    regions: tuple[str, ...] = ()

    def _target_regions(self, requested):
        if self.regions:
            return set(self.regions) & set(requested) if requested else set(self.regions)
        return set(requested)

    def enumerate(self, *, regions, years, latest_year_only, limit_per_partition, s3=None):
        if s3 is None:  # injectable for offline tests
            s3 = s3_client_for(self.access)
        # Requester-pays buckets (e.g. naip-analytic) reject ListObjectsV2 without
        # the payer header; thread it through the key crawl. s3_client_for already
        # returns a signed client for non-public access.
        request_payer = "requester" if self.access == "requester-pays" else None
        target_regions = self._target_regions(regions)
        target_years = set(years) if years else {None}  # None -> discover all years
        cap = limit_per_partition or 0

        rows: dict[str, dict[str, Any]] = {}
        for region in sorted(target_regions, key=str):
            for year in target_years:
                kept = 0  # COGs kept for this region/year partition
                for prefix in self.enumerate_prefixes(s3, self.bucket, region, year):
                    for key in _iter_keys(s3, self.bucket, prefix, request_payer=request_payer):
                        if not self.cog_filter(key):
                            continue
                        kf = self.key_parser(key)
                        if kf is None:
                            continue
                        href = f"s3://{self.bucket}/{key}"
                        rows[href] = {
                            "source_bucket": self.bucket,
                            "source_key": key,
                            "asset_href": href,
                            "filename": key.rsplit("/", 1)[-1],
                            "region": kf.region,
                            "year": kf.year,
                            "properties": kf.properties,
                        }
                        kept += 1
                        if cap and kept >= cap:
                            break
                    if cap and kept >= cap:
                        break

        latest: dict[str, int] = {}
        for r in rows.values():
            latest[r["region"]] = max(latest.get(r["region"], 0), r["year"])
        if latest_year_only and latest:
            rows = {h: r for h, r in rows.items() if r["year"] == latest[r["region"]]}
        return rows, latest

    def available_years(self, region: str) -> list[int]:
        """Years offerable for a region, from the product-folder names (cheap: just
        lists prefixes, no key crawl). Powers the ingest panel's Year dropdown."""
        s3 = s3_client_for(self.access)
        years: set[int] = set()
        for pre in self.enumerate_prefixes(s3, self.bucket, region, None):
            m = re.search(r"(?:19|20)\d\d", pre)
            if m:
                y = int(m.group(0))
                years.add(y)
        return sorted(years, reverse=True)


# --------------------------------------------------------------------------- #
# The descriptor                                                               #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CollectionDescriptor:
    id: str
    bucket: str
    access: str  # "requester-pays" | "public" | "private"
    discovery: DiscoveryAdapter | None
    key_filter: Callable[[str], bool]
    # Shape of the rows `discovery.enumerate()` yields, DECLARED rather than
    # inferred from the adapter class. acquire_payloads used to switch on
    # `isinstance(discovery, S3PrefixListing)`, which conflated adapter with row
    # shape -- fine while NAIP was the only non-S3PrefixListing collection, wrong
    # the moment NAIP started using that adapter too. "naip" rows additionally
    # carry state/naip_year/resolution_dir/product_family/spatial_prefix, which
    # row_to_insertable() and process_manifest_cog_headers() require.
    row_shape: str = "generic"  # "generic" | "naip"

    @property
    def request_payer(self) -> str | None:
        """The value to pass to S3 `RequestPayer` (None when not requester-pays)."""
        return "requester" if self.access == "requester-pays" else None


# --------------------------------------------------------------------------- #
# Registry. NAIP is intentionally NOT ingestable here: its lake is published   #
# read-only (the viewer reads it via /search + /naip-coverage). Only the        #
# generic S3-prefix COG collections are ingestable. Keep in sync with           #
# collections/registry.yaml.                                                     #
# --------------------------------------------------------------------------- #
# KYFROMABOVE / NJ are defined below (they need S3PrefixListing's helpers); the
# registry is assembled after those definitions.
_REGISTRY: dict[str, CollectionDescriptor] = {}


def get_descriptor(collection_id: str = "naip") -> CollectionDescriptor:
    if collection_id in _REGISTRY:
        return _REGISTRY[collection_id]
    for desc in list(_REGISTRY.values()):
        if desc.bucket == collection_id:
            return desc
    known = ", ".join(sorted(_REGISTRY))
    raise SystemExit(f"unknown collection '{collection_id}'; known: {known}")


def is_source_asset(bucket: str, key: str) -> bool:
    """Whether a bucket/key matches an active collection's COG key pattern."""
    return any(descriptor.bucket == bucket and descriptor.key_filter(key) for descriptor in _REGISTRY.values())


# --------------------------------------------------------------------------- #
# KyFromAbove via S3PrefixListing (LIVE as of Phase 4 -- in _REGISTRY below).     #
# Ingested through the generic COG-header path (fetch_cog_geo_generic); region is #
# the constant "ky", year/properties parsed from the key. See docs/design/COLLECTIONS.md      #
# "Worked example 1" for the layout:                                              #
#   imagery/orthos/<Phase>/KY_KYAPED_<year>_<res>/<tile>_<year>_<res>_cog.tif    #
# --------------------------------------------------------------------------- #
# Bare tokens (not "/Overviews/"): the real noise folders are siblings like
# KY_KYAPED_2014_6IN_Overviews/ and Metadata/, so match the token anywhere.
_KY_EXCLUDE = ("Overviews", "Metadata", "TileGrid", "County-Mosaics", "FlightInformationData")
# Filename shapes vary across years/phases; anchor on the trailing
# _<year>(_Season<N>)?_<res>_cog.tif and treat everything before as the tile id
# (non-greedy), so multi-segment prefixes are absorbed:
#   N013E300_2022_6IN_cog.tif                  -> tile N013E300
#   N011E284_2024_Season1_3IN_cog.tif          -> tile N011E284, season 1
#   Ky_LOJIC_N059E244_2021_3IN_cog.tif         -> tile Ky_LOJIC_N059E244 (Louisville/LOJIC)
# Season may also live only in the product-folder name (older Phase-3 products).
_KY_FILENAME = re.compile(r"^(?P<tile>.+?)_(?P<year>\d{4})(?:_Season(?P<season>\d))?_(?P<res>[0-9A-Za-z]+)_cog\.tif$")


def ky_cog_filter(key: str) -> bool:
    return key.endswith("_cog.tif") and not any(seg in key for seg in _KY_EXCLUDE)


def ky_key_parser(key: str) -> KeyFields | None:
    m = _KY_FILENAME.match(key.rsplit("/", 1)[-1])
    if not m:
        return None
    parts = key.split("/")
    season = m["season"]  # filename season (newer products)
    if season is None:  # else fall back to the product-folder name
        fm = re.search(r"Season(\d)", parts[3] if len(parts) > 3 else "")
        season = fm.group(1) if fm else None
    return KeyFields(
        region="ky",  # the collection IS the state -> constant
        year=int(m["year"]),
        properties={
            "phase": parts[2] if len(parts) > 2 else None,
            "kyaped:resolution": m["res"],
            "season": int(season) if season else None,
            "kyaped:tile": m["tile"],
        },
    )


def ky_enumerate_prefixes(s3, bucket: str, region: str, year: int | None) -> list[str]:
    """List the product folders under each Phase, keep those matching the year."""
    out = []
    for phase in ("Phase1", "Phase2", "Phase3"):
        for pre in _common_prefixes(s3, bucket, f"imagery/orthos/{phase}/"):
            name = pre.rstrip("/").rsplit("/", 1)[-1]  # KY_KYAPED_2022_6IN
            m = re.match(r"KY_KYAPED_(\d{4})", name)
            if m and (year is None or int(m.group(1)) == int(year)):
                out.append(pre)
    return out


KYFROMABOVE = CollectionDescriptor(
    id="kyfromabove",
    bucket="kyfromabove",
    access="public",
    discovery=S3PrefixListing(
        bucket="kyfromabove",
        access="public",
        cog_filter=ky_cog_filter,
        key_parser=ky_key_parser,
        enumerate_prefixes=ky_enumerate_prefixes,
        regions=("ky",),
    ),
    key_filter=ky_cog_filter,
)


# --------------------------------------------------------------------------- #
# New Jersey statewide orthoimagery (njogis-imagery, public). Layout:          #
#   <year>/cog/<tile>.tif   (siblings MG3/MG4/sid are MrSID/JP2 -> ignored)    #
# Simplest descriptor: year is the path level, region is constant, no filename  #
# parsing. Each modern vintage (2002,2007,2012,2015,2020) is full statewide.    #
# --------------------------------------------------------------------------- #
def nj_cog_filter(key: str) -> bool:
    return key.endswith(".tif") and "/cog/" in key


def nj_key_parser(key: str) -> KeyFields | None:
    parts = key.split("/")  # <year>/cog/<tile>.tif
    if len(parts) < 3 or not parts[0].isdigit():
        return None
    return KeyFields(
        region="nj",  # the collection IS the state -> constant
        year=int(parts[0]),
        properties={"njgin:tile": parts[-1].removesuffix(".tif")},
    )


def nj_enumerate_prefixes(s3, bucket: str, region: str, year: int | None) -> list[str]:
    """`<year>/cog/` for a given year; for year=None, the year dirs that actually
    have a cog/ subfolder (so SID-only years like 1970/1995 are excluded)."""
    if year is not None:
        return [f"{year}/cog/"]
    out = []
    for pre in _common_prefixes(s3, bucket, ""):  # top-level year dirs
        if not pre.rstrip("/").isdigit():
            continue
        if any(cp.rstrip("/").endswith("/cog") for cp in _common_prefixes(s3, bucket, pre)):
            out.append(f"{pre}cog/")
    return out


NJ = CollectionDescriptor(
    id="nj-imagery",
    bucket="njogis-imagery",
    access="public",
    discovery=S3PrefixListing(
        bucket="njogis-imagery",
        access="public",
        cog_filter=nj_cog_filter,
        key_parser=nj_key_parser,
        enumerate_prefixes=nj_enumerate_prefixes,
        regions=("nj",),
    ),
    key_filter=nj_cog_filter,
)


# --------------------------------------------------------------------------- #
# Indiana Statewide (gisimageryingov, public). Layout:
#   imageryoptimized/statewide/<year>/<SPE|SPW>/<res>in/in<year>_<tile>_<res>.tif
# --------------------------------------------------------------------------- #
def in_cog_filter(key: str) -> bool:
    return key.endswith(".tif") and "imageryoptimized/statewide/" in key


def in_key_parser(key: str) -> KeyFields | None:
    parts = key.split("/")
    if len(parts) < 6:
        return None
    try:
        year = int(parts[2])
    except ValueError:
        return None
    tile = parts[-1].removesuffix(".tif")
    # Indiana statewide imagery is a single region; the SP zone (SPE/SPW) is a
    # projection detail, not a region, so it rides along in `properties`.
    return KeyFields(
        region="in",
        year=year,
        properties={"in:tile": tile, "in:zone": parts[3], "in:resolution": parts[4]},
    )


def in_enumerate_prefixes(s3, bucket: str, region: str, year: int | None) -> list[str]:
    out = []
    base = "imageryoptimized/statewide/"
    if year is not None:
        year_dirs = [f"{base}{year}/"]
    else:
        year_dirs = []
        for pre in _common_prefixes(s3, bucket, base):
            name = pre.rstrip("/").rsplit("/", 1)[-1]
            if name.isdigit():
                year_dirs.append(pre)

    for ydir in year_dirs:
        for zone_dir in _common_prefixes(s3, bucket, ydir):
            for res_dir in _common_prefixes(s3, bucket, zone_dir):
                out.append(res_dir)
    return out


IN_IMAGERY = CollectionDescriptor(
    id="in-imagery",
    bucket="gisimageryingov",
    access="public",
    discovery=S3PrefixListing(
        bucket="gisimageryingov",
        access="public",
        cog_filter=in_cog_filter,
        key_parser=in_key_parser,
        enumerate_prefixes=in_enumerate_prefixes,
        regions=("in",),
    ),
    key_filter=in_cog_filter,
)


# --------------------------------------------------------------------------- #
# NAIP via S3PrefixListing. Layout:                                            #
#   <state>/<year>/<gsd>/rgbir_cog/<quad>/[<sub>/]<file>.tif                   #
#                                                                              #
# Discovery lists the SOURCE BUCKET, not the published index. The index is a   #
# projection of the lake, so an index-backed picker could only ever re-offer    #
# what was already ingested -- it reported 4 years for nj where the bucket has  #
# 7, and enumerating a missing year returned 0 assets. README.md:251 says the   #
# ingest path exists to go beyond the seeded subset; this is what lets it.      #
# --------------------------------------------------------------------------- #
def naip_cog_filter(key: str) -> bool:
    return key.endswith(".tif") and "/rgbir_cog/" in key


def naip_key_parser(key: str) -> KeyFields | None:
    """Split exactly as partition_from_key() does on the text path.

    Both take the first five segments and the last, so the extra directory level
    that hi/pr/vi carry -- hi/2021/60cm/rgbir_cog/19155/57/m_....tif, 491 keys in
    the collection -- is ignored identically by both. Diverging here would make
    the two ingest paths disagree on quad and filename for those rows.
    """
    parts = key.split("/")
    if len(parts) < 5:
        return None
    state, year, resolution_dir, product_family, spatial_prefix = parts[:5]
    if len(state) != 2 or not year.isdigit():
        return None
    return KeyFields(
        region=state,
        year=int(year),
        # These three are what the NAIP row projection reads back out; naming
        # them as the NAIP row does keeps the projection a rename, not a parse.
        properties={
            "resolution_dir": resolution_dir,
            "product_family": product_family,
            "spatial_prefix": spatial_prefix,
        },
    )


def naip_enumerate_prefixes(s3, bucket: str, region: str, year: int | None) -> list[str]:
    """`<state>/<year>/` when the year is known, else every year dir for the state.

    Narrowing on year matters: naip-analytic is requester-pays, so a whole-state
    crawl is billable LIST volume, and limit_per_partition caps rows KEPT, not
    objects listed.
    """
    if year is not None:
        return [f"{region}/{year}/"]
    return [
        pre
        for pre in _common_prefixes(s3, bucket, f"{region}/", request_payer="requester")
        if pre.rstrip("/").rsplit("/", 1)[-1].isdigit()
    ]


# Every two-letter prefix in the bucket: the 49 in STATE_BBOXES plus pr and vi,
# which hold data but were unreachable while the region list came from
# STATE_BBOXES (which also drives map centring, so it is not the same list).
NAIP_REGIONS: tuple[str, ...] = (
    "al", "ar", "az", "ca", "co", "ct", "de", "fl", "ga", "hi", "ia", "id",
    "il", "in", "ks", "ky", "la", "ma", "md", "me", "mi", "mn", "mo", "ms",
    "mt", "nc", "nd", "ne", "nh", "nj", "nm", "nv", "ny", "oh", "ok", "or",
    "pa", "pr", "ri", "sc", "sd", "tn", "tx", "ut", "va", "vi", "vt", "wa",
    "wi", "wv", "wy",
)  # fmt: skip

NAIP = CollectionDescriptor(
    id="naip",
    bucket="naip-analytic",
    access="requester-pays",
    discovery=S3PrefixListing(
        bucket="naip-analytic",
        access="requester-pays",
        cog_filter=naip_cog_filter,
        key_parser=naip_key_parser,
        enumerate_prefixes=naip_enumerate_prefixes,
        regions=NAIP_REGIONS,
    ),
    key_filter=naip_cog_filter,
    # NAIP keeps the richer row shape: both its ingest strategies need it, and
    # the EarthSearch join in particular goes through row_to_insertable().
    row_shape="naip",
)


def to_naip_rows(rows: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Project generic discovery rows into the NAIP row shape.

    S3PrefixListing emits region/year/properties; row_to_insertable() and
    process_manifest_cog_headers() want state/naip_year plus the three key-path
    fields. naip_key_parser already put those in `properties`, so this is a
    rename rather than a second parse of the key.

    `metadata_href` stays absent: the FGDC sidecar lives beside the COG but the
    lake ingest does not use it, and the index-backed path never carried it
    either.
    """
    out: dict[str, dict[str, Any]] = {}
    for href, row in rows.items():
        props = row.get("properties") or {}
        out[href] = {
            **row,
            "state": row["region"],
            "naip_year": int(row["year"]),
            "resolution_dir": props.get("resolution_dir"),
            "product_family": props.get("product_family"),
            "spatial_prefix": props.get("spatial_prefix"),
        }
    return out


# Assemble the live registry now that all descriptors are defined. The public
# S3-prefix collections (KyFromAbove, New Jersey, Indiana) are ingestable via
# the generic path. Keep in sync with collections/registry.yaml (active collections).
_REGISTRY.update({c.id: c for c in (NAIP, KYFROMABOVE, NJ, IN_IMAGERY)})


def register_adhoc_collection(
    collection_id: str,
    bucket: str,
    prefix: str,
    region: str,
    year: int,
    access: str,
) -> CollectionDescriptor:
    """Dynamically build and register a generic CollectionDescriptor for an ad-hoc S3 bucket."""
    bucket_name = bucket.replace("s3://", "").split("/")[0]
    # Reject buckets known to carry no cloud-optimized imagery (metadata/index only).
    if bucket_name in NON_COG_BUCKETS:
        raise ValueError(
            f"{bucket_name} has no cloud-optimized imagery (metadata/index only); "
            "use naip-analytic (RGBIR) or naip-visualization (RGB)"
        )
    # Force requester-pays for buckets known to require it, so a "public" panel
    # selection doesn't fail with AccessDenied on a requester-pays bucket.
    if bucket_name in REQUESTER_PAYS_BUCKETS:
        access = "requester-pays"

    fixed_prefix = prefix.strip()
    if fixed_prefix and not fixed_prefix.endswith("/"):
        fixed_prefix += "/"

    def enumerate_prefixes(s3, b, r, y):
        return [fixed_prefix]

    def key_parser(key: str) -> KeyFields | None:
        filename = key.rsplit("/", 1)[-1]
        tile = filename.removesuffix(".tif").removesuffix(".tiff")
        return KeyFields(
            region=region.lower(),
            year=int(year),
            properties={"tile": tile},
        )

    def cog_filter(key: str) -> bool:
        return key.lower().endswith((".tif", ".tiff")) and not any(
            seg in key for seg in ("Metadata", "TileGrid", "Overviews", "archive", "LogFiles")
        )

    desc = CollectionDescriptor(
        id=collection_id,
        bucket=bucket_name,
        access=access,
        discovery=S3PrefixListing(
            bucket=bucket_name,
            access=access,
            cog_filter=cog_filter,
            key_parser=key_parser,
            enumerate_prefixes=enumerate_prefixes,
            regions=(region.lower(),),
        ),
        key_filter=cog_filter,
    )

    _REGISTRY[collection_id] = desc
    return desc


def register_lake_collections():
    """Scan the GeoParquet lake for collection= partition directories at startup
    and dynamically register descriptors for any ad-hoc/custom collections.
    """
    from config import LAKE_ROOT
    from lake import get_lake_duckdb, lake_collections

    try:
        collections = lake_collections()
    except Exception as e:
        print(f"Skipping startup lake scan: {e}")
        return

    for cid in collections:
        if cid in _REGISTRY:
            continue

        try:
            read_glob = f"{LAKE_ROOT}/collection={cid}/**/*.parquet"
            sql = (
                "select source_bucket, region, year, source_key "
                f"from read_parquet('{read_glob}', hive_partitioning=true) limit 1"
            )
            res = get_lake_duckdb().cursor().execute(sql).fetchone()
            if res:
                bucket, region, year, source_key = res
                prefix = ""
                if "/" in source_key:
                    prefix = source_key.rsplit("/", 1)[0] + "/"

                access = "requester-pays" if bucket in REQUESTER_PAYS_BUCKETS else "public"
                register_adhoc_collection(
                    collection_id=cid,
                    bucket=bucket,
                    prefix=prefix,
                    region=region,
                    year=int(year),
                    access=access,
                )
                print(f"Dynamically registered custom collection descriptor: {cid} (bucket: {bucket})")
        except Exception as e:
            print(f"Failed to dynamically register custom collection '{cid}' from lake: {e}")
