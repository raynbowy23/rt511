# rt511: Prioritizing Traffic Camera Feeds with Multi-Objective Visual Attention

*Technical whitepaper. System architecture, theoretical grounding and operational specification.*
*September 2026*

## Executive Summary

A video wall in a traffic operations setting has room for only a few of the feeds available to it. Choosing feeds by pixel motion alone fails, because the amount of motion in a picture does not rise with its operational importance. A blockage across several lanes can leave a picture completely still, while free-flowing rush-hour traffic changes from one frame to the next as much as any picture can.

rt511 treats this as an information foraging problem and scores each camera on three axes, **anomaly**, **spectacle** and **consequence**. The scoring equation is one proposed direction for where attention should go, a set of assumptions made explicit so that they can be examined and compared with others. It is not presented as the answer. The architecture separates continuous scoring from episodic reasoning.

1. **Continuous fast path.** Incoming frames are reduced to small grayscale thumbnails and differenced. Each camera keeps an empirical Bayes baseline for every hour of the week, and priority floors are raised by incident records and by queues carried upstream along the road network.
2. **Episodic reasoning tier (the Jev arbiter).** A typed reasoning model is consulted only for cases the arithmetic cannot settle. It resolves still pictures into stopped traffic, an empty road or a frozen feed, chooses the camera that best shows an incident or its queue, and takes a periodic second look at the leading cameras of the city a viewer has open.

Consequence enters as a floor rather than as an additive weight, so a camera beside a reported incident keeps a place on the wall however still its picture is. A display allocator assigns tile sizes by rank, with hysteresis to prevent needless swapping. To make the scorer open to inspection, a Bradley–Terry preference model in the browser learns from a person's choices between pairs of cameras, expressed in the scorer's own feature space, and an evaluation mode sets the fixed equation, the second look and the person's choices side by side.

> **Scope.** This document describes the running system. Every constant quoted is read from the implementation, and the figures are generated from the same constants. Measured quantities say what they were measured on. Several were taken on the vendor-platform regions the project used before 23 September 2026, when it moved to agencies' own published feeds, and they are labeled as such. This is a whitepaper and not a study, and it makes no claim that the system directs attention better than any alternative.

---

## 1. Theoretical Grounding

Each element of the design has a counterpart in an established account from behavioral science, statistics or traffic flow theory. The correspondence makes each choice open to inspection. None of these accounts is tested here.

```
+-----------------------------------------------------------------------------+
|                         Information foraging theory                         |
|   viewer = forager      camera = information patch      score = scent       |
+--------------------------------------+--------------------------------------+
                                       |
              +------------------------+------------------------+
              |                                                 |
              v                                                 v
+-------------------------------------+   +-------------------------------------+
|       Behavioral and cognitive      |   |     Traffic flow and statistics     |
|  Surprise as attention              |   |  Kinematic waves                    |
|    (Itti and Baldi, 2009)           |   |    (Lighthill and Whitham, 1955;    |
|  Bottom-up visual salience          |   |     Richards, 1956)                 |
|    (Itti et al., 1998)              |   |  Fundamental diagram                |
|  Lexicographic decision rules       |   |    (Greenshields et al., 1935)      |
|    (Fishburn, 1974)                 |   |  Exposure                           |
|  Marginal value theorem             |   |    (AASHTO, 2010)                   |
|    (Charnov, 1976)                  |   |  Empirical Bayes shrinkage          |
|  Spreading activation               |   |    (Efron and Morris, 1973)         |
|    (Collins and Loftus, 1975)       |   |  Incident duration                  |
|  Reject option                      |   |    (Nam and Mannering, 2000)        |
|    (Chow, 1970)                     |   |                                     |
|  Comparative judgment               |   |                                     |
|    (Thurstone, 1927;                |   |                                     |
|     Bradley and Terry, 1952)        |   |                                     |
+-------------------------------------+   +-------------------------------------+
```

