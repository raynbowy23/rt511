"""Offline checks for the traffic-count join: that a ramp named after the interstate it serves never lends the interstate its count, and that a camera naming a route only takes a count from that route."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from rt511 import counts
from rt511.counts import Segment, fetch_segments, match_cameras
from rt511.regions import Region
from rt511.sources import get_source

REGION = Region("test-ia", "Test, IA", "iowadot", (41.5, -93.7, 41.7, -93.5), center=(41.6, -93.6), radius_km=10, limit=10)


class Counts(unittest.TestCase):
    def test_ramps_named_after_the_interstate_are_dropped(self):
        page = {
            "features": [
                {"attributes": {"AADT": 90600, "ROUTE_NAME": "I 35", "TOTALTRUCKBUS": 9060}, "geometry": {"paths": [[[-93.6, 41.6], [-93.6, 41.61]]]}},
                {"attributes": {"AADT": 1760, "ROUTE_NAME": "86TH ST, N TO I 35 S", "TOTALTRUCKBUS": 10}, "geometry": {"paths": [[[-93.6, 41.6], [-93.599, 41.601]]]}},
            ]
        }
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=page))
        real = httpx.Client
        with mock.patch("rt511.counts.httpx.Client", lambda **kw: real(transport=transport, **kw)):
            segs = fetch_segments(REGION, get_source("iowadot"))
        self.assertEqual([s.aadt for s in segs], [90600])
        self.assertEqual(segs[0].truck_pct, 10.0)

    def test_a_camera_naming_a_route_only_takes_that_routes_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data").mkdir()
            (root / "out").mkdir()
            cams = [
                {"id": 1, "region": REGION.key, "source": "iowadot", "image_path": "x", "roadway": "I-35", "direction": None, "location": "I-35 at 86th", "lat": 41.6, "lon": -93.6, "video_url": None, "video_auth": False, "link_id": None, "source_system": "t", "mile_marker": None},
                {"id": 2, "region": REGION.key, "source": "iowadot", "image_path": "y", "roadway": "", "direction": None, "location": "a street", "lat": 41.65, "lon": -93.6, "video_url": None, "video_auth": False, "link_id": None, "source_system": "t", "mile_marker": None},
            ]
            (root / "data" / f"cameras_{REGION.key}.json").write_text(json.dumps(cams))
            (root / "out" / f"graph_{REGION.key}.json").write_text(json.dumps({"sites": []}))
            # A US 6 segment passes right beside both cameras; I-35 is 100 m east of the first.
            segs = [
                Segment(aadt=18000, year=2024, roadway="US 6", county=None, truck_pct=None, coords=[(-93.6001, 41.59), (-93.6001, 41.66)]),
                Segment(aadt=90600, year=2024, roadway="I 35", county=None, truck_pct=None, coords=[(-93.5988, 41.59), (-93.5988, 41.61)]),
            ]
            with mock.patch.object(counts, "fetch_segments", return_value=segs):
                data = match_cameras(REGION, root)
        self.assertEqual(data["cameras"]["1"]["aadt"], 90600, "the interstate camera skips the closer US 6 segment")
        self.assertEqual(data["cameras"]["2"]["aadt"], 18000, "a camera that names no route takes the nearest road")
        self.assertIn("CC BY 4.0", data["attribution"])


if __name__ == "__main__":
    unittest.main()
