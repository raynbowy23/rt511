# Attention

How rt511 decides which camera is worth looking at. This is the design record: what was decided, why, what is built, and what is still open.

The measurements quoted below were taken in September 2026 on the sources the project used then, a vendor 511 platform and a state highway patrol's dispatch feed, which have since been retired in favour of agencies' published feeds (see `docs/sources.md`). They are kept because they are what the design decisions were made on. Where they describe what runs today, the Status table at the end is current.

## The problem

A wall of hundreds of cameras has to answer one question continuously: which of these should be large, and which should be small? That sounds like a ranking problem with one number. It is not, and treating it as one is the mistake the first version made.

Attention here is genuinely multi-objective, and the objectives conflict:

- A crash at 3am on an empty rural road **matters enormously and looks like nothing**.
- A downtown junction at rush hour **looks wonderful and is completely unremarkable**.

Optimise for one and you lose the other. The original version scored only "how much did this picture change", which silently chose the second and would never have shown you the crash.

## Three axes

| Axis | Question | Drawn from |
| --- | --- | --- |
| **Anomaly** | Is this unusual for *this camera, at this hour*? | frame difference against a per-camera hour-of-week profile |
| **Consequence** | Does it matter? | dispatch feed: incident code, closure, distance, age |
| **Spectacle** | Is it visually alive? | motion, scaled by how big the road is |

These map onto why a person looks at a screen at all. Anomaly is a scent marker, a deviation that says something unscripted is happening. Consequence is threat evaluation, the pull toward hazard and disruption. Spectacle is kinetic interest, the thing that makes a busy interchange hypnotic and keeps a wall worth leaving on.

Keeping them separate means the weights can differ by intent. An ambient screen at night leans on Spectacle. Watching a storm front leans on Consequence. One blended number cannot express that.

## The equation

```
anomaly(c,t)   = min( cap(n), ½ · diff(c,t) / baseline(c, hourOfWeek) )   cap(n) = ½ + ½ · min(1, n / 10), n = the camera's own frame differences
spectacle(c,t) = α · absolute + (1−α) · relative
amplifier(c)   = Pmin + (Pmax − Pmin) · scalePrior(c)      Pmin = 0.5, Pmax = 1.5
floor(c,t)     = incidentFloor(code, distance) × exp(−λ · age)
queueFloor(c,t) = floor(anchor) × 0.6 × (1 − roadDistance / 5 km) × min(1, age / waveArrival)   for cameras upstream of a record's cameras
gateFloor(c,t) = τ_gridlock when the arbiter has called this camera stopped traffic

attention(c,t) = clamp( max( amplifier(c) · (wₐ·anomaly + wₛ·spectacle) , floor , queueFloor , gateFloor ), 0, 1 )
```

The cap is a warm-up. A camera with only a few frame differences has a noisy baseline, and without it most of a freshly opened city read 1.00 for its first minutes. It holds a camera's movement score to the ordinary 0.5 until it has history of its own and lets it reach 1 at ten differences. A still picture still reads 0 from the start, because only the saturation waits.

The `max` is the important structural choice. Consequence is not a weighted contributor, it is a **floor**. A reported crash with a closure guarantees its cameras a place regardless of how still the picture is, because that is exactly the case a pixel-difference score gets wrong.

The scale prior sits outside both visual axes as a single amplifier. It used to multiply spectacle, which the weighted sum then halved, so its real range was 0.5 to 1.0 and no constant said so. Moving it out states the range, keeps it from entering the score twice, and leaves spectacle as a measure of movement that can be read on its own in the log.

The second floor comes from a picture rather than from a dispatcher. It is kept separate for that reason, so the log can tell which of the two put a camera on the wall.

The floor decays exponentially. Without decay a stale dispatch record pins the board forever, and the feed genuinely contains a roadblock that has been open for 171 days.

## Inputs, and how each one matures

Every input sits behind a named function so it can improve in place without the equation changing.

**Baseline, by shrinkage.** A 168-cell profile per camera, one for each hour of the week, blended with the rolling median by effective sample size:

```
μ = (N/(N+K))·cellMean + (K/(N+K))·rollingMedian        K = 5
```

At `N = 0` this returns the rolling median exactly, so the first run behaves identically to the old scorer and cannot regress. Cells fill as frames arrive and the profile takes over gradually, with no cutover and no waiting. This is what lets the system learn while operating rather than needing a week of history before it is useful.

