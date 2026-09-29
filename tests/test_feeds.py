"""Offline checks for the published-feed readers: that each reader keeps only what its license covers and that ids stay stable."""

import asyncio
import base64
import os
import time
import unittest
from unittest import mock

import httpx

from rt511.feeds import ID_SPACE, _leading_route, compass_image_path, compass_snapshots, feed_cameras, stable_id
from rt511.sources import Source


def source(kind: str, feed: dict, **extra) -> Source:
    return Source(key="test", name="Test", base_url="https://example.gov", states=("XX",), snapshot_content_type="image/jpeg", video_auth=False, has_video=True, attribution="", kind=kind, feed=feed, **extra)


def run(handler, src: Source):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            return await feed_cameras(http, src)

    return asyncio.run(go())


def caltrans_record(slug: str, in_service: str = "true", video: str = "Not Reported") -> dict:
    return {
        "cctv": {
            "inService": in_service,
            "location": {"latitude": "37.8", "longitude": "-122.27", "route": "I-80", "routeSuffix": "", "direction": "West", "locationName": f"{slug} -- I-80", "milepost": "5.5"},
            "imageData": {"streamingVideoURL": video, "static": {"currentImageURL": f"https://cwwp2.dot.ca.gov/data/d4/cctv/image/{slug}/{slug}.jpg"}},
        }
    }


