# Attention Mechanics: Scoring Formulation and Decision Architecture

This document records how rt511 decides which camera is worth looking at, what was decided and why, what is built, and what is still open. The equation it describes is one proposed direction for attention, not the answer, and the [whitepaper](rt511_visual_attention_whitepaper.md) gives the full specification and its literature.

Some measurements below were taken in September 2026 on the sources the project used then, a vendor 511 platform and a state highway patrol's dispatch feed, which have since been retired in favor of agencies' published feeds (see [sources.md](sources.md)). They are kept because the design decisions were made on them, and they are labeled where they appear. The status table at the end describes what runs today.

## Problem Formulation

A wall of cameras has room for only some of them, so it has to decide continuously which cameras should be large and which small. Ranking cameras by how much their pictures change fails in two opposite ways.

- **A severe incident can look like nothing.** A collision that stops traffic on a highway at 3 AM produces almost no difference between frames, so a ranking by motion alone drops that camera to the bottom.
- **Ordinary traffic can look remarkable.** Free-flowing traffic on a multi-lane freeway at the evening rush produces large differences between frames without anything unusual happening.

The first version of rt511 scored only how much each picture changed, which chose the second case and would never have shown the first. Attention is therefore treated as having three separate axes.

| Axis | Question | Drawn from |
| --- | --- | --- |
| **Anomaly** | Is this unusual for this camera at this hour? | Frame difference against the camera's own hour-of-week profile |
| **Spectacle** | Is the scene visually active? | Motion, scaled by how much traffic the road carries |
| **Consequence** | Does it matter? | Incident records, queues inferred along the road graph, and confirmed stopped traffic |

Keeping the axes separate means their weights can differ by intent. A screen left on at night can lean on spectacle, and one watched during a storm can lean on consequence, which a single blended number could not express.

---

## 1. Attention Formulation

```
anomaly(c,t)    = min( cap(n), 0.5 · diff(c,t) / baseline(c, hourOfWeek) )    cap(n) = 0.5 + 0.5 · min(1, n / 10)
spectacle(c,t)  = α · absolute + (1 − α) · relative                          α = 0 at present
amplifier(c)    = Pmin + (Pmax − Pmin) · scalePrior(c)                       Pmin = 0.5, Pmax = 1.5
look(c,t)       = second-look factor from 0.75 to 1.25, or 1 without a confident look
floor(c,t)      = incidentLevel(record, distance) · exp(−λ · age)             half-life 30 minutes
queueFloor(c,t) = floor(anchor) · 0.6 · (1 − roadDistance / 5 km) · min(1, age / waveArrival)
gateFloor(c,t)  = 0.6 for 10 minutes once stopped traffic is confirmed on the camera

attention(c,t)  = clamp( max( amplifier(c) · look(c,t) · (wa · anomaly + ws · spectacle),
                              floor, queueFloor, gateFloor ), 0, 1 )                wa = ws = 0.5
```

### Core mechanics

- **Consequence as a floor.** The `max` is the central structural choice. Consequence is not a weighted contributor but a lower bound, so a camera beside a reported closure keeps a place on the wall however still its picture is, which is exactly the case a pixel difference gets wrong.
- **Warm-up cap.** A camera with only a few frame differences has a noisy baseline, and before the cap most of a newly opened city read 1.00 in its first minutes. The cap holds a camera's movement score to the ordinary 0.5 until it has history of its own, and lets it reach 1 after ten differences, about ten minutes on screen. A still picture reads 0 from the start, because only the saturation waits.
- **Road-size amplifier.** Road size sits outside both visual axes as a single amplifier between 0.5 and 1.5 times, so a minor anomaly on a local street does not outrank the same anomaly on an interstate. It used to multiply spectacle, which the weighted sum then halved, so its real range was 0.5 to 1.0 without any constant saying so. Moving it out states the range and keeps spectacle readable as a measure of movement alone.
- **Separate floors.** The stopped-traffic floor comes from a picture and the incident floor from an agency's record. They are kept apart so that the decision log can say which one put a camera on the wall.
- **Decay.** Without decay, a stale incident record would hold a camera on the wall indefinitely, and one dispatch feed used earlier contained a record that had been open for 171 days.

---

## 2. Input Parameter Maturation

Every input sits behind a named function, so it can improve in place without the equation changing.

### Hour-of-week baseline by empirical Bayes shrinkage

Each camera keeps 168 cells, one for each hour of the week, blended with its rolling median according to how many observations each cell holds.

$$
\mu = \frac{N}{N + K}\bar{x} + \frac{K}{N + K}\mu_{\text{roll}}, \qquad K = 5
$$

- At $N = 0$ the estimate is exactly the rolling median, so the first run behaves like the older scorer and the system is usable at once without weeks of calibration.
- As observations accumulate in a given hour of the week, the cell's own mean takes over, so a rush hour that happens every weekday reads as normal while the same movement at an unusual hour stands out.

A rolling median alone would track rush hour as it builds and correctly call it normal, but it would also measure a 3 AM event against the empty minutes just before it. The profile separates busy from unusual.