- **Information foraging.** Monitoring a wall of cameras is treated as choosing among patches from cues available before any is consumed (Pirolli and Card, 1999). Each camera is a patch and the attention score plays the part of information scent. The cities view ranks a city by its five strongest cameras, an estimate of patch quality that a single outlier cannot dominate.
- **Leaving a patch.** The marginal value theorem holds that a forager should leave a patch once its rate of return falls below the average available elsewhere, net of the cost of moving (Charnov, 1976). Tile hysteresis is a simple form of that switching cost, since a tile is surrendered only to a clearly better replacement.
- **Anomaly as surprise.** The anomaly axis measures how far a camera departs from what it usually does at that hour of the week, following the account of attention drawn by surprise (Itti and Baldi, 2009). The implementation is a ratio of observed to expected frame difference, which keeps the direction of that account without its divergence between probability distributions.
- **Spectacle as salience.** Spectacle stands for the pull of a busy scene whether or not it is unusual. Computational models of visual attention treat low-level features such as motion as salient before relevance is judged (Itti et al., 1998). rt511 uses a single such feature, temporal change.
- **Road size as exposure.** Annual average daily traffic is what traffic-safety analysis treats as exposure, the quantity against which event frequencies are normalized (AASHTO, 2010). rt511 applies it only as a multiplicative weight on attention.
- **Learning a baseline while operating.** The hour-of-week baseline is an empirical Bayes estimator, in which each cell's mean is shrunk toward a pooled estimate in proportion to how little data the cell holds (Efron and Morris, 1973). The pooled value is the camera's own rolling median.
- **Consequence as a constraint.** The incident floor turns consequence into a lower bound instead of a weight, a lexicographic rule in which one criterion is satisfied before others are traded off (Fishburn, 1974). A stopped freeway and an empty one look identical to a pixel difference, so no weighting of visual evidence could protect the stopped one.
- **Why stillness is ambiguous.** Under the fundamental diagram, flow is zero both on an empty road and at jam density (Greenshields et al., 1935). Frame difference behaves like a flow measure and inherits the same two zeros, which is why the zero-motion gate exists.
- **How a queue travels.** Behind a blockage, a change in density travels upstream as a kinematic wave (Lighthill and Whitham, 1955; Richards, 1956). The queue floor is therefore carried only upstream, and only as far as the wave could have traveled since the report.
- **How an event spreads over the graph.** Passing a floor from one camera to its neighbors is a form of spreading activation, in which activation passes to connected nodes and weakens with distance (Collins and Loftus, 1975). rt511 constrains that spread with the direction of travel and with road distance.
- **Record age.** The exponential decay of the incident floor assumes that an incident clears at a constant rate whatever its age. Hazard-based studies of incident duration find that assumption too simple (Nam and Mannering, 2000), so the half-life is a convenience.
- **Acting only when confident.** The reasoning tier acts on an answer only when its confidence clears a threshold, and otherwise leaves the deterministic score in place. This is the reject option in classification (Chow, 1970), with the deterministic floor as the fallback.
- **A person's attention from comparisons.** Choices between two cameras are turned into a scale by the law of comparative judgment (Thurstone, 1927) in the logistic form of the Bradley–Terry model (Bradley and Terry, 1952), parameterized over the scorer's features. The next pair is chosen where the model is least certain, the uncertainty sampling strategy of active learning (Lewis and Gale, 1994).

---

## 2. Ingestion and Pre-Scoring Pipeline

The ingestion layer keeps a strict budget with every agency while preparing pictures for scoring.

- **Camera pool.** 7,394 cameras are indexed from five agency feeds covering seven states, California, Iowa, Ohio, Oregon, Maine, New Hampshire and Vermont, and 29 metropolitan regions are built into road graphs. Only agencies whose written terms allow a third-party viewer to show their cameras are read.
- **Frame normalization.** Each picture is reduced to a 64 × 48 grayscale thumbnail for differencing. Pictures are held in memory only and never written to disk. Live video never passes through the server, because the browser plays an agency's open HLS stream directly while that camera is open.
- **Conditional scheduling.** A response whose `Last-Modified` falls within the camera's refresh period is timed to be followed 4 seconds after the next picture is due. A stale `Last-Modified`, a missing one or a `304 Not Modified` reply waits one full period, and a camera returning a placeholder waits 5 minutes. Every request is conditional, so an unchanged picture costs a reply with no body.
- **Agency budget.** Each server asks each agency for at most one on-screen picture every 5 seconds and one off-screen picture every 10 seconds, and no off-screen camera more often than every 10 minutes. Only the camera open in the panel is outside the budget and keeps its agency's own rate. A browser tab that nobody can see asks for nothing.