Why hour-of-week rather than a flat baseline: rush hour should not read as anomalous. A rolling median over the last 24 minutes tracks rush hour as it builds and correctly calls it normal, but it also means a 3am event is measured against 3am nothingness and screams. The profile separates "busy" from "unusual".

**Scale prior.** Ranking cameras against each other needs an absolute sense of road size, or a rural lane at twice its norm outranks an interstate at 1.5 times its norm. Florida publishes annual average daily traffic as open data, so those cameras use `log10(1 + AADT)`, mapped onto 0..1 between 1,000 and 200,000 vehicles a day. Everywhere else uses lanes times posted speed from OpenStreetMap where lanes are tagged, and a road-class table where they are not. On Phoenix's all-freeway network that took the prior from 3 distinct values to 9, and it tracks Florida's published counts at a Spearman correlation of 0.48 over 548 cameras, so real counts stay preferred wherever they exist.

**Spectacle's absolute term is currently off (`α = 0`).** Frame difference is a normalised ratio over a thumbnail, not a count of anything, so there is no absolute measure of traffic volume until a detector exists. The amplifier carries the scale information meanwhile. The term is wired and waiting.

## The structural problem: zero-motion ambiguity

Frame difference is **not monotonic in traffic volume**:

| Scene | Frame difference |
| --- | --- |
| Empty road at 3am | low |
| Traffic flowing freely | high |
| Traffic stopped dead | low |

A jam and an empty road are indistinguishable to this signal, and the jam is precisely what you want. No weighting fixes this; it is not a tuning problem.

The resolution is a gate rather than continuous detection. When difference is near zero **and the baseline for this hour expects activity**, the state is ambiguous and worth a closer look:

```
motion ≈ 0 and baseline expects traffic
   ├── vehicles present, not moving  → standstill
   └── no vehicles at all            → starvation
```

Both are interesting, and the second is the one people forget. A road that should have traffic and does not means something is blocking it **upstream**. That is a corridor-level inference the camera graph can make and a single camera cannot, and it propagates faster than a queue does.

Measured on 250 Tallahassee cameras at night, the median difference is 0.022 and only 3% fall below 0.008, so the ambiguous band is narrow. Across a full national board the gate would fire about 1.2 times a second, roughly 0.4% of an RTX 3080. Ungated detection on every frame would be 7.2%, also affordable. **So the gate is not bought for compute, it is bought for interpretability**: you know exactly why the detector ran.

The gate now routes the flagged camera to the arbiter rather than only counting it. Two Nouls ask whether the stillness is stopped traffic and whether the feed has frozen, and a confident standstill puts a floor of 0.6 under the camera for ten minutes. A confident frozen answer suppresses the standstill answer with it, because a picture that is not arriving is not evidence about the road. Anything below the gate is still recorded and still acts on nothing.

The detector gives the arbiter the one piece of evidence that looks at the road. When the gate fires, the frame it fired on is posted to `uv run rt511 detect`, a YOLO26 process on localhost, and the vehicle count goes into the gate state the arbiter reads, with the standstill rubric told to weigh it (rubric version 4). The count decides nothing by itself. Jev still sets the floor, so what the detector adds can be calibrated against the logged answers before anything depends on it directly. Every count is written to `out/detector-<date>.jsonl` whether or not an arbiter is running. The arbiter waits one pass for a count that is on its way, and is asked without one when the detector is not running, cannot be reached, or cannot read the frame, in which case the state says "not counted" rather than anything that reads as an empty road.

The counting continues underneath, because it is what the detector will be sized against. Over 2,831 Miami daytime polls the gate fired zero times, which says it is quiet rather than that it is correct: that sample holds no night hours and no jams.

## Where Jev sits

Jev is TypeSafe's System One model: typed questions against a state, returning calibrated distributions and confidence rather than text. It accepts **text only**, so it cannot look at a camera. Everything it decides is reasoning over numbers and records we hand it, which makes the quality of the axes above the ceiling on its usefulness.

It is an **arbiter, not a calculator**. It must not sit in the continuous path, which runs for every camera on every frame. It is asked rarely, about specific situations, using atomic questions combined in code:

| Primitive | Question |
| --- | --- |
| Noul | Does the camera evidence support the reported location? |
| Noul | Has this likely cleared? |
| Score | How much should this take over the screen, on a 0–3 rubric |
| Choice | Which neighbouring camera best shows the queue tail |
| Noul | Is this still camera stopped traffic rather than an empty road |
| Noul | Has this camera's feed frozen |

There are 84 incidents live across all fourteen states at a typical moment, so this is a handful of calls a minute at most, not hundreds. Confidence gates action: a low-confidence verdict means "show it normally", never "hide it".

**Coverage is the binding constraint, not cadence.** Dispatch records are matched against every camera the source publishes, which for Florida is 4,956. Each city in `data/regions.json` carries a `limit`, and Miami's is 80 out of the 183 fl511 cameras inside its own bounding box. The result is that a Miami-only server sees 53 road-relevant records statewide and can serve cameras for exactly one of them, so there is almost nothing to arbitrate however fast the arbiter is allowed to run. Raising a region's `limit` and rebuilding its catalog is the lever, and it costs request rate in direct proportion, which is why it is a decision rather than a default.

**Cadence.** A record is re-read once 60 seconds have passed *and* one of its cameras has returned a new frame. The window bounds how fast an answer can be replaced, the frame check decides whether replacing it could say anything new, and together they make the arbitration follow the polling tier for free: about once a minute on cameras someone is watching, about once every five on idle ones. A quiet scene costs nothing at all, which is what the `held_on_evidence` counter measures.

The queue-tail case is the clearest illustration of why a graph plus a model beats either alone. Dispatch reports a crash at a mile marker. The nearest camera shows stopped emergency vehicles. The interesting picture is the shockwave a mile upstream, and choosing that camera needs both the corridor topology and a judgment about which candidate is showing the advancing tail.

The candidate set comes from walking the directed graph backwards against the traffic, up to three hops and five kilometres of road, and each candidate is offered with its road distance, its hop count, and how long a tail would take to reach it at 15 km/h. Both bounds are needed. Three hops alone reaches 18.7 km through a Miami interchange, which is further than a queue gets inside the life of the floor that raised the question.

## Deliberate non-goals

- **No vision model for suppressing roadworks.** The dispatch feed already publishes construction as its own code. Join against the feed rather than reaching for a detector.
- **No invented labels.** Agency codes display as themselves until someone supplies the meaning.
- **No age cutoff on incidents.** Relevance classification does most of that work; an arbitrary time limit would drop Silver Alerts, which are arguably the most interesting thing on a wall.

## Status

| Piece | State |
| --- | --- |
| Frame difference, brightness | live |
| Camera graph, corridor topology | live, 12 cities across 8 states |
| Incident feed | live for Ohio (OHGO), dated by first sighting because OHGO publishes no report time |
| Published traffic counts for the scale prior | live for Iowa (CC BY) and Kentucky (CC0), mainline segments on the camera's own route only; capacity and road class elsewhere |
| Three-axis scorer, shrinkage baseline, floor with decay | live in `server/src/attention.ts` |
| `AMBIGUOUS_ZERO` flag | live, measured and arbitrated |
| Decision logging | live, `out/attention-<date>.jsonl` |
| Detector resolving the gate | live as evidence to Jev, `server/src/detector.ts` and `src/rt511/detect.py`; not yet measured at night or in a jam |
| Jev arbitration | live over still cameras, and over incidents once a feed exists, `server/src/jev.ts` |
| Corridor queue-tail candidates | live, directed walk in `server/src/app.ts` |
| Queue floor carried upstream along the graph | live, `server/src/corridor.ts` and `server/src/attention.ts` |
| National radar and top-30 board | live, `server/src/radar.ts`, `server/src/board.ts`, `web/src/components/Board.tsx` |
| Neighbour promotion over the graph | live, `server/src/corridor.ts` |
| Wall ranked by attention | live, `web/src/hooks/useWallRanking.ts` |
| Scores pane, by city and by camera, with Jev reviews folded underneath | live, `web/src/components/ScoresPane.tsx` |
| Incident cameras held awake while the pane is open | live, capped at 24 |

## Open questions

- The weights `wₐ` and `wₛ`, which need the decision log and real events to calibrate against.
- Whether weights should shift by time of day and incident density, which is cheap, or by weather, which needs another feed.
- Dispatch feeds for the other thirteen states.
