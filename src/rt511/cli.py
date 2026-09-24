"""Command line entry points for the offline pipeline.

This is a batch tool, not a service. It discovers where cameras are, fetches a region's catalog, snaps those cameras onto the road network and writes the site graph. Serving that work to a browser is the TypeScript server's job, in `server/`, which reads the files these commands write."""

import argparse
import asyncio
import json
from pathlib import Path

from .catalog import catalog_path, fetch_catalog, load_catalog, write_catalog
from .counts import aadt_path, match_cameras, write_aadt
from .graph import build, graph_path, write_json
from .index_national import fetch_index, write_index
from .metros import find_metros, name_metros
from .regions import Region, get_region, load_regions, region_for_city, save_region
from .sources import SOURCES, get_source

ROOT = Path(__file__).resolve().parents[2]


def cmd_sources(args: argparse.Namespace) -> None:
    print(f"{len(SOURCES)} sources covering {sum(len(s.states) for s in SOURCES.values())} states\n")
    for s in sorted(SOURCES.values(), key=lambda x: x.key):
        bits = [f"snapshots {s.snapshot_content_type.split('/')[1]}", f"poll {s.poll_period_s:.0f}s"]
        bits.append("video" if s.has_video else "no video")
        print(f"{s.key:8s} {s.name:32s} {','.join(s.states):6s} {' · '.join(bits)}")
        print(f"{'':8s} {s.license}")
        if s.notes:
            print(f"{'':8s} {s.notes}")


def cmd_index(args: argparse.Namespace) -> None:
    index = asyncio.run(fetch_index())
    path = write_index(index, ROOT)
    total = sum(len(v) for v in index.values())
    for key, entries in sorted(index.items(), key=lambda kv: -len(kv[1])):
        print(f"  {key:8s} {len(entries):6d}")
    print(f"\n{total} cameras across {sum(1 for v in index.values() if v)} sources -> {path} ({path.stat().st_size // 1024} KB)")


def cmd_metros(args: argparse.Namespace) -> None:
    metros = find_metros(ROOT, args.min)
    if args.name:
        name_metros(metros[: args.top])
    have = {(r.source, round(r.centroid[0], 1), round(r.centroid[1], 1)) for r in load_regions(ROOT).values()}
    print(f"{len(metros)} camera clusters of {args.min}+ cameras, holding {sum(m.cameras for m in metros)} of the indexed total\n")
    print(f"{'cameras':>7s}  {'source':8s} {'video':5s}  {'position':22s} {'place':24s} covered")
    for m in metros[: args.top]:
        src = get_source(m.source)
        near = any(s == m.source and abs(la - m.lat) < 0.3 and abs(lo - m.lon) < 0.3 for s, la, lo in have)
        print(f"{m.cameras:7d}  {m.source:8s} {'yes' if src.has_video else 'no':5s}  {m.lat:9.4f},{m.lon:11.4f}  {(m.name or ''):24s} {'yes' if near else ''}")
    if not args.name:
        print("\nRe-run with --name to reverse-geocode the centres through Nominatim (one a second).")


def cmd_city(args: argparse.Namespace) -> None:
    region = region_for_city(args.city, ROOT, radius_km=args.radius, limit=args.limit)
    save_region(region, ROOT)
    src = get_source(region.source)
    print(f"{region.name} -> region {region.key!r} on {src.name}")
    print(f"  centre {region.center}, radius {region.radius_km} km, bbox {region.bbox}" + (f", keeping the {region.limit} nearest cameras" if region.limit else ""))
    print(f"\nNext:\n  uv run rt511 catalog --region {region.key}\n  uv run rt511 build --region {region.key}")


def cmd_regions(args: argparse.Namespace) -> None:
    for key, r in load_regions(ROOT).items():
        src = get_source(r.source)
        cat = catalog_path(ROOT, r)
        gph = graph_path(ROOT, r)
        have = "catalog" if cat.exists() else "no catalog"
        have += " + graph" if gph.exists() else ""
        extent = f"{r.radius_km:g} km radius" if r.radius_km else "fixed bbox"
        cap = f", nearest {r.limit}" if r.limit else ""
        print(f"{key:16s} {r.name:20s} {src.name:18s} {extent + cap:22s} [{have}]")


def cmd_catalog(args: argparse.Namespace) -> None:
    region = get_region(args.region, ROOT)
    cams = asyncio.run(fetch_catalog(region))
    path = catalog_path(ROOT, region)
    write_catalog(cams, path)
    with_video = sum(1 for c in cams if c.video_url)
    with_dir = sum(1 for c in cams if c.direction)
    with_mm = sum(1 for c in cams if c.mile_marker is not None)
    print(f"{region.name}: {len(cams)} cameras, {with_video} with video, {with_dir} with a direction code, {with_mm} with a mile marker")
    print(f"wrote {path}")