Measured on the same Des Moines wall with one viewer, the budget and the scheduling rule together reduced requests to Iowa DOT from about 2.4 a second to about 0.4, and received data from about 1.7 GB an hour to about 290 MB.

![Polling](figures/01-polling.svg)

---

## 3. Continuous Fast-Path Scoring Engine

Each camera $c$ receives an attention score between 0 and 1.

$$
\text{Attn}(c,t) = \operatorname{clamp}\Big(
\max\big(P(c) \cdot R(c,t) \cdot (w_a A(c,t) + w_s S(c,t)),\; F_{\text{incident}}(c,t),\; F_{\text{queue}}(c,t),\; F_{\text{gate}}(c,t)\big),\,
0,\, 1\Big)
$$

Here $P$ is the road-size amplifier, $R$ is the second-look factor of Section 4.2, which is 1 for any camera without a confident look, $A$ is anomaly, $S$ is spectacle, and the three $F$ terms are floors. The weights are $w_a = w_s = 0.5$.

```
 frame difference ΔI ──► hour-of-week baseline μ ──► anomaly A ──┐
                                                    spectacle S ──┤  w_a = w_s = 0.5
 road size (AADT, lanes x speed, road class) ──► amplifier P ─────┤
 second look (Jev, optional) ─────────────────► factor R ────────┴──► movement term ─┐
 incident record (level, distance, age) ─────────────────────────► F_incident ──────┤
 queue carried upstream at 15 km/h ──────────────────────────────► F_queue ─────────┼──► max, clamp ──► Attn
 confirmed stopped traffic ──────────────────────────────────────► F_gate ──────────┘
```

![Attention](figures/06-attention.svg)

### 3.1 Temporal anomaly and empirical Bayes shrinkage

The change between two thumbnails is their mean absolute difference.

$$
\Delta I_t = \frac{1}{WH} \sum_{x,y} \lvert I_t(x,y) - I_{t-1}(x,y) \rvert
$$

A camera that has returned only one frame has no difference and is scored as unknown rather than as still. A response carrying the same bytes as the previous one is recorded as unchanged and is never folded into a baseline.

Each camera keeps 168 cells, one for each hour of the week. A cell's estimate blends its observed mean $\bar{x}$, supported by $N$ observations, with the camera's rolling median $\mu_{\text{roll}}$ over its last 24 changed frames.

$$
\mu = \frac{N}{N + K}\bar{x} + \frac{K}{N + K}\mu_{\text{roll}}, \qquad K = 5
$$

At $N = 0$ the estimate is the rolling median exactly, so the system needs no calibration period. Anomaly is the frame difference against this baseline, scaled so that a camera doing exactly what it usually does scores 0.5, and capped while the camera's own history is short.

$$
A(c,t) = \min\Big(\tfrac{1}{2} + \tfrac{1}{2}\min\big(1, \tfrac{n}{10}\big),\; \tfrac{1}{2}\,\frac{\Delta I_t}{\mu}\Big)
$$

Here $n$ is the number of frame differences the camera holds. The cap starts at 0.5 and reaches 1 at ten differences, about ten minutes on screen, so a new camera does not look remarkable simply because little is known about it. A still picture reads 0 from the start. Spectacle equals the relative term at present, because the weight $\alpha$ of an absolute term is held at zero until a calibrated measure of vehicle volume exists.

![Frame difference](figures/02-difference.svg)

![Baseline](figures/03-baseline.svg)

### 3.2 Road-size amplifier

Where an agency publishes traffic counts under terms that allow their use, road size comes from annual average daily traffic, mapped logarithmically between 1,000 and 200,000 vehicles a day.

$$
P_{\text{scale}} = \operatorname{clamp}\left( \frac{\log_{10}(1 + \text{AADT}) - \log_{10}(1 + 10^3)}{\log_{10}(1 + 2 \times 10^5) - \log_{10}(1 + 10^3)},\; 0,\; 1 \right)
$$

