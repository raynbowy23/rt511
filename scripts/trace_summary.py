"""Summarize a live trace from the server's own logs: what reached the top of the wall, what held it there, what the arbiter did, and what the run cost the agency.

    uv run python scripts/trace_summary.py --since 2026-09-30T21:05 --until 2026-09-30T23:05 [--region columbus-oh] [--server-log path] [--top 8] [--cap 6] [--without-planned-work] [--json path]

Reads out/attention-<date>.jsonl, the decision log of the top 30 cameras every 10 seconds, and out/jev-<date>.jsonl, every arbiter call. Times are local, as the logs are named. With --server-log, the periodic "load:" lines the server prints give the request rate and data volume. It prints Markdown, and with --json it also writes the top-place figures to a file, which scripts/result_figures.mjs draws.

With --without-planned-work, each logged ranking is replayed as the server now scores it, with no floor from a planned-work record, so a trace recorded before that rule can be compared with the rule on the same pictures. Only the logged top 30 can be rescored. A camera outside it scored no higher than the 30th logged camera then and scores no higher now, so a replayed place is certain when its new score is at least that bound, and the replay says how many places are.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import statistics

BAND = 0.5  # shared/src/score.ts SCORE.BAND: a score above it is held by a floor
FLOOR_HOLD_MIN = 0.2  # shared/src/score.ts SCORE.FLOOR_HOLD_MIN: the floor that lifts a camera into the upper band
PLANNED_WORK = re.compile(r"\b(repairs?|maintenance|construction|road ?work|work ?zone)\b", re.IGNORECASE)  # server/src/cad.ts PLANNED_WORK


def movement(row: dict) -> float:
    """The clamped movement term, rebuilt from the logged parts, as the wall's cap falls back to."""
    review = row.get("review") or {}
    factor = review.get("factor", 1) if review.get("acted") else 1
    value = row["scale_amplifier"] * factor * (0.5 * (row.get("anomaly") or 0) + 0.5 * (row.get("spectacle") or 0))
    return min(1.0, max(0.0, value))


def combine(movement_term: float, floor: float) -> float:
    """shared/src/score.ts combineAttention."""
    level = min(1.0, max(movement_term, floor))
    return BAND + BAND * level if floor >= FLOOR_HOLD_MIN else BAND * level


def planned(label: str | None) -> bool:
    """Whether a logged record label names planned work. A label begins with ODOT's category."""
    return label is not None and PLANNED_WORK.search(label.split(" at ")[0]) is not None


def without_planned_work(row: dict) -> dict:
    """The row rescored with no floor from planned work, as server/src/cad.ts now reads such records."""
    row = dict(row)
    if planned(row.get("incident")):
        row["incident_floor"] = 0
    queue = row.get("queue") or {}
    if queue.get("source") == "incident" and planned(queue.get("incident")):
        row["queue_floor"] = 0
    floor = max(row.get("incident_floor") or 0, row.get("queue_floor") or 0, (row.get("gate") or {}).get("floor") or 0)
    row["attention"] = round(combine(movement(row), floor), 3)
    return row


def capped(top: list[dict], limit: int | None) -> list[tuple[float, dict]]:
    """The order the wall shows, as (score, row) pairs, with at most `limit` held cameras keeping their place, as web/src/hooks/useWallRanking.ts does. Without a limit, the logged order."""
    held = 0
    scored = []
    for row in sorted(top, key=lambda r: r["rank"]):
        score = row["attention"]
        if score > BAND:
            held += 1
            if limit is not None and held > limit:
                score = BAND * movement(row)
        scored.append((score, row))
    return sorted(scored, key=lambda pair: -pair[0])


def local_ts(text: str) -> float:
    return dt.datetime.fromisoformat(text).timestamp()