class Feeds(unittest.TestCase):
    def test_ids_are_stable_and_inside_the_block(self):
        url = "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg"
        self.assertEqual(stable_id(url), stable_id(url))
        self.assertLess(stable_id(url), ID_SPACE)
        self.assertLess(ID_SPACE, 10_000_000, "the server gives each source a block of ten million ids")

    def test_caltrans_keeps_cameras_in_service_and_reads_not_reported_as_no_stream(self):
        payload = {"data": [caltrans_record("a", video="https://wzmedia.dot.ca.gov/D4/a.stream/playlist.m3u8"), caltrans_record("b"), caltrans_record("c", in_service="false")]}
        src = source("caltrans", {"url": "https://cwwp2.dot.ca.gov/data/d{district}/cctv/cctvStatusD{district:02d}.json", "districts": [4]})
        cams = run(lambda request: httpx.Response(200, json=payload), src)
        self.assertEqual([c.location for c in cams], ["a -- I-80", "b -- I-80"])
        self.assertEqual(cams[0].video_url, "https://wzmedia.dot.ca.gov/D4/a.stream/playlist.m3u8")
        self.assertIsNone(cams[1].video_url)
        self.assertEqual(cams[0].direction, "W")
        self.assertEqual(cams[0].mile_marker, 5.5)

    def test_arcgis_drops_images_another_agency_owns_and_pages_through_the_layer(self):
        pages = [
            {
                "features": [
                    {"attributes": {"snapshot": "http://www.trimarc.org/images/milestone/CCTV_05_65_0100.jpg", "description": "I-65 at Outer Loop", "highway": None}, "geometry": {"x": -85.7, "y": 38.2}},
                    {"attributes": {"snapshot": "http://pws.trafficwise.org/pullover/172_65.jpg", "description": "I-65 Indiana", "highway": None}, "geometry": {"x": -85.7, "y": 38.3}},
                ],
                "exceededTransferLimit": True,
            },
            {
                "features": [
                    {"attributes": {"snapshot": "http://www.trimarc.org/images/snapshots/IND_CCTV005.jpg", "description": "I-65 Exit 7 Indiana", "highway": None}, "geometry": {"x": -85.7, "y": 38.4}},
                ],
                "exceededTransferLimit": False,
            },
        ]
        seen_offsets = []

        def handler(request):
            seen_offsets.append(request.url.params["resultOffset"])
            return httpx.Response(200, json=pages[len(seen_offsets) - 1])

        src = source("arcgis", {"layer": "https://example.gov/FeatureServer/0", "fields": {"image": "snapshot", "location": "description", "roadway": "highway"}, "image_prefixes": ["https://www.trimarc.org/images/milestone/"]})
        cams = run(handler, src)
        self.assertEqual(seen_offsets, ["0", "2"])
        self.assertEqual(len(cams), 1, "Indiana's images and the dead snapshot path are not covered by KYTC's license")
        self.assertEqual(cams[0].roadway, "I-65", "the route comes from the name when the route field is empty")

    def test_duplicate_listings_of_one_camera_collapse(self):
        feature = {"attributes": {"ImageURL": "https://atmsqf.iowadot.gov/a.jpg", "Desc_": "I-35 at X", "Route": "I-35"}, "geometry": {"x": -93.6, "y": 41.6}}
        src = source("arcgis", {"layer": "https://example.gov/FeatureServer/0", "fields": {"image": "ImageURL", "location": "Desc_", "roadway": "Route"}})
        cams = run(lambda request: httpx.Response(200, json={"features": [feature, feature]}), src)
        self.assertEqual(len(cams), 1)

    def test_leading_route(self):
        self.assertEqual(_leading_route("I-64 at 9th St"), "I-64")
        self.assertEqual(_leading_route("KY841 near US42 exit"), "KY841")
        self.assertEqual(_leading_route("Intersection of 9th St & Market St"), "")

    def test_ohgo_sends_the_users_key_pages_at_its_rate_and_splits_views(self):
        pages = {
            "1": {
                "totalPageCount": 2,
                "results": [
                    {
                        "latitude": 40.0,
                        "longitude": -83.0,
                        "location": "I-70 at Rt 315",
                        "cameraViews": [
                            {"direction": "East", "largeUrl": "https://itscameras.dot.state.oh.us:443/images/a-e.jpg", "mainRoute": "I-70"},
                            {"direction": "West", "largeUrl": "https://itscameras.dot.state.oh.us/images/a-w.jpg", "mainRoute": "I-70"},
                        ],
                    }
                ],
            },
            "2": {"totalPageCount": 2, "results": [{"latitude": 40.1, "longitude": -83.1, "location": "SR-2 at X", "cameraViews": [{"direction": "View", "largeUrl": "https://itscameras.dot.state.oh.us/images/b.jpg", "mainRoute": "SR-2 at X"}]}]},
        }
        seen = []

        def handler(request):
            seen.append((time.monotonic(), request.headers.get("authorization")))
            return httpx.Response(200, json=pages[request.url.params["page"]])

        src = source("ohgo", {"url": "https://publicapi.ohgo.com/api/v1/cameras"}, max_requests_per_s=10, auth={"env": "TEST_OHGO", "header": "Authorization", "format": "APIKEY {key}", "register": "https://example.gov"})
        with mock.patch.dict(os.environ, {"TEST_OHGO": "k"}):
            cams = run(handler, src)
        self.assertEqual([auth for _, auth in seen], ["APIKEY k", "APIKEY k"])
        self.assertGreaterEqual(seen[1][0] - seen[0][0], 0.09, "ten a second means at least a tenth of a second between requests")
        self.assertEqual(len(cams), 3, "each view is its own camera")
        self.assertEqual(cams[0].image_url, "https://itscameras.dot.state.oh.us/images/a-e.jpg", "an explicit :443 is dropped")
        self.assertEqual({c.direction for c in cams[:2]}, {"E", "W"})
        self.assertEqual(cams[2].roadway, "SR-2")

    def test_dev511_sends_the_key_in_the_query_keeps_enabled_views_and_their_streams(self):
        body = [
            {
                "Id": 1,
                "Roadway": "I-94 ",
                "Direction": "Eastbound",
                "Latitude": 43.03,
                "Longitude": -87.95,
                "Location": "I-94 at 35th St",
                "Views": [
                    {"Id": 10, "Url": "https://511.example.gov/map/Cctv/10", "Status": "Enabled", "Description": "East", "VideoUrl": "https://cctv.example.gov/a/playlist.m3u8"},
                    {"Id": 11, "Url": "https://511.example.gov/map/Cctv/11", "Status": "Disabled", "Description": "West", "VideoUrl": ""},
                ],
            },
            {"Id": 2, "Roadway": "", "Direction": "Unknown", "Latitude": 43.1, "Longitude": -87.9, "Location": "US 41 at Capitol Dr", "Views": [{"Id": 12, "Url": "https://511.example.gov/map/Cctv/12", "Status": "Enabled", "Description": "", "VideoUrl": None}]},
            {"Id": 3, "Latitude": None, "Longitude": -87.9, "Location": "no position", "Views": [{"Id": 13, "Url": "https://511.example.gov/map/Cctv/13", "Status": "Enabled"}]},
        ]
        seen = []

        def handler(request):
            seen.append(dict(request.url.params))
            return httpx.Response(200, json=body)

        src = source("dev511", {"url": "https://511.example.gov/api/v2/get/cameras"}, auth={"env": "TEST_DEV511", "query": "key", "register": "https://example.gov"})
        with mock.patch.dict(os.environ, {"TEST_DEV511": "k"}):
            cams = run(handler, src)
        self.assertEqual(seen, [{"key": "k", "format": "json"}], "one call for the whole state, with the key in the query")
        self.assertEqual([c.image_url for c in cams], ["https://511.example.gov/map/Cctv/10", "https://511.example.gov/map/Cctv/12"], "a disabled view and a camera with no position are left out")
        self.assertEqual(cams[0].video_url, "https://cctv.example.gov/a/playlist.m3u8")
        self.assertIsNone(cams[1].video_url)
        self.assertEqual((cams[0].roadway, cams[0].direction), ("I-94", "E"))
        self.assertEqual(cams[1].roadway, "US 41", "an empty roadway falls back to the route the name opens with")
        self.assertEqual(cams[0].location, "I-94 at 35th St", "a single enabled view needs no label of its own")

    def test_a_missing_key_says_where_to_register_rather_than_sending_nothing(self):
        src = source("ohgo", {"url": "https://publicapi.ohgo.com/api/v1/cameras"}, auth={"env": "TEST_ABSENT_KEY", "header": "Authorization", "format": "APIKEY {key}", "register": "https://publicapi.ohgo.com/docs/registration"})
        with mock.patch("rt511.sources._dotenv", return_value=None), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEST_ABSENT_KEY", None)
            with self.assertRaises(SystemExit) as caught:
                run(lambda request: httpx.Response(500), src)
        self.assertIn("publicapi.ohgo.com/docs/registration", str(caught.exception))

    def test_tripcheck_reads_the_inventory_and_stores_https(self):
        body = {"CCTVInventoryRequest": [{"device-id": 1, "device-name": "AstoriaNB", "latitude": 46.1, "longitude": -123.8, "route-id": "US101", "milepoint": 3.7, "cctv-url": "http://www.TripCheck.com/roadcams/cams/A_pid1.jpg", "cctv-other": "US101 at Astoria"}]}
        src = source("tripcheck", {"url": "https://api.odot.state.or.us/tripcheck/Cctv/Inventory"}, auth={"env": "TEST_OR", "header": "Ocp-Apim-Subscription-Key", "format": "{key}", "register": "x"})
        with mock.patch.dict(os.environ, {"TEST_OR": "k"}):
            cams = run(lambda request: httpx.Response(200, json=body) if request.headers.get("ocp-apim-subscription-key") == "k" else httpx.Response(401), src)
        self.assertEqual(cams[0].image_url, "https://www.TripCheck.com/roadcams/cams/A_pid1.jpg")
        self.assertEqual((cams[0].roadway, cams[0].mile_marker), ("US101", 3.7))

    def test_compass_reads_positions_from_status_and_pictures_from_the_bulk_document(self):
        status = b"""<status xmlns="http://its.gov/c2c_icd"><cctvStatusData><net id="Vermont"><cctvStatus id="I-89 SB BERLIN" netId="Vermont"><name>BERLIN I-89 South</name><lat>44212323</lat><lon>-72583354</lon><status>Device Online</status><equipLoc><roadway>I-89</roadway><direction>South</direction></equipLoc></cctvStatus></net></cctvStatusData></status>"""
        src = source("compass", {"url": "https://nec-por.ne-compass.com/NEC.XmlDataPortal/api/c2c", "networks": {"VT": "Vermont"}})
        cams = run(lambda request: httpx.Response(200, content=status), src)
        self.assertEqual(len(cams), 1)
        self.assertAlmostEqual(cams[0].lat, 44.212323)
        self.assertEqual(cams[0].image_url, compass_image_path("Vermont", "I-89 SB BERLIN"))
        self.assertEqual((cams[0].roadway, cams[0].direction), ("I-89", "S"))
        jpeg = b"\xff\xd8picture"
        doc = f"""<status xmlns="http://its.gov/c2c_icd"><cctvSnapshotData><net id="Vermont"><cctvSnapshot id="I-89 SB BERLIN"><snippet>{base64.b64encode(jpeg).decode()}</snippet></cctvSnapshot><cctvSnapshot id="DARK"><snippet /></cctvSnapshot></net></cctvSnapshotData></status>""".encode()
        self.assertEqual(compass_snapshots(doc), {"I-89 SB BERLIN": jpeg}, "a camera with an empty snippet has no picture")


if __name__ == "__main__":
    unittest.main()