Where no count is available, the lanes carried in the camera's direction times the posted speed are used, mapped between one lane at 40 km/h and four lanes at 110 km/h, and where lanes are not tagged, a road-class table running from 1.0 for a motorway to 0.15 for a service road. The prior multiplies the combined visual score once.

$$
P(c) = P_{\min} + (P_{\max} - P_{\min}) \cdot P_{\text{scale}}, \qquad P_{\min} = 0.5,\; P_{\max} = 1.5
$$

### 3.3 Consequence floors

Consequence sets lower bounds under the score rather than adding to it.

1. **Incident floor.** An incident record is worth 0.9 when it implies the road is closed, 0.6 when it concerns the road without closing it, and nothing when it is not about traffic. A camera within 250 m of the reported location takes the full level, which falls linearly to a quarter of it at the 1.5 km linking radius, beyond which no camera is linked. The floor decays with a half-life of 30 minutes.
   $$F_{\text{incident}} = F_0 \cdot \exp(-\lambda \Delta t), \qquad \lambda = \frac{\ln 2}{1800\text{ s}}$$
   Ohio's incident feed publishes no report time, so a record is dated by when the server first saw it.
2. **Queue floor.** Every camera upstream of a camera with an incident floor, on the same carriageway and within the walk's bounds, receives a smaller floor of its own.
   $$F_{\text{queue}} = F_{\text{anchor}} \cdot s \cdot \Big(1 - \frac{\Delta M}{M_{\max}}\Big) \cdot \min\Big(1, \frac{\Delta t}{\tau}\Big), \qquad \tau = \frac{\Delta M}{v_{\text{wave}}}$$
   Here $s = 0.6$, $M_{\max} = 5{,}000$ m, $\Delta M$ is road distance upstream and $v_{\text{wave}} = 15$ km/h. The last term ramps the floor in as a queue could plausibly have reached the camera. A stopped-traffic verdict from the gate is carried upstream in the same way.
3. **Stopped-traffic floor.** When the reasoning tier confirms stopped traffic on a still picture, the camera receives a floor of 0.6, held for 10 minutes.

![Incident floor](figures/05-floor.svg)

---

## 4. Episodic Reasoning via the Jev Arbiter

The fast path cannot tell stopped traffic from an empty road, cannot read an incident record, and cannot judge cameras against one another. For these cases the system consults Jev, a reasoning model that answers typed questions. A **Noul** returns the probability that a yes-or-no answer is yes. A **Score** returns a level on an ordinal rubric with a confidence. A **Choice** returns one option from an explicit set with a confidence. Several questions travel in one call and are answered independently.

```
      zero-motion flag              incident record             open city
   (ΔI ≤ 0.004, cell mean       (road-relevant, with a       (8 leading cameras,
    ≥ 0.008, N ≥ 5)              camera that has a picture)   recent pictures)
            │                            │                           │
            ▼                            ▼                           ▼
   Noul  stopped traffic?        Noul   supported?            Score × 8
   Noul  frozen feed?            Noul   cleared?              relative attention
                                 Score  prominence 0–3
                                 Choice best camera
            │                            │                           │
            └────────────────────────────┼───────────────────────────┘
                                         ▼
                    gate  (Noul ≥ 0.8, Score and Choice confidence ≥ 0.5)
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼ passes                                  ▼ fails
     bounded adjustment, never lowers a floor       deterministic score unchanged
```

Every answer is gated, so an unconfident answer changes nothing and a low confidence means a camera is treated normally, never hidden. Answers are model output about public data and are treated as data, never as instructions. Calls are limited to 20 a minute and 2 in flight across all uses, each with an 8-second timeout, and any failure leaves the deterministic score in place. A rubric version is recorded on every logged answer, so answers to different wordings are never mixed.

### 4.1 Exception questions