### Road-size prior

Ranking cameras against each other needs an absolute sense of road size, or a rural lane at twice its usual level outranks an interstate at one and a half times its usual level. The prior is resolved in order of preference.

1. **Published counts.** Where an agency publishes annual average daily traffic under terms that allow its use, $\log_{10}(1 + \text{AADT})$ is mapped onto 0 to 1 between 1,000 and 200,000 vehicles a day. Iowa is the only such source in the current pool, joined to mainline segments on each camera's own route.
2. **Capacity proxy.** Otherwise, the lanes carried in the camera's direction times the posted speed, mapped logarithmically.
3. **Road class.** Otherwise, a table running from 1.0 for a motorway to 0.15 for a service road.

On Phoenix's all-freeway network, a vendor-platform region, the capacity proxy raised the prior from 3 distinct values to 9, and on 548 Florida cameras it tracked published counts at a Spearman correlation of 0.48, so published counts remain preferred wherever they exist.

### Spectacle's absolute term

The absolute term is currently off ($\alpha = 0$). A frame difference is a normalized ratio over a thumbnail, not a count of anything, so there is no absolute measure of traffic volume until a calibrated detector exists. The amplifier carries the road-size information in the meantime, and the term is wired and waiting.

---

## 3. The Zero-Motion Ambiguity and Exception Gating

Frame difference does not rise steadily with traffic.

| Scene | Frame difference |
| --- | --- |
| Empty road at 3 AM | Low |
| Traffic flowing freely | High |
| Traffic stopped completely | Low |

A jam and an empty road are indistinguishable to this signal, and the jam is the case that matters. No weighting can fix this, so the system uses a gate.

```
                 frame difference ΔI ≤ 0.004
                              │
                              ▼
          hour-of-week cell expects traffic (mean ≥ 0.008, N ≥ 5)
                              │
                              ▼
                  camera flagged AMBIGUOUS_ZERO
                              │
          ┌───────────────────┴────────────────────┐
          ▼                                        ▼
  optional detector counts vehicles        Jev asks two Nouls, from numbers and text
  in the flagged frame (evidence only)       stopped traffic?   frozen feed?
          └───────────────────┬────────────────────┘
                              ▼
          frozen feed confident (≥ 0.8)  →  nothing is applied, and the standstill answer is set aside
          stopped traffic confident (≥ 0.8)  →  floor of 0.6 for 10 minutes, carried upstream as a queue
          neither confident  →  recorded, no change
```

1. **Stopped traffic or an empty road.** A confident standstill answer puts a floor of 0.6 under the camera for 10 minutes, the same level a road-relevant incident record receives, since a confirmed standstill is an incident nobody has reported yet. The floor is then carried upstream like any other.
2. **Frozen feed.** A confident frozen answer takes precedence and sets the standstill answer aside, because a picture that is not arriving says nothing about the road.
3. **Vehicle detector.** When the optional detector is running, the flagged frame is posted to it, and its vehicle count is added to the state that Jev reads. The count decides nothing by itself, so what it adds can be calibrated against the logged answers first. Every count is written to `out/detector-<date>.jsonl` whether or not Jev is configured, and a missing count is described as "not counted", never as zero.

The cell's own mean is used for the test rather than the blended baseline, so that the flag never fires about a camera nothing is yet known about, and the cell must hold at least 5 frames. An earlier build without that guard fired on 34% of polls three minutes into a run.

The ambiguity has a second reading that is not built. A road that should carry traffic and carries none may mean something is blocking it upstream, a corridor-level inference that the graph could make and a single camera cannot. At present that case is recorded and acts on nothing.

Over 2,831 daytime polls in Miami, a vendor-platform region, the gate fired zero times. That says the gate is quiet, not that it is correct, since the sample contains no night hours and no jams.

---

## 4. Episodic Reasoning (the Jev Arbiter)

Jev is a reasoning model that answers typed questions about a state. It returns a probability or a level with a confidence rather than text. It accepts text only and cannot look at a camera, so everything it decides is reasoning over the numbers and records it is given. It is an arbiter, not a calculator. It never sits on the continuous path, and it is asked only about specific situations, with atomic questions whose answers are combined in code.

| Primitive | Context | Effect when confident |
| --- | --- | --- |
| Noul | Does the camera evidence support the incident report? | Lifts the incident floor by 1.2 times |
| Noul | Has the incident cleared? | Leaves a tenth of the incident floor |
| Score (0–3) | How much of the wall should the incident take? | Scales the incident floor between 0.5 and 1.5 times |
| Choice | Which camera best shows the incident or its queue? | A chosen named camera gains 1.25 times and the others keep 0.75, and a chosen upstream camera receives a queue floor |
| Noul | Is this still picture stopped traffic? | Floor of 0.6 for 10 minutes |
| Noul | Has this camera's feed frozen? | Sets the standstill answer aside |
| Score (0–3), one per camera | How much does each of a city's eight leading cameras deserve attention, compared with the others? | Scales that camera's movement term between 0.75 and 1.25 times for 10 minutes |

