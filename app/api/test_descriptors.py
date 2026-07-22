"""Phase-2 tests: the key_parser contract + S3PrefixListing adapter (KyFromAbove).

Runnable two ways:
    pytest api/test_descriptors.py
    .venv/bin/python api/test_descriptors.py     # prints PASS/FAIL, exits nonzero on fail

The pure + FakeS3 tests are offline & deterministic. The live test hits the real
PUBLIC kyfromabove bucket (unsigned, free) and is best-effort: it SKIPs if offline.
"""

import os
import sys

import pytest
from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # allow `import descriptors`
import descriptors as d  # noqa: E402


# --------------------------------------------------------------------------- #
# Pure: key_parser + cog_filter                                               #
# --------------------------------------------------------------------------- #
def test_ky_key_parser():
    k = "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tif"
    kf = d.ky_key_parser(k)
    assert kf is not None
    assert kf.region == "ky"  # constant: the collection IS the state
    assert kf.year == 2022
    assert kf.properties["kyaped:resolution"] == "6IN"
    assert kf.properties["phase"] == "Phase2"
    assert kf.properties["kyaped:tile"] == "N013E300"
    assert kf.properties["season"] is None

    # Phase-3 season in the FOLDER name (filename has no season token)
    s = "imagery/orthos/Phase3/KY_KYAPED_2023_Season2_3IN/A12_2023_3IN_cog.tif"
    kfs = d.ky_key_parser(s)
    assert kfs.year == 2023 and kfs.properties["season"] == 2
    assert kfs.properties["kyaped:resolution"] == "3IN"

    # Season in the FILENAME (real 2024 shape) -- the case that returned 0 rows
    f = "imagery/orthos/Phase3/KY_KYAPED_2024_Season1_3IN/N011E284_2024_Season1_3IN_cog.tif"
    kf24 = d.ky_key_parser(f)
    assert kf24 is not None, "2024 season-in-filename must parse"
    assert kf24.year == 2024 and kf24.properties["season"] == 1
    assert kf24.properties["kyaped:resolution"] == "3IN"
    assert kf24.properties["kyaped:tile"] == "N011E284"

    # Multi-segment tile prefix (real 2021 LOJIC shape) -- the case that 0-rowed
    lj = "imagery/orthos/Phase2/KY_KYAPED_2021_3IN/Ky_LOJIC_N059E244_2021_3IN_cog.tif"
    kfl = d.ky_key_parser(lj)
    assert kfl is not None and kfl.year == 2021 and kfl.properties["kyaped:resolution"] == "3IN"
    assert kfl.properties["kyaped:tile"] == "Ky_LOJIC_N059E244" and kfl.properties["season"] is None

    # a non-tile key parses to None
    assert d.ky_key_parser("imagery/orthos/Phase2/KY_KYAPED_2022_6IN/Metadata/info.xml") is None


def test_ky_cog_filter():
    keep = "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tif"
    assert d.ky_cog_filter(keep) is True
    drop = [
        "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tfw",  # sidecar
        "imagery/orthos/Phase1/KY_KYAPED_2014_6IN_Overviews/Z_2014_6IN_cog.tif",  # overviews
        "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/Metadata/info.xml",
        "imagery/orthos/Phase3/County-Mosaics/big_2023_3IN_cog.tif",
    ]
    for k in drop:
        assert d.ky_cog_filter(k) is False, k


def test_nj_key_parser_and_filter():
    kf = d.nj_key_parser("2020/cog/A15B12.tif")
    assert kf and kf.region == "nj" and kf.year == 2020
    assert kf.properties["njgin:tile"] == "A15B12"
    # historical year, different filename shape -> still parses (year is the path)
    assert d.nj_key_parser("1977/cog/1977_035_1908spc.tif").year == 1977
    # cog_filter keeps cog/*.tif, drops other-format siblings
    assert d.nj_cog_filter("2020/cog/A15B12.tif") is True
    assert d.nj_cog_filter("2020/MG3/A15B12.zip") is False
    assert d.nj_cog_filter("1970/SID/x.sid") is False


# --------------------------------------------------------------------------- #
# Offline crawl: FakeS3 + S3PrefixListing.enumerate                           #
# --------------------------------------------------------------------------- #
class FakeS3:
    """Minimal ListObjectsV2: Delimiter='/' -> CommonPrefixes, else -> Contents."""

    def __init__(self, keys):
        self.keys = sorted(keys)

    def list_objects_v2(self, Bucket=None, Prefix="", Delimiter=None, ContinuationToken=None):
        if Delimiter == "/":
            cps = set()
            for k in self.keys:
                if k.startswith(Prefix):
                    rest = k[len(Prefix) :]
                    if "/" in rest:
                        cps.add(Prefix + rest.split("/", 1)[0] + "/")
            return {"CommonPrefixes": [{"Prefix": p} for p in sorted(cps)], "IsTruncated": False}
        contents = [{"Key": k} for k in self.keys if k.startswith(Prefix)]
        return {"Contents": contents, "IsTruncated": False}


_KEYS = [
    "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tif",
    "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E300_2022_6IN_cog.tfw",  # sidecar -> drop
    "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/N013E301_2022_6IN_cog.tif",
    "imagery/orthos/Phase2/KY_KYAPED_2022_6IN/Metadata/info.xml",  # -> drop
    "imagery/orthos/Phase2/KY_KYAPED_2021_6IN/X12_2021_6IN_cog.tif",  # other year
    "imagery/orthos/Phase1/KY_KYAPED_2014_1FT/Y07_2014_1FT_cog.tif",  # other year
    "imagery/orthos/Phase1/KY_KYAPED_2014_6IN_Overviews/Z_2014_6IN_cog.tif",  # overviews -> drop
]


