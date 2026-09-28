"""Compare the rankers on blind choices: the fixed equation, the second look, movement alone, and a person's own model.

Reads one or more exports from "Which would you watch?" (the Export button) and, optionally, the arbiter's logs in out/. Only choices made in Evaluate mode are scored, because Learn mode picks its pairs to teach the person's own model and would bias the test towards it.

    uv run python scripts/evaluate_attention.py rt511-attention-2026-09-28.json [more.json] [--logs out]

For each ranker it reports how often the ranker picked the camera the person chose, over the choices where that ranker told the two cameras apart, with a 95% bootstrap interval, overall and for each stratum. The person's own model is scored on held-out choices only: each evaluation choice is predicted by a model fitted on every other choice. Nothing here is written anywhere; it prints.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import statistics
from collections.abc import Callable

BOOTSTRAP = 2000
SEED = 511
# The same fit as web/src/preference.ts, so the held-out model is the one the wall uses.
L2 = 0.02
RATE = 0.5
STEPS = 400
# A second-look answer below this confidence moved nothing on the wall. Reported apart, since it is still a ranking.
ACT_CONFIDENCE = 0.5

Vote = dict
# A ranker returns its preference for a over b: positive, negative, or None when it cannot tell them apart.
Ranker = Callable[[Vote], float | None]


def load_votes(paths: list[str]) -> list[Vote]:
    votes: list[Vote] = []
    seen: set[tuple] = set()
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
        for vote in body.get("votes", []):
            # The same choice exported twice counts once.
            key = (vote["ts"], vote["a"]["id"], vote["b"]["id"])
            if key not in seen:
                seen.add(key)
                votes.append(vote)
    return votes


def difference(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or abs(a - b) < 1e-9:
        return None
    return a - b


def equation(vote: Vote) -> float | None:
    return difference(vote["a"].get("equation"), vote["b"].get("equation"))


def movement(vote: Vote) -> float | None:
    return difference(vote["a"]["x"][0], vote["b"]["x"][0])


def look(confident_only: bool) -> Ranker:
    def rank(vote: Vote) -> float | None:
        a, b = vote["a"].get("look"), vote["b"].get("look")
        if not a or not b:
            return None
        if confident_only and min(a["confidence"], b["confidence"]) < ACT_CONFIDENCE:
            return None
        return difference(a["level"], b["level"])

    return rank


def fit(votes: list[Vote]) -> list[float]:
    """Bradley-Terry over the vote features, from zero, on a fixed schedule, as in the browser."""
    width = len(votes[0]["a"]["x"]) if votes else 0
    w = [0.0] * width
    rows = [([xa - xb for xa, xb in zip(v["a"]["x"], v["b"]["x"], strict=False)], 1.0 if v["pick"] == "a" else 0.0) for v in votes]
    if not rows:
        return w
    for _ in range(STEPS):
        gradient = [L2 * value for value in w]
        for d, y in rows:
            z = sum(wi * di for wi, di in zip(w, d, strict=False))
            error = 1 / (1 + math.exp(-z)) - y
            for i, di in enumerate(d):
                gradient[i] += error * di / len(rows)
        w = [wi - RATE * gi for wi, gi in zip(w, gradient, strict=False)]
    return w


def held_out_person(all_votes: list[Vote]) -> Ranker:
    """The person's own model, each evaluation choice predicted by a fit on every other choice."""
    cache: dict[int, list[float]] = {}

    def rank(vote: Vote) -> float | None:
        key = id(vote)
        if key not in cache:
            cache[key] = fit([other for other in all_votes if other is not vote])
        w = cache[key]
        return difference(sum(wi * x for wi, x in zip(w, vote["a"]["x"], strict=False)), sum(wi * x for wi, x in zip(w, vote["b"]["x"], strict=False)))

    return rank


def hits(votes: list[Vote], ranker: Ranker) -> list[int]:
    """One entry per choice the ranker could decide: 1 when it favoured the camera the person picked."""
    out = []
    for vote in votes:
        preference = ranker(vote)
        if preference is None:
            continue
        out.append(1 if (preference > 0) == (vote["pick"] == "a") else 0)
    return out


def interval(values: list[int], rng: random.Random) -> tuple[float, float] | None:
    if len(values) < 2:
        return None
    means = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(BOOTSTRAP))
    return means[int(0.025 * BOOTSTRAP)], means[int(0.975 * BOOTSTRAP) - 1]


def report(title: str, votes: list[Vote], rankers: dict[str, Ranker]) -> None:
    print(f"\n{title}: {len(votes)} choices")
    rng = random.Random(SEED)
    for name, ranker in rankers.items():
        decided = hits(votes, ranker)
        if not decided:
            print(f"  {name:<28} no choices it could decide")
            continue
        ci = interval(decided, rng)
        span = f"  95% CI {ci[0]:.2f} to {ci[1]:.2f}" if ci else ""
        print(f"  {name:<28} {statistics.fmean(decided):.2f} of {len(decided)}{span}")


def shadow(log_dir: str) -> None:
    """How the two rankings of the same leaders compare on every look, whether or not anyone was choosing."""
    taus: list[float] = []
    same_top = 0
    looks = 0
    for path in sorted(glob.glob(os.path.join(log_dir, "jev-*.jsonl"))):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                if row.get("kind") != "review" or "shadow" not in row:
                    continue
                looks += 1
                record = row["shadow"]
                if record.get("kendall_tau") is not None:
                    taus.append(record["kendall_tau"])
                if record["equation_order"] and record["look_order"] and record["equation_order"][0] == record["look_order"][0]:
                    same_top += 1
    print(f"\nShadow log: {looks} looks")
    if taus:
        print(f"  Kendall tau between the equation and the look: median {statistics.median(taus):.2f}, mean {statistics.fmean(taus):.2f}")
        print(f"  Same camera first: {same_top} of {looks}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("exports", nargs="+", help="JSON files from the Export button")
    parser.add_argument("--logs", help="the out/ directory, for the shadow record")
    args = parser.parse_args()

    votes = load_votes(args.exports)
    evaluated = [vote for vote in votes if vote.get("mode") == "evaluate"]
    if not evaluated:
        print(f"{len(votes)} choices, none made in Evaluate mode, so there is nothing to score.")
    else:
        rankers: dict[str, Ranker] = {
            "equation": equation,
            "second look": look(confident_only=False),
            "second look, confident": look(confident_only=True),
            "movement alone": movement,
            "your model, held out": held_out_person(votes),
        }
        report("All evaluation choices", evaluated, rankers)
        for stratum in ("random", "disagree"):
            report(f"Stratum {stratum}", [vote for vote in evaluated if vote.get("stratum") == stratum], rankers)
        print("\nA ranker at 0.50 is choosing no better than a coin. Read the random stratum for an overall figure; the disagree stratum is where the equation and the look differ, so it says which is right when they do.")
    if args.logs:
        shadow(args.logs)


if __name__ == "__main__":
    main()