def cmd_counts(args: argparse.Namespace) -> None:
    region = get_region(args.region, ROOT)
    data = match_cameras(region, ROOT)
    path = aadt_path(ROOT, region)
    write_aadt(data, path)
    values = sorted(c["aadt"] for c in data["cameras"].values())
    total = len(load_catalog(catalog_path(ROOT, region)))
    aligned = sum(1 for c in data["cameras"].values() if c["aligned"])
    print(f"{region.name}: {data['segments']} counted segments, matched {len(values)} of {total} cameras, {aligned} along their own carriageway")
    if values:
        print(f"  AADT  min {values[0]:,}  median {values[len(values)//2]:,}  max {values[-1]:,}")
    print(f"wrote {path}")


def cmd_build(args: argparse.Namespace) -> None:
    region = get_region(args.region, ROOT)
    graph = build(region, ROOT)
    out = graph_path(ROOT, region)
    write_json(graph, out)
    r = graph.report
    print(f"{region.name}: cameras {len(graph.cameras)}  sites {len(graph.sites)} ({r['freeway_sites']} freeway)  edges {len(graph.edges)}  unsnapped {graph.unsnapped}")
    print(f"road graph: {r['road_graph']}")
    print(f"edge kinds: {r['edge_kinds']}")
    print(f"site sizes (cameras -> count): {r['site_sizes']}")
    print(f"snap distance m: {r['snap_distance_m']}")
    print(f"route refs: {r['ref_matched']} matched, {r['ref_unnumbered_road']} on an unnumbered road, {r['ref_mismatched']} on a different route, of {r['ref_expected']} cameras that name one")
    print(f"isolated sites: {r['isolated_sites']}")
    print(f"direction code checks: {r['direction_checked']}, reversed {len(r['direction_mismatches'])}, offset {r.get('direction_offset_deg')}")
    for m in r["direction_mismatches"]:
        print("   ", m)
    print(f"freeway mile marker checks: {len(r['freeway_mile_marker_checks'])}, order violations {len(r['freeway_order_violations'])}, length outliers {len(r['freeway_length_outliers'])}")
    for m in r["freeway_order_violations"] + r["freeway_length_outliers"]:
        print("   ", m)
    print(f"wrote {out}")


def cmd_detect(args: argparse.Namespace) -> None:
    # Imported here so that every other command runs without the detector's optional dependencies installed.
    from .detect import serve

    serve(args.weights, args.host, args.port, args.conf, args.device)


def main() -> None:
    p = argparse.ArgumentParser(prog="rt511")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("regions", help="list the configured regions and what has been built")
    r.set_defaults(func=cmd_regions)

    so = sub.add_parser("sources", help="list the camera sources this project reads, what each publishes, and its terms")
    so.set_defaults(func=cmd_sources)

    ix = sub.add_parser("index", help="fetch every camera position from every source, for the national map")
    ix.set_defaults(func=cmd_index)

    mt = sub.add_parser("metros", help="show where cameras cluster nationally, to decide where a region is worth adding")
    mt.add_argument("--min", type=int, default=40, help="smallest cluster to report (default 40)")
    mt.add_argument("--top", type=int, default=25, help="how many to list (default 25)")
    mt.add_argument("--name", action="store_true", help="reverse-geocode each centre to a place name")
    mt.set_defaults(func=cmd_metros)

    ci = sub.add_parser("city", help="create a region around a city, choosing the source that covers its state")
    ci.add_argument("city", help='e.g. "Des Moines, IA" or "Oakland, California"')
    ci.add_argument("--radius", type=float, default=15.0, help="km around the city centre (default 15)")
    ci.add_argument("--limit", type=int, default=80, help="keep only the N cameras nearest the centre (default 80, 0 for no cap)")
    ci.set_defaults(func=cmd_city)

    c = sub.add_parser("catalog", help="fetch a region's camera catalog from its source's published feed")
    c.add_argument("--region", required=True)
    c.set_defaults(func=cmd_catalog)

    co = sub.add_parser("counts", help="join the agency's published traffic counts to a region's cameras, where it publishes them (build the graph first)")
    co.add_argument("--region", required=True)
    co.set_defaults(func=cmd_counts)

    b = sub.add_parser("build", help="build the camera site graph for a region")
    b.add_argument("--region", required=True)
    b.set_defaults(func=cmd_build)

    de = sub.add_parser("detect", help="serve the optional vehicle detector the zero-motion gate asks about still frames")
    de.add_argument("--weights", type=Path, default=ROOT / "data" / "models" / "yolo26n.pt", help="model weights (default data/models/yolo26n.pt)")
    de.add_argument("--host", default="127.0.0.1")
    de.add_argument("--port", type=int, default=8513)
    de.add_argument("--conf", type=float, default=0.25, help="detection confidence threshold (default 0.25, the Ultralytics default)")
    de.add_argument("--device", default=None, help="torch device, e.g. cpu or 0 (default: the GPU when there is one)")
    de.set_defaults(func=cmd_detect)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
