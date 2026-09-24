"""Offline checks for the road attributes used by capacity priors."""

import unittest

from rt511.network import Snapper
from rt511.osm import build_road_graph, lane_count, speed_kmh, speed_mps


class CapacityAttributes(unittest.TestCase):
    def test_speed_units_and_provenance(self):
        self.assertAlmostEqual(speed_kmh({"maxspeed": "55 mph"})[0], 88.51392)
        self.assertEqual(speed_kmh({"maxspeed": "55 mph"})[1], "tag")
        self.assertEqual(speed_kmh({"maxspeed": "90"}), (90, "tag"))
        self.assertEqual(speed_mps({"maxspeed": "90"}), 25)
        for value in (None, "", "signals", "nan", "0"):
            speed, source = speed_kmh({"highway": "motorway", "maxspeed": value})
            self.assertAlmostEqual(speed, 112.65408)
            self.assertEqual(source, "default")

    def test_lane_tags(self):
        self.assertEqual(lane_count("3"), 3)
        for value in (None, "", "2;3", "2.5", "unknown"):
            self.assertIsNone(lane_count(value))

    def test_snap_attributes(self):
        for oneway, two_way in (("yes", False), ("no", True), ("-1", False)):
            road = build_road_graph({"elements": [{"type": "way", "id": 1, "nodes": [1, 2], "geometry": [{"lat": 30, "lon": -84}, {"lat": 30.001, "lon": -84}], "tags": {"highway": "primary", "oneway": oneway, "lanes": "3", "lanes:forward": "2", "lanes:backward": "1", "maxspeed": "55 mph"}}]})
            snap = Snapper(road).snap(30.0005, -84)
            self.assertIsNotNone(snap)
            self.assertEqual((snap.lanes, snap.lanes_forward, snap.lanes_backward), (3, 2, 1))
            self.assertEqual(snap.two_way, two_way)
            self.assertAlmostEqual(snap.maxspeed_kmh, 88.51392)
            self.assertEqual(snap.maxspeed_source, "tag")


if __name__ == "__main__":
    unittest.main()