def rows(pattern: str, since: float, until: float):
    for path in sorted(glob.glob(pattern)):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                if since <= row.get("ts", 0) <= until:
                    yield row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--region")
    parser.add_argument("--server-log")
    parser.add_argument("--top", type=int, default=8)
    parser.add_argument("--cap", type=int, help="held cameras allowed among the prominent tiles, half of the large and wide tiles on the wall")
    parser.add_argument("--without-planned-work", action="store_true", help="replay each ranking with no floor from planned work")
    parser.add_argument("--json", help="also write the top-place figures here")
    parser.add_argument("--out", default="out")
    args = parser.parse_args()
    since, until = local_ts(args.since), local_ts(args.until)

    decisions = [r for r in rows(os.path.join(args.out, "attention-*.jsonl"), since, until) if not args.region or r.get("region") == args.region]
    snapshots = collections.defaultdict(list)
    for r in decisions:
        snapshots[r["ts"]].append(r)
    times = sorted(snapshots)
    bounds = {t: min(r["attention"] for r in snapshots[t]) for t in times}
    if args.without_planned_work:
        snapshots = {t: [without_planned_work(r) for r in snapshots[t]] for t in times}
    print(f"Window {args.since} to {args.until}, {len(times)} rankings logged, {len({r['id'] for r in decisions})} distinct cameras in the logged top 30.\n")

    # What held the top of the wall.
    held_share, driver_counts, certain, places = [], collections.Counter(), 0, 0
    for t in times:
        top = capped(snapshots[t], args.cap)[: args.top]
        certain += sum(score >= bounds[t] for score, _ in top)
        places += len(top)
        held_share.append(sum(score > BAND for score, _ in top) / max(1, len(top)))
        for score, r in top:
            if score <= BAND:
                driver_counts["movement only"] += 1
            elif (r.get("incident_floor") or 0) > 0 and r["incident_floor"] >= max(r.get("queue_floor") or 0, (r.get("gate") or {}).get("floor", 0)):
                driver_counts["incident floor"] += 1
            elif (r.get("queue_floor") or 0) > 0:
                driver_counts["queue floor"] += 1
            else:
                driver_counts["stopped-traffic floor"] += 1
    if held_share:
        how = f" with at most {args.cap} held cameras kept ahead, as the wall applies" if args.cap is not None else ", as logged, without the wall's cap"
        print(f"Top {args.top} places{how}" + (", replayed with no floor from planned work." if args.without_planned_work else "."))
        if args.without_planned_work:
            print(f"Replayed places certain against the unlogged cameras: {certain / max(1, places):.0%}.")
        print(f"Share of the top {args.top} places held by a floor: median {statistics.median(held_share):.0%}, maximum {max(held_share):.0%}.")
        total = sum(driver_counts.values())
        print("What put each top place there: " + ", ".join(f"{k} {v / total:.0%}" for k, v in driver_counts.most_common()) + ".\n")
        if args.json:
            with open(args.json, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "region": args.region,
                        "since": args.since,
                        "until": args.until,
                        "rankings": len(times),
                        "top": args.top,
                        "cap": args.cap,
                        "without_planned_work": args.without_planned_work,
                        "held_share_median": statistics.median(held_share),
                        "drivers": {k: v / total for k, v in driver_counts.items()},
                        "certain": certain / max(1, places) if args.without_planned_work else None,
                    },
                    handle,
                    indent=2,
                )

    incidents = collections.Counter(r["incident"] for r in decisions if r.get("incident"))
    queues = collections.Counter(r["queue"]["incident"] for r in decisions if r.get("queue"))
    flagged = {r["id"] for r in decisions if r.get("ambiguous_zero")}
    print(f"Incident records naming a logged camera: {len(incidents)}. Records carried upstream as a queue: {len(queues)}. Cameras flagged for zero motion while in the top 30: {len(flagged)}.")
    for name, n in incidents.most_common():
        print(f"- {name} ({n} logged rows)")
    print()

    # The arbiter.
    calls = list(rows(os.path.join(args.out, "jev-*.jsonl"), since, until))
    kinds = collections.Counter(c["kind"] for c in calls if c["kind"] != "rubric")
    print("Arbiter calls: " + (", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) or "none") + ".")
    reviews = [c for c in calls if c["kind"] == "review" and (not args.region or c.get("region") == args.region)]
    taus = [c["shadow"]["kendall_tau"] for c in reviews if c.get("shadow", {}).get("kendall_tau") is not None]
    if taus:
        same = sum(1 for c in reviews if c["shadow"]["equation_order"][:1] == c["shadow"]["look_order"][:1])
        print(f"Second looks: {len(reviews)}, Kendall tau against the equation median {statistics.median(taus):.2f} (range {min(taus):.2f} to {max(taus):.2f}), same camera first in {same} of {len(reviews)}.")
    gates = [c for c in calls if c["kind"] == "gate"]
    if gates:
        values = [c["answers"]["standstill"]["noul"] for c in gates if "standstill" in c.get("answers", {})]
        print(f"Stopped-traffic questions: {len(gates)}, standstill probabilities {', '.join(f'{v:.2f}' for v in values)}.")
    latency = [c["latency_ms"] for c in calls if "latency_ms" in c]
    tokens = [c["usage"]["input_tokens"] for c in calls if "usage" in c]
    if latency:
        print(f"Call latency median {statistics.median(latency):.0f} ms, input tokens median {statistics.median(tokens):.0f}.")
    print()

    # What it cost the agency.
    if args.server_log:
        rates, volume = [], []
        with open(args.server_log, encoding="utf-8") as handle:
            for line in handle:
                m = re.match(r"load: ([\d.]+) req/s, (\d+) MB/h", line)
                if m:
                    rates.append(float(m.group(1)))
                    volume.append(int(m.group(2)))
        if rates:
            print(f"Load reported by the server: {len(rates)} readings, median {statistics.median(rates):.2f} requests a second and {statistics.median(volume)} MB an hour, maximum {max(rates):.2f} requests a second.")


if __name__ == "__main__":
    main()