- **Zero-motion arbitration.** The gate flags a camera when $\Delta I \le 0.004$ while its hour-of-week cell expects traffic, with a cell mean of at least 0.008 over at least 5 frames. The cell mean is used rather than the blended baseline, so that the flag never fires about a camera nothing is yet known about. Two Nouls ask whether the stillness is stopped traffic and whether the feed has frozen. A confident frozen answer takes precedence and suppresses the standstill answer, and a standstill probability of at least 0.8 applies the 0.6 floor. At most 3 cameras are asked about per pass and no camera more than once in 5 minutes. When the optional vehicle detector is running, its count for the flagged frame is added to the state as evidence. The detector sees the frame, and Jev sees only the count.
- **Incident arbitration.** For a road-relevant record, two Nouls ask whether the camera evidence supports the report and whether it has cleared, a Score places the record on a four-level prominence rubric, and a Choice picks the camera that shows it best. A confident clearance leaves a tenth of the floor, since the record is still open. A confident prominence level scales the floor between 0.5 and 1.5 times. A confident support lifts it by 1.2 times. A confidently chosen named camera gains 1.25 times while the record's other cameras keep 0.75 of theirs. The Choice may also pick an upstream camera, found by walking the directed graph against the traffic for up to 3 hops and 5,000 m, and that camera then receives a queue floor without demoting the named cameras. A record is not asked about until at least one of its cameras has returned a frame difference, and it is asked again only after 60 seconds and once one of its cameras has a new picture.

![Gate arbitration](figures/08-gate-arbiter.svg)

![Incident arbitration](figures/07-arbiter.svg)

### 4.2 The second look at the top of a city

While a viewer has a city open, its eight leading cameras by the fixed equation, among those with a recent picture, are described together in one state. One Score per camera asks how much that camera deserves the attention of a person watching the city, compared with the others listed. The equation's own score is left out of the state, so the answer is a second opinion rather than an echo. A confident level $n$, normalized to the unit interval, sets the factor on the camera's movement term.

$$
R = 1 + 0.25\,(2n - 1), \qquad 0.75 \le R \le 1.25
$$

$R$ touches only the movement term, so it can reorder cameras the equation scores close together but cannot lift a still picture over a busy one or lower a floor. A factor is held for 10 minutes. A city is looked at again no sooner than every 2 minutes and only once one of its leaders has returned a new picture, which bounds one open city at 30 calls an hour.

### 4.3 Why a typed model, and what it cannot do

The arbiter was chosen for the shape of its answers rather than for any measured quality of its judgment. Every answer is a number that can be compared with a threshold, bounded and logged without parsing text, and the recombination of answers stays in the code with weights that can be read. The model's documentation defines a Noul as the probability that the answer is yes and a confidence as a number from 0 to 1 to be thresholded, and it advises raising a threshold where acting on a false yes is costly (TypeSafe, 2026). It does not claim that these numbers are calibrated, and their calibration has not been checked on this task.

The model accepts text only and cannot look at a camera. It knows that a picture changed three times as much as usual for the hour, not what the picture shows. It is proprietary and paid for, cannot run locally, and is addressed by its latest version, so its answers can change without any change here. No other model has been compared with it. An open model run locally, with its output constrained by grammar-constrained decoding (Geng et al., 2023) and its token probabilities read as confidence, would cost nothing to run and could include a vision model, although the probabilities of language models have been found to be poorly calibrated without further adjustment (Jiang et al., 2021).

---

## 5. Topological Corridor Graph

```
 [ upstream site A ] ──── directed edge (length, free-flow time, road classes) ────► [ downstream site B ]
         │                                                                                    │
   snapped to an OSM way                                                           snapped to an OSM way
```

Cameras are joined into a directed graph built from OpenStreetMap road geometry.

- **Sites.** Cameras within 40 m of each other on the same carriageway form one site. A camera with no published direction at a divided highway is represented by a pair of sites, one per carriageway.
- **Scored snapping.** Candidate road segments within 80 m are scored rather than the nearest one taken. A route number shared with the camera's name is the strongest signal. A published direction is compared with the segment's bearing by a graded penalty, and only a disagreement greater than 135 degrees is treated as a reversal, because posted route directions are not compass bearings. A camera named as an intersection is kept off the mainline. A camera with no road within 80 m is left unplaced, remains watchable, and is only absent from the graph.
- **Edges.** An edge runs in the direction of travel when the shortest path between two sites passes no other site. Edges are typed as freeway, ramp, street or nearby, and a nearby edge joins sites that watch the same place with no way to drive between them.
- **Neighbor promotion.** A camera triggers promotion when it carries an incident floor, when stopped traffic has been confirmed on it, or when its movement reaches 1.8 times its usual level for the hour once its cell holds 5 frames. Every camera within 2 hops is then fetched with the cameras on screen for the next 5 minutes and shares their budget, upstream neighbors first, then downstream, then the opposite carriageway. At most 30 cameras are promoted at once, ordered by hop count first. A queue floor does not trigger promotion, because letting an inferred floor trigger would cascade along the corridor.