A Noul acts at a probability of at least 0.8, and a Score or Choice at a confidence of at least 0.5. An answer below its gate is recorded and changes nothing, so a low confidence means a camera is treated normally, never hidden.

**The second look is the one use that ranks.** While a viewer has a city open, its eight leading cameras by the fixed equation, among those with a recent picture, are described together, at most every 2 minutes and only once one of them has a new picture. The factor touches only the movement term, so it can reorder close calls but cannot bury an incident or invent one. The equation's own score is left out of the state so that the answer is a second opinion. One open city costs at most 30 calls an hour.

**Evaluating the look against the equation.** The fixed equation is the baseline and the look is the alternative under comparison. Every camera carries `axes.equation`, the equation's score with no look applied. Every look writes a shadow record to `out/jev-<date>.jsonl` with both orderings of the same leaders, the look's levels and confidences whether or not they were acted on, and the Kendall tau between the two orders. A person's choices are the reference. The Evaluate mode of "Which would you watch?" draws half its pairs uniformly and half from pairs the two rankings order differently, never from the person's own model, and reveals nothing while the person chooses. `scripts/evaluate_attention.py` scores every ranking on the same blind choices, those both the equation and the look could decide, with bootstrap intervals, overall and per stratum, and scores the person's own model by ten-fold cross-validation. A look's levels are compared only with levels from the same look, because its rubric is relative to the cameras judged together.

**Cadence.** An incident record is asked about again once 60 seconds have passed and one of its cameras has returned a new frame. The window bounds how quickly an answer can be replaced, and the frame check decides whether replacing it could say anything new, so the arbitration follows the polling budget without a separate schedule. A quiet scene costs nothing.

**Coverage limits how much there is to ask about.** Incidents come from Ohio's feed alone at present, so there is little to arbitrate outside Ohio however quickly the arbiter may run. On the vendor platform used earlier, a Miami-only server saw 53 road-relevant records statewide and could serve cameras for exactly one of them, because each city in `data/regions.json` polls only a limited number of cameras. Raising a city's limit is the lever, and it raises the request rate in proportion, which is why it is a decision rather than a default.

**The queue tail.** When an incident is reported, the nearest camera may show emergency vehicles while the more useful picture is the queue building a mile upstream. Choosing that camera needs both the corridor topology and a judgment about which candidate shows the advancing tail. The candidates come from walking the directed graph backward against the traffic for up to 3 hops and 5 km of road, and each is offered with its road distance, its hop count and how long a queue would take to reach it at 15 km/h. Both bounds are needed, since three hops alone reached 18.7 km through one interchange, farther than a queue travels within the life of the floor that raised the question.

---

## 5. Deliberate Non-Goals

- **No vision model for suppressing roadwork.** Incident feeds publish construction as its own category, so the feed is used rather than a detector.
- **No invented labels.** Agency codes are shown as published until someone supplies their meaning.
- **No age cutoff on incidents.** Relevance classification does most of that work, and an arbitrary limit would drop long-running records such as missing-person alerts.

---

## 6. Status

| Component | Status | Evidence and scope |
| --- | --- | --- |
| Thumbnail frame differencing | Live | 64 × 48 grayscale, mean absolute difference |
| Hour-of-week baseline | Live | 168 cells per camera, identical to the rolling median at $N = 0$ in 75 of 75 cells checked |
| Corridor graph | Live | 29 published cities in 7 states, scored route and direction matching |
| Queue floor carried upstream | Live | Directed walk, 15 km/h, 5 km, in `server/src/corridor.ts` and `server/src/attention.ts` |
| Incident feed | Live for Ohio (OHGO) | Dated by first sighting, because OHGO publishes no report time |
| Published traffic counts | Live for Iowa (CC BY) | Mainline segments on the camera's own route, capacity and road class elsewhere |
| Zero-motion gate | Live | 0 triggers in 2,831 daytime polls, not yet observed at night or in a jam |
| Jev arbitration | Live when a key is set | Text only, over Ohio incidents, still cameras and the second look, in `server/src/jev.ts` |
| Vehicle detector | Optional | Evidence to Jev, in `server/src/detector.ts` and `src/rt511/detect.py`, not yet measured at night or in a jam |
| Neighbor promotion | Live | 2 hops, at most 30 cameras, in `server/src/corridor.ts` |
| National radar and top-30 board | Live | `server/src/radar.ts`, `server/src/board.ts` |
| Wall ranked by attention | Live | `web/src/hooks/useWallRanking.ts` |
| Decision logging | Live | `out/attention-<date>.jsonl` |
| Comparison model | Live | Bradley–Terry over 8 features in the browser, in `web/src/preference.ts` |

## Open Questions

- The weights $w_a$ and $w_s$, which need the decision log and real events to be calibrated against.
- Whether the weights should shift with the time of day and the density of incidents, which is cheap, or with the weather, which needs another feed.
- Incident feeds for the six covered states other than Ohio.
- Whether the equation, the second look or either matches a person's attention, which the Evaluate mode exists to collect evidence on.
