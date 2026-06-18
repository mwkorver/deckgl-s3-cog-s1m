import importlib
import os
import sys
import types
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s1m


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.sql = None
        self.parameters = None

    def execute(self, sql, parameters):
        self.sql = sql
        self.parameters = parameters
        return FakeResult(self.rows)


class IdentityTransformer:
    def transform(self, x, y):
        return x, y


class FakeGeometry:
    def __init__(self, covers):
        self._covers = covers

    def covers(self, _point):
        return self._covers


def fake_shapely_modules():
    shapely = types.ModuleType("shapely")
    shapely.from_wkb = lambda value: FakeGeometry(value == b"covering")
    geometry = types.ModuleType("shapely.geometry")
    geometry.Point = lambda x, y: (x, y)
    return {"shapely": shapely, "shapely.geometry": geometry}


def test_get_reader_opens_only_once_per_execution_environment():
    module = importlib.reload(s1m)
    reader = {"marker": "reader"}
    with patch.object(module, "_open_reader", return_value=reader) as open_reader:
        assert module.get_reader() is reader
        assert module.get_reader() is reader
    open_reader.assert_called_once_with()


def test_cover_dataset_queries_bbox_and_checks_geometry():
    con = FakeConnection(
        [
            ("S1M/outside.tif", b"outside"),
            ("S1M/covering.tif", b"covering"),
        ]
    )
    reader = {"con": con, "to_albers": IdentityTransformer()}

    with (
        patch.object(s1m, "get_reader", return_value=reader),
        patch.dict(sys.modules, fake_shapely_modules()),
    ):
        result = s1m.cover_dataset(0.25, 0.5)

    assert result == (
        "s3://prd-tnm/StagedProducts/Elevation/S1M/covering.tif"
    )
    assert "read_parquet" in con.sql
    assert "bbox_xmin <= ?" in con.sql
    assert con.parameters == [0.25, 0.25, 0.5, 0.5]


def test_cover_dataset_returns_none_when_no_candidate_covers_point():
    con = FakeConnection([("S1M/outside.tif", b"outside")])
    reader = {"con": con, "to_albers": IdentityTransformer()}

    with (
        patch.object(s1m, "get_reader", return_value=reader),
        patch.dict(sys.modules, fake_shapely_modules()),
    ):
        assert s1m.cover_dataset(0, 0) is None