![Corridor](figures/09-corridor.svg)

---

## 6. Display Allocation, Logging and Visualization

The display allocator ranks cameras by attention and assigns tile sizes by rank position, with four ranks of hysteresis so that cameras on either side of a size boundary do not swap on noise. Each tile shows its score and the term that drove it, a line that fills until its next picture is due, whether the agency publishes live video for it, and its channel number and picture time.

A decision logger writes one line per camera in the top 30, no more often than every 10 seconds, with every component of the score kept separate, including the incident floor before and after arbitration, the second-look factor and the equation's own score. The arbiter writes its own log with the full state of every call, the answers, the latency and the token usage.

A low-rate radar gives a national board of the thirty highest-scoring cameras scores in cities nobody has open, by sampling ten cameras per city every ten minutes, chosen by road size and rotated hourly. The city map draws the promotions and queue floors already in the scores as pulses traveling along the road between cameras. Nothing is decided for this display.

![The wall](figures/10-wall.svg)

---

## 7. Human Attention Modeling via Bradley–Terry Preference

The equation encodes one view of what deserves attention. A comparison mode asks a person for theirs.

1. **Pair presentation.** Two cameras from the open city are shown side by side, with their pictures and names only. The person picks the one they would rather watch or skips the pair.
2. **Features.** Each camera is described by eight quantities, namely unusual movement, the scale prior, the incident floor, the queue floor, the stopped-traffic floor, a darkness term that ramps from 0 with the sun six degrees above the horizon to 1 six degrees below it, the picture's mean brightness, and whether the camera is on a freeway.
3. **Model.** The probability of choosing camera $a$ over camera $b$ follows the Bradley–Terry form, with no intercept.
   $$P(a \succ b) = \sigma\big(\mathbf{w}^\top (\mathbf{x}_a - \mathbf{x}_b)\big)$$
   The weights are fitted by full-batch gradient descent on the logistic loss with an L2 penalty of 0.02, for a fixed 400 steps from zero, which gives the same weights for the same choices.
4. **Pair selection.** The first five pairs are drawn at random. After that, thirty random pairs are drawn and the one whose predicted probability is closest to one half is shown. Cameras shown in the last six pairs are rested when the pool allows it.
5. **Ranking by the person.** After ten choices, the wall can be ranked by the person's own model through the same allocator.
6. **Evaluation protocol.** An evaluation mode draws half its pairs uniformly and half from pairs that the equation and the second look place in opposite orders by more than a near tie, and reveals no score while the person chooses. Each ranking is scored as the share of choices in which it favored the camera the person picked, on the same choices for every ranking, with bootstrap intervals, separately for the uniform and the disagreement strata. A second look's levels are compared only with levels from the same look, because its rubric is relative to the cameras judged together. The person's own model is scored by ten-fold cross-validation.

The choices stay in the person's browser and are never sent anywhere. One person's choices describe one person's attention, and no results are reported here.

---

## 8. Settings and Measurements

### 8.1 Design settings