def test_s3prefixlisting_year_filter():
    fake = FakeS3(_KEYS)
    rows, latest = d.KYFROMABOVE.discovery.enumerate(
        regions={"ky"}, years={2022}, latest_year_only=False, limit_per_partition=0, s3=fake
    )
    # only the two 2022 6IN tiles survive (sidecar, Metadata, Overviews, other years gone)
    assert len(rows) == 2, sorted(r["source_key"] for r in rows.values())
    for r in rows.values():
        assert r["region"] == "ky" and r["year"] == 2022
        assert r["source_bucket"] == "kyfromabove"
        assert r["asset_href"].startswith("s3://kyfromabove/")
        assert r["properties"]["kyaped:resolution"] == "6IN"
    assert latest == {"ky": 2022}


def test_s3prefixlisting_all_years_and_latest():
    fake = FakeS3(_KEYS)
    rows, latest = d.KYFROMABOVE.discovery.enumerate(
        regions={"ky"}, years=None, latest_year_only=False, limit_per_partition=0, s3=fake
    )
    years = sorted({r["year"] for r in rows.values()})
    assert years == [2014, 2021, 2022]  # all discovered
    assert len(rows) == 4  # 2x2022 + 2021 + 2014 (noise filtered)
    assert latest == {"ky": 2022}

    rows2, _ = d.KYFROMABOVE.discovery.enumerate(
        regions={"ky"}, years=None, latest_year_only=True, limit_per_partition=0, s3=fake
    )
    assert {r["year"] for r in rows2.values()} == {2022}  # latest-only keeps 2022


def test_region_intersect_guard():
    # constant-region collection: asking for a different region crawls nothing
    fake = FakeS3(_KEYS)
    rows, _ = d.KYFROMABOVE.discovery.enumerate(
        regions={"tx"}, years={2022}, latest_year_only=False, limit_per_partition=0, s3=fake
    )
    assert rows == {}


# --------------------------------------------------------------------------- #
# Live (best-effort): real public kyfromabove bucket, narrow slice            #
# --------------------------------------------------------------------------- #
@pytest.mark.network
def test_s3prefixlisting_live():
    """Prefix discovery against the real public kyfromabove bucket.

    Deselected by default (see the `network` marker in pyproject.toml); run with
    `pytest -m network`. A unit suite should not depend on a third-party bucket
    being reachable.

    It previously caught every Exception and did `return "skipped"`, which pytest
    counts as a pass -- so it reported success whether it had run or not, while
    silently making a live S3 call on every unit-test run. A skip has to be a
    real skip or the suite overstates its own coverage.
    """
    try:
        # cap counts COGs/prefix (not raw keys), so a small cap reliably yields
        # that many .tif and stops listing early -> fast.
        rows, _latest = d.KYFROMABOVE.discovery.enumerate(
            regions={"ky"}, years={2022}, latest_year_only=False, limit_per_partition=12
        )
    except (BotoCoreError, ClientError, OSError) as exc:
        pytest.skip(f"kyfromabove unreachable: {type(exc).__name__}: {exc}")
    assert rows, "live KyFromAbove 2022 returned no COGs"
    sample = next(iter(rows.values()))
    assert sample["region"] == "ky"
    assert sample["year"] == 2022
    assert sample["source_key"].endswith("_cog.tif")


def test_get_descriptor_bucket_lookup():
    nj_desc = d.get_descriptor("nj-imagery")
    assert nj_desc.id == "nj-imagery"

    nj_by_bucket = d.get_descriptor("njogis-imagery")
    assert nj_by_bucket is nj_desc

    ky_desc = d.get_descriptor("kyfromabove")
    ky_by_bucket = d.get_descriptor("kyfromabove")
    assert ky_by_bucket is ky_desc


def test_register_adhoc_collection():
    cid = "test-adhoc-col"
    bucket = "test-adhoc-bucket"
    prefix = "imagery/cogs"
    region = "tx"
    year = 2024
    access = "public"

    desc = d.register_adhoc_collection(cid, bucket, prefix, region, year, access)

    assert desc.id == cid
    assert desc.bucket == bucket
    assert desc.access == access
    assert desc.key_filter("imagery/cogs/tile_2024.tif") is True
    assert desc.key_filter("imagery/cogs/tile_2024.tfw") is False

    kf = desc.discovery.key_parser("imagery/cogs/tile_2024.tif")
    assert kf is not None
    assert kf.region == region
    assert kf.year == year
    assert kf.properties["tile"] == "tile_2024"

    assert d.get_descriptor(cid) is desc
    assert d.get_descriptor(bucket) is desc


if __name__ == "__main__":
    tests = [
        test_ky_key_parser,
        test_ky_cog_filter,
        test_nj_key_parser_and_filter,
        test_s3prefixlisting_year_filter,
        test_s3prefixlisting_all_years_and_latest,
        test_region_intersect_guard,
        test_s3prefixlisting_live,
        test_get_descriptor_bucket_lookup,
        test_register_adhoc_collection,
    ]
    failed = 0
    skipped = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except pytest.skip.Exception as e:
            # pytest.skip() raises rather than returns, so this runner has to
            # know about it -- otherwise the live test crashes the whole run
            # whenever the network is down.
            skipped += 1
            print(f"SKIP {t.__name__}: {e}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    passed = len(tests) - failed - skipped
    print(f"\n{passed} passed, {skipped} skipped, {failed} failed")
    sys.exit(1 if failed else 0)
