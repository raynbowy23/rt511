"""Vehicle detector for the zero-motion gate, served on localhost to the TypeScript server.

The gate fires on a frame that changed by nothing in an hour that usually moves, and frame difference alone cannot say whether that is stopped traffic or an empty road. A count of vehicles in the still picture can, so the server posts the frame here and hands the count to the arbiter as evidence. It never decides anything itself.

A separate process rather than a binding inside the server, for two reasons. The model is Ultralytics YOLO26, whose code and weights are AGPL-3.0 and optional, so the server has to run exactly as before when this is not running. And the GPU wants one caller at a time, which a single-threaded HTTP server gives for free.

    uv sync --extra detector
    uv run rt511 detect                      weights from data/models/yolo26n.pt, port 8513
"""

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# COCO class ids the gate counts. Pedestrians and bicycles are left out on purpose: the question is whether traffic is standing on the road, and a person on the pavement says nothing about that.
VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
# The largest snapshot any 511 site in the survey serves is a couple of hundred kilobytes, so anything far past that is not a camera frame.
MAX_BODY = 8 * 1024 * 1024


class Detector:
    def __init__(self, weights: Path, conf: float, device: str | None):
        try:
            import cv2
            import numpy as np
            from ultralytics import YOLO
        except ImportError as e:
            raise SystemExit(f"the detector needs its optional dependencies ({e.name} is missing). Install them with `uv sync --extra detector`.") from e
        self._cv2, self._np = cv2, np
        self.model = YOLO(str(weights))
        self.name = weights.stem
        self.conf = conf
        self.device = device
        # The first inference loads kernels and takes seconds rather than milliseconds, so it is paid here instead of inside the server's timeout.
        self.model.predict(np.zeros((480, 640, 3), np.uint8), device=device, verbose=False)

    def count(self, data: bytes) -> dict:
        img = self._cv2.imdecode(self._np.frombuffer(data, self._np.uint8), self._cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("not a decodable image")
        started = time.perf_counter()
        result = self.model.predict(img, conf=self.conf, classes=list(VEHICLE_CLASSES), device=self.device, verbose=False)[0]
        latency_ms = (time.perf_counter() - started) * 1000
        by_class: dict[str, int] = {}
        for k in result.boxes.cls.int().tolist():
            by_class[VEHICLE_CLASSES[k]] = by_class.get(VEHICLE_CLASSES[k], 0) + 1
        confidences = sorted((round(c, 3) for c in result.boxes.conf.tolist()), reverse=True)
        return {
            "vehicles": sum(by_class.values()),
            "by_class": by_class,
            "confidences": confidences,
            "width": img.shape[1],
            "height": img.shape[0],
            "model": self.name,
            "conf": self.conf,
            "latency_ms": round(latency_ms, 1),
        }


def serve(weights: Path, host: str, port: int, conf: float, device: str | None = None) -> None:
    if not weights.exists():
        raise SystemExit(f"no weights at {weights}. They are AGPL-3.0 and never committed; put yolo26n.pt in data/models/ or pass --weights.")
    detector = Detector(weights, conf, device)

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, body: dict) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._reply(200, {"model": detector.name, "conf": detector.conf, "classes": sorted(VEHICLE_CLASSES.values())})
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/detect":
                self._reply(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._reply(400, {"error": "expected an image body"})
                return
            try:
                self._reply(200, detector.count(self.rfile.read(length)))
            except ValueError as e:
                self._reply(400, {"error": str(e)})

        def log_message(self, format: str, *args: object) -> None:
            # One line per frame would bury everything else in the terminal. The server logs every count it receives.
            pass

    # Single-threaded on purpose, so the GPU sees one frame at a time.
    server = HTTPServer((host, port), Handler)
    print(f"detector {detector.name} (conf {conf}, device {device or 'auto'}) on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