| Element | Setting |
| --- | --- |
| Sources | 5 agency feeds, 7 states, 7,394 cameras indexed, 29 built regions |
| Thumbnails | 64 × 48 pixels, grayscale |
| Poll timing | 4 s after the next expected picture when Last-Modified is within a period, otherwise one full period |
| Request budget per agency | 1 on-screen picture per 5 s, 1 off-screen picture per 10 s |
| Baseline | 168 hour-of-week cells, rolling window of 24 changed frames, $K = 5$ |
| Warm-up cap | 0.5 with no history, 1 at 10 differences |
| Axis weights | $w_a = w_s = 0.5$, $\alpha = 0$ |
| Road-size amplifier | 0.5 to 1.5 |
| Zero-motion gate | $\epsilon = 0.004$, $\tau = 0.008$, at least 5 frames in the cell |
| Incident floor | 0.9 closure, 0.6 road-relevant, half-life 30 minutes, radius 1.5 km |
| Queue floor | share 0.6, upstream walk 3 hops and 5,000 m, stopping wave 15 km/h |
| Stopped-traffic floor | 0.6, held 10 minutes |
| Arbiter gates | Noul 0.8, Score and Choice confidence 0.5 |
| Arbiter limits | 20 calls per minute, 2 in flight, 3 gate calls per pass, 8 s timeout |
| Second look | 8 cameras, at most every 2 minutes on a new picture, factor 0.75 to 1.25, held 10 minutes |
| Neighbor promotion | 2 hops, at most 30 cameras, held 5 minutes |
| Display | top 30, four ranks of hysteresis |
| Comparison model | Bradley–Terry over 8 features, L2 0.02, 400 steps, random for 5 choices then least certain of 30 pairs |

### 8.2 Measured values

| Quantity | Measured value | Context |
| --- | --- | --- |
| Cold-start agreement with the rolling median | 75 of 75 cells at $N = 0$ identical | Live run, vendor-platform regions |
| Warm cells diverging from the rolling median | 227 of 250 | Same run |
| Zero-motion gate triggers | 0 of 2,831 polls | Miami, daytime, vendor platform |
| Upstream reachability within the walk bounds | 378 of 386 sites (97.9%), namely 74 of 77, 258 of 262 and 46 of 47 | Miami, Tallahassee, Madison, vendor platform |
| Median distance to the nearest upstream site | 1,106 m, 462 m and 1,611 m | Same regions |
| Distinct scale-prior values on an all-freeway network | 3 by road class, 9 with lanes and speed | Phoenix, vendor platform |
| Capacity proxy against published counts | Spearman 0.48, $n = 548$ | Florida, vendor platform |
| Cameras moving rank when the wall switched from activity to attention | 41 of 57, 12 by four ranks or more | Live region, vendor platform |
| Incident arbitration call | 2,645 input and 210 output tokens, 408 ms | One live record |
| Second look against the equation | Kendall tau 0.29, 0.00, −0.14 and 0.07 over four looks, never the same camera first, 226 to 482 ms and about 3,800 input tokens a look | Des Moines, 28 September 2026 |
| Requests and data, one viewer on a city wall | 2.4 to 0.4 requests a second, 1.7 GB to 290 MB an hour | Des Moines, 28 September 2026 |
| National radar | 0.47 requests a second with 318 sampled cameras | 32 regions, none open |
| Attention-spreading display | 60 frames a second with 30 flows drawn | Des Moines map, 2D canvas |

A trigger rate of zero over 2,831 daytime polls says that the gate is quiet, not that it is correct, and the sample contains no night hours and no jams. Four looks show that the second look and the equation order cameras differently, not which of them is closer to a person's attention.

---

## 9. Open Items

- **Absolute vehicle volume.** The spectacle axis is wired for an absolute term and carries none. Whether the optional detector's counts can serve as that term across weather and camera optics has not been checked.
- **Zero motion at night and in congestion.** The gate has not been observed at night or under congestion, which is where it is supposed to matter.
- **Stopping-wave speed.** The 15 km/h speed sits at the slow end of the empirically reported range for congestion propagating against traffic (Treiber et al., 2010) and has not been measured on these corridors.
- **Scale prior.** The capacity proxy tracks published counts only moderately, and only Iowa's counts are usable in the current pool.
- **Incident coverage.** Incidents are available for one state of seven.
- **Rubric calibration.** None of the arbiter's rubrics has been calibrated against labeled outcomes, which is what the decision log and the rubric version exist to make possible.
- **Human attention.** Whether the equation, the second look or either matches any person's attention, and whether different people agree with each other, is untested.

---

## References

AASHTO (2010). *Highway Safety Manual*, 1st ed. American Association of State Highway and Transportation Officials, Washington, DC.

Bradley, R. A., & Terry, M. E. (1952). Rank analysis of incomplete block designs. I. The method of paired comparisons. *Biometrika*, 39(3/4), 324–345.

Charnov, E. L. (1976). Optimal foraging, the marginal value theorem. *Theoretical Population Biology*, 9(2), 129–136. https://doi.org/10.1016/0040-5809(76)90040-X

Chow, C. K. (1970). On optimum recognition error and reject tradeoff. *IEEE Transactions on Information Theory*, 16(1), 41–46. https://doi.org/10.1109/TIT.1970.1054406

Collins, A. M., & Loftus, E. F. (1975). A spreading-activation theory of semantic processing. *Psychological Review*, 82(6), 407–428. https://doi.org/10.1037/0033-295X.82.6.407

Efron, B., & Morris, C. (1973). Stein's estimation rule and its competitors, an empirical Bayes approach. *Journal of the American Statistical Association*, 68(341), 117–130. https://doi.org/10.2307/2284155

Fishburn, P. C. (1974). Lexicographic orders, utilities and decision rules: A survey. *Management Science*, 20(11), 1442–1471. https://doi.org/10.1287/mnsc.20.11.1442

Geng, S., Josifoski, M., Peyrard, M., & West, R. (2023). Grammar-constrained decoding for structured NLP tasks without finetuning. In *Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing* (pp. 10932–10952). https://doi.org/10.18653/v1/2023.emnlp-main.674

Greenshields, B. D., Bibbins, J. R., Channing, W. S., & Miller, H. H. (1935). A study of traffic capacity. *Highway Research Board Proceedings*, 14, 448–477.

Itti, L., & Baldi, P. (2009). Bayesian surprise attracts human attention. *Vision Research*, 49(10), 1295–1306. https://doi.org/10.1016/j.visres.2008.09.007

Itti, L., Koch, C., & Niebur, E. (1998). A model of saliency-based visual attention for rapid scene analysis. *IEEE Transactions on Pattern Analysis and Machine Intelligence*, 20(11), 1254–1259. https://doi.org/10.1109/34.730558

Jiang, Z., Araki, J., Ding, H., & Neubig, G. (2021). How can we know when language models know? On the calibration of language models for question answering. *Transactions of the Association for Computational Linguistics*, 9, 962–977. https://doi.org/10.1162/tacl_a_00407

Lewis, D. D., & Gale, W. A. (1994). A sequential algorithm for training text classifiers. In *SIGIR '94, Proceedings of the Seventeenth Annual International ACM-SIGIR Conference on Research and Development in Information Retrieval* (pp. 3–12). Springer London. https://doi.org/10.1007/978-1-4471-2099-5_1

Lighthill, M. J., & Whitham, G. B. (1955). On kinematic waves II. A theory of traffic flow on long crowded roads. *Proceedings of the Royal Society of London. Series A*, 229(1178), 317–345. https://doi.org/10.1098/rspa.1955.0089

Nam, D., & Mannering, F. (2000). An exploratory hazard-based analysis of highway incident duration. *Transportation Research Part A*, 34(2), 85–102. https://doi.org/10.1016/S0965-8564(98)00065-2

Pirolli, P., & Card, S. (1999). Information foraging. *Psychological Review*, 106(4), 643–675. https://doi.org/10.1037/0033-295X.106.4.643

Richards, P. I. (1956). Shock waves on the highway. *Operations Research*, 4(1), 42–51. https://doi.org/10.1287/opre.4.1.42

Thurstone, L. L. (1927). A law of comparative judgment. *Psychological Review*, 34(4), 273–286.

Treiber, M., Kesting, A., & Helbing, D. (2010). Three-phase traffic theory and two-phase models with a fundamental diagram in the light of empirical stylized facts. *Transportation Research Part B*, 44(8–9), 983–1000. https://doi.org/10.1016/j.trb.2010.03.004

TypeSafe (2026). Confidence, and the Noul primitive. TypeSafe documentation. https://docs.typesafe.ai/confidence and https://docs.typesafe.ai/primitives/noul (accessed 28 September 2026)

## Source and Figures

This revision was prepared from the running implementation. The figures in `docs/figures` are generated by `scripts/figures.mjs`, which reads its constants from the built server, so regenerating them after a tuning change with `make figures` keeps them accurate. The original architecture diagram is preserved as [rt511_attention_pipeline.drawio](rt511_attention_pipeline.drawio).
