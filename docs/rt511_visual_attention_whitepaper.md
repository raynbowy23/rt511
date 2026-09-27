# rt511: Prioritizing Traffic Camera Feeds with Multi-Objective Visual Attention

*Technical whitepaper, architecture and implementation*

## Executive summary

A traffic camera display has limited space. Deciding which feeds belong on it requires more than identifying the images with the most movement. The rt511 pipeline brings together three considerations: whether a scene is unusual, whether it is visually engaging, and whether an incident makes it operationally important. It calls these dimensions **anomaly**, **spectacle**, and **consequence**.

The architecture separates continuous scoring from episodic reasoning. A fast path processes camera thumbnails, maintains activity baselines, and combines visual scores with an incident-based priority floor. A separate reasoning layer, the Jev Arbiter, handles ambiguous low-motion states, upstream queue-tail selection, and judgments about display prominence.

The central design choice is to treat incident priority as a floor rather than another weighted visual signal. A feed can therefore retain priority because of a reported incident even when its visual score is low. The display allocator then selects feeds from the resulting ranking, with hysteresis to limit unnecessary turnover.

> **Scope.** An earlier draft of this document described a pipeline diagram and its notes. This revision describes the running system. Every constant quoted below is read from the implementation, and the figures are generated from the same constants rather than drawn by hand, so a value in a figure and a value in the code cannot drift apart. Measured quantities are marked as measured and say what they were measured on. Everything else is a design setting, not a benchmark result.

## 1. Background and theoretical grounding

The components of rt511 are engineering choices, and each has an established account behind it in the research literature. This section names that account for each component and says where the implementation follows it and where it only approximates it. None of these theories is tested here. The claim is a correspondence that makes each design choice open to inspection, and Section 7 lists what has and has not been measured.

**Allocating a limited display.** The overall problem is the one information foraging theory describes (Pirolli and Card, 1999). A viewer, or a wall acting for one, has more sources than it can attend to and must choose among them from cues available before consuming any. In that account the sources are patches and the cues are information scent. In rt511 each camera is a patch and each city a cluster of patches. The attention score plays the part of scent. The Cities view ranks a city by its five strongest cameras, a patch-quality estimate that a single outlier cannot dominate.

**Keeping a tile.** Foraging theory also predicts when to leave a patch. The marginal value theorem holds that a forager should leave once a patch's rate of return falls below the average available elsewhere, net of the cost of moving (Charnov, 1976). The four-rank hysteresis is a crude form of that switching cost. A tile is surrendered only to a clearly better replacement, because every swap costs the viewer a reorientation.

**Anomaly as surprise.** The anomaly axis measures how far a camera departs from what it usually does at this hour of the week. This follows the account of attention as drawn by surprise, the departure of incoming data from an observer's expectation (Itti and Baldi, 2009). The implementation is a ratio of observed to expected frame difference. It keeps the direction of that account without the divergence between belief distributions that gives it a probabilistic form.

**Spectacle as bottom-up salience.** Spectacle stands for the pull of a busy scene whether or not it is unusual. Computational models of visual attention treat low-level features such as motion and contrast as salient before any judgement of relevance is made (Itti et al., 1998). rt511 uses a single such feature, temporal change, where those models combine many.

**Road size as exposure.** The scale prior uses annual average daily traffic, which traffic-safety analysis treats as exposure, the quantity against which event frequencies are normalised (AASHTO, 2010). A road carrying more vehicles offers more opportunity for events that matter. rt511 applies exposure only as a multiplicative weight on attention, which simplifies the role it plays in a rate model.

**Learning a baseline while operating.** The hour-of-week baseline is an empirical Bayes estimator. Each cell's mean is shrunk toward a pooled estimate in proportion to how little data the cell holds, the approach whose properties were established through the James-Stein estimator (Efron and Morris, 1973). Here the pooled value is the camera's own rolling median and the pseudo-count K is 5.

**Consequence as a constraint.** The incident floor turns consequence into a lower bound instead of a weight, so a high-consequence cue takes precedence over any amount of visual evidence against it. That is a lexicographic decision rule, in which one criterion is satisfied before the others are traded off (Fishburn, 1974). Its practical motive is that a stopped freeway and an empty one look identical to a pixel difference, so no weighting of visual evidence could protect the stopped one.

**Why stillness is ambiguous.** The fundamental diagram of traffic flow relates flow to density, and flow is zero both on an empty road and at jam density (Greenshields et al., 1935). Frame difference behaves like a flow measure, since it registers vehicles moving through the view, and so it inherits the same two zeros. The zero-motion gate exists because the ambiguity is structural and no choice of weights removes it.

**How a queue travels.** The queue floor follows kinematic wave theory, in which a change in density travels along a road as a wave whose speed follows from the fundamental diagram (Lighthill and Whitham, 1955), developed independently by Richards (1956). Behind a blockage that wave moves upstream, against the traffic. The floor is therefore carried only upstream, and only as far as the wave could have travelled since the report. The speed used, 15 km/h, sits at the slow end of the empirically reported range, as Section 4.2 notes.

**How an event spreads over the graph.** Carrying a floor from one camera to its neighbours is a form of spreading activation, in which activation at one node of a network passes to connected nodes and weakens with distance (Collins and Loftus, 1975). rt511 constrains that spread with traffic physics. It follows the direction of travel on each carriageway and weakens with road distance, and a camera is admitted only once the wave could have reached it.

**Record age and clearance.** The exponential decay of the incident floor amounts to assuming that an incident clears at a constant rate whatever its age. Hazard-based studies of incident duration generally find that assumption too simple, with the chance of clearance changing over the life of an incident (Nam and Mannering, 2000). The half-life is therefore a convenience, and a duration model fitted to dispatch records would be the principled replacement.

**Acting only when confident.** Jev's gates act on an answer only when its confidence clears a threshold, and otherwise leave the deterministic score in place. This is the reject option in classification, in which a classifier abstains below a confidence level and hands the decision to a fallback (Chow, 1970). The fallback here is the deterministic floor, so abstaining never removes a feed from the wall.

## 2. Architecture and inputs

The pipeline has two processing paths with different responsibilities.

The **continuous fast path** maintains the attention ranking. It receives camera imagery and incident information, evaluates changes in the imagery against a baseline, and sends attention scores to the display matrix allocator.

The **episodic reasoning layer** addresses questions that the continuous calculations do not resolve on their own. It receives ambiguous zero-motion states and corridor queries, and can return a confidence-gated adjustment to the scoring floor. Separating these responsibilities keeps the frame-level calculations distinct from the reasoning tasks.

The camera pool covers 18 metropolitan areas across 17 states served by a shared vendor platform, and supplies 64 × 48 thumbnails for visual processing. A dispatch feed provides agency codes, closure information, and coordinates. A scale prior, based on AADT or road class, provides an additional input to the scorer.

The two main input branches remain distinct until scoring. Incident information feeds the floor evaluator. Camera imagery passes through inter-frame differencing, baseline profiling, and the zero-motion gate. This arrangement lets the scorer consider visual activity without making incident priority depend entirely on what is moving in the image.

Acquisition is scheduled off the response rather than off a clock. The vendor hosts regenerate a snapshot when one is requested, so a request that arrives early is answered with the copy already cached, and a fixed 60-second cycle collects roughly half the frames it appears to. Each camera's next request is therefore timed from the `Last-Modified` its last response carried, plus the camera's period, plus a 4-second margin.

![Polling](figures/01-polling.svg)

## 3. Continuous fast-path scoring

### 3.1 Establishing an incident priority floor

The incident floor evaluator assigns a minimum priority contribution that decays over time:

$$
F = F_0 \cdot \exp(-\lambda \Delta t)
$$

Here, $F_0$ is the initial floor, $\lambda$ controls the rate of decay, and $\Delta t$ is the elapsed time since the record was reported.

The implementation writes the same decay as a half-life, which is the form the constant is stated in. $F_0$ is the product of a code level and a distance taper. A code implying the road is blocked is worth 0.9, a code about the road but not necessarily blocking it is worth 0.6, and a code that is ordinary police business is worth nothing at whatever distance. The taper is 1 within 250 m of the reported location, falls linearly to 0.25 at the 1.5 km linking radius, and no camera beyond that radius is linked to the record at all. The half-life is 30 minutes.

The floor carries incident-related consequence into the attention score independently of the visual components. Its role is not to make an image appear more active, but to preserve an incident's importance when the visual evidence alone would produce a lower score.

A record with no readable report time receives no floor. Dispatch feeds list records for as long as a dispatcher leaves them open, and a floor with nothing to decay against would hold a camera at the top of the wall indefinitely. One Florida record in the observed sample had been open for 171 days.

![Incident floor](figures/05-floor.svg)

### 3.2 Measuring inter-frame change

The visual branch begins with the mean absolute difference between consecutive frames:

$$
\Delta I_t = \frac{1}{WH} \sum |I_t - I_{t-1}|
$$

In this expression, $I_t$ and $I_{t-1}$ are consecutive images, and $W$ and $H$ are their width and height. The calculation summarizes how much the image has changed between the two frames.

This is a change signal, not an incident classification. The pipeline passes it to the baseline profiler so that the current observation can be considered alongside the activity represented in the baseline.

Two cases are deliberately not differences of zero. A camera that has returned only one frame has no difference at all, and is scored as unknown rather than as still. A response carrying bytes identical to the previous one is recorded as unchanged and is never folded into a baseline, because the rolling median it would be blended with is taken over changed frames alone.

![Frame difference](figures/02-difference.svg)

### 3.3 Building the activity baseline

The 168-hour shrinkage profiler blends an observed mean with a rolling baseline:

$$
\mu = \frac{N}{N+K}\bar{x} + \frac{K}{N+K}\mu_{\text{roll}}
$$

The expression combines the observed mean $\bar{x}$ for this camera's hour-of-week cell, supported by $N$ observations, with the rolling median $\mu_{\text{roll}}$ of its last 24 changed frames. The parameter $K$ controls how strongly the estimate relies on the rolling term, and is set to 5.

The weights make the intended behavior explicit. When $N = 0$, the estimate is entirely the rolling term. As observations accumulate, the observed mean receives more weight. This provides a gradual transition away from the fallback rather than an abrupt switch after a fixed number of samples, and it removes any requirement for a calibration period before the system can be used.

Each cell also keeps a running variance alongside its mean, which the decision log records. It does not enter the score. It is kept so that a calibrated threshold or a standardised deviation can replace the ratio once the log shows how the spread within a cell behaves.

The cold-start identity has been checked rather than assumed. Across 75 cells standing at $N = 0$ in a live run, the blended baseline produced a score identical to the older activity measure in every case, with no mismatches. In the same run, 227 of 250 warm cells had already diverged from it, which is the profile beginning to carry information the rolling median does not.

![Baseline](figures/03-baseline.svg)

### 3.4 Checking ambiguous zero-motion states

The zero-motion gate checks whether the current image change is small despite a sufficiently high baseline:

$$
\Delta I \le \epsilon
\quad \text{and} \quad
\mu_{\text{cell}} \ge \tau
$$

The threshold $\epsilon$ defines the low-change condition and is set at 0.004, the noise floor the poller already uses to decide a camera has woken up. The activity level $\tau$ is set at twice that, 0.008.

Two details of the test matter. The comparison is against the cell's own mean rather than against the blended baseline, because the claim the flag makes is that this hour expects traffic, and a blend that is mostly the rolling median would let the flag fire about a camera nothing is yet known about. And the cell must hold at least 5 frames before it is allowed to expect anything. An earlier build without that guard fired on 34% of polls three minutes into a run, which measured how new the profile was rather than anything about the road.

The pipeline labels this combination an **ambiguous zero state**. The state is genuinely ambiguous in three ways rather than two. Traffic may have stopped, the road may be empty, or the feed may have frozen, and a mean absolute pixel difference is identical in all three. Section 4.1 describes how the state is resolved. Observations on the normal branch proceed to the attention scorer.

![Zero-motion gate](figures/04-gate.svg)

### 3.5 Supplying a scale prior

The scorer also receives a scale prior, $P_{\text{scale}}$, which expresses how much traffic a camera's road carries before anything moves in front of it. Where a state publishes count data the prior is derived from it, and everywhere else it falls back to the class of road the camera was snapped to.

The published counts are mapped logarithmically and then onto the unit interval:

$$
P_{\text{scale}} = \operatorname{clamp}\left( \frac{\log_{10}(1 + \text{AADT}) - \log_{10}(1 + 10^3)}{\log_{10}(1 + 2 \times 10^5) - \log_{10}(1 + 10^3)},\, 0,\, 1 \right)
$$

A logarithm rather than a linear map because the counts span three orders of magnitude and the difference between 1,000 and 10,000 vehicles a day matters far more than the difference between 190,000 and 200,000. The two endpoints are chosen so that both ends of the scale are reachable. A thousand vehicles a day is a street nobody would watch, 200,000 is an urban interstate, and the five published files joined so far run from 650 to 253,000.

Where no count is available but OpenStreetMap tags the road's lanes, the prior comes from a capacity proxy. The lanes carried in the camera's direction are multiplied by the posted speed and mapped logarithmically between a one-lane street at 40 km/h and a four-lane freeway direction at 110 km/h. A two-way road's tagged lanes are halved, and an untagged speed takes the class default. Where lanes are not tagged, the prior falls back to a road-class table running from 1.0 for a motorway down to 0.15 for a service road, with a ramp scored at 0.7 of the road it serves and an unplaced camera scored at 0.3. A lane count is never invented, so the order of preference is published counts, then the capacity proxy, then road class.

**How the prior enters the score.** This was the largest gap in the earlier draft, which defined the prior and left its injection point unstated. The prior is applied as a single amplifier on the weighted sum of both visual axes:

$$
P = P_{\min} + (P_{\max} - P_{\min}) \cdot P_{\text{scale}}, \qquad P_{\min} = 0.5,\; P_{\max} = 1.5
$$

Three properties of this choice are deliberate. The amplifier multiplies the combined visual score rather than one axis, so the two axes remain separately readable in the log. Its lower bound is well above zero, so a residential street where something is plainly happening is damped rather than silenced. And it appears exactly once, which the previous arrangement did not guarantee. The prior used to multiply the spectacle axis, which the weighted sum then applied at half weight, so its real effect was an amplifier over 0.5 to 1.0 that no constant in the code stated.

Before the capacity proxy, the class fallback barely discriminated on an all-freeway network. In Phoenix, 76 of 80 cameras carried a prior of exactly 1.0 and the region resolved to three distinct values. With lanes and speeds the same cameras take nine distinct values, and 42 of 80 still reach the proxy's ceiling. The proxy tracks published volume only moderately. On 548 Florida cameras with both a count and tagged lanes, the Spearman rank correlation between the two priors is 0.48, so published counts remain the preferred source wherever a state releases them.

### 3.6 Combining anomaly, spectacle, and consequence

The three-axis attention scorer uses the following rule:

$$
\text{Attn} = \operatorname{clamp}\Big(
\max\big(P \cdot (w_a A + w_s S),\; F_{\text{incident}},\; F_{\text{queue}},\; F_{\text{gate}}\big),\,
0,\, 1
\Big)
$$

The anomaly component $A$ and spectacle component $S$ form a weighted visual score, with $w_a = w_s = 0.5$. Anomaly is the frame difference divided by the baseline, scaled so that a camera doing exactly what it usually does at this hour scores 0.5 and twice the baseline saturates. Spectacle is the movement term alone, currently equal to the relative term because the absolute weight $\alpha$ is held at zero. There is no absolute measure of how many vehicles are in a frame in this system, only a mean pixel difference, which varies with resolution, lens, weather and time of day and is not comparable between cameras. The term is wired so that a real volume measure can be weighed in by changing one constant.

The scorer compares the amplified visual sum with three floors and retains the largest of the four. The final clamp bounds the result between 0 and 1.

Although the architecture describes three axes, their mathematical roles are not symmetric. Anomaly and spectacle are added together and then amplified, while consequence establishes a lower bound. This distinction allows incident information to preserve a feed's priority without requiring a high visual score.

The three floors are kept apart rather than merged. The incident floor comes from a dispatcher, the queue floor from the road network carrying that dispatcher's record upstream, and the gate floor from a picture. A log that cannot tell them apart cannot be used to calibrate any of them.

The floor is a scoring constraint, not a reserved display position. Selection still occurs downstream in the display allocator.

![Attention](figures/06-attention.svg)

## 4. Episodic reasoning with the Jev Arbiter

Jev is a **TypeSafe System One Engine** performing text-only Bayesian reasoning over graph and state information. Its role is separate from the image-differencing calculation, and its responsibilities are divided among three typed primitives: Noul, Choice, and Score.

Two properties hold across every call. The arbiter modulates and never replaces, so the deterministic floor is computed first and stands on its own, and an answer moves it only within bounds the code sets. And every answer is gated, so an unconfident answer changes nothing at all. Low confidence means behave normally, never hide the feed.

Answers are model output about public data. They are treated as data, never as instructions, and so is everything in the state sent to the model, including the dispatcher's free-text remarks.

### 4.1 Noul: resolving an ambiguous zero state

This is the second gap the earlier draft identified, and it is now specified end to end.

**What the arbiter receives.** A flagged camera is described by its road and view, the summary phrase for what its picture is doing, its frame difference, the usual difference for this hour, the ratio between them, how many frames the hour-of-week cell holds, how long ago the newest frame arrived, the time of day in words, and whether a dispatch record already names it. Alongside it comes the corridor, as up to four neighbouring cameras with their side, road distance, and hop count. The corridor is the evidence that separates the answers. Stillness at a camera while the approach is also slowing is a queue, and the same stillness with the approach running normally is not.

**What is asked.** Two Nouls rather than one, because the state is three-way. The first asks whether the stillness is stopped traffic rather than an empty road. The second asks whether the feed has stopped updating. They are not mutually exclusive and are not asked to be. Ranking them against each other is recombination, and recombination belongs in code with weights that can be read, not inside a single question.

**What is done with the answers.** A Noul carries no confidence of its own, so its own probability is the gate, set at 0.8. A confident frozen answer takes precedence and suppresses the standstill answer with it, because a picture that is not arriving is not evidence about the road. Otherwise a confident standstill answer applies a floor override:

$$
F_{\text{gate}} = \tau_{\text{gridlock}} = 0.6
$$

This is the same level a road-relevant dispatch code receives, because that is what a confirmed standstill is, an incident nobody has reported yet. The floor is held for 10 minutes and then expires, so a standstill that has drained becomes an ordinary camera again. Anything below the threshold is recorded in the axes and the log and changes no score.

**What it costs.** At most 3 cameras are asked about per ranking pass, and no camera is asked about more than once in 5 minutes. The concurrency cap of 2 in-flight calls usually binds first within a single pass. These limits exist so that a region-wide feed fault becomes a handful of calls rather than one per camera. The re-ask window is deliberately shorter than the 10-minute hold, so that a standstill which is still standing can renew the floor it earned before that floor expires.

![Gate arbitration](figures/08-gate-arbiter.svg)

### 4.2 Choice: selecting an upstream queue tail

The Choice primitive handles queue-tail selection. This was the third gap, which named the task without specifying its candidate set.

**The candidate set** is the directed upstream neighbourhood of the cameras a record names. Starting from each named camera's site, the walk follows corridor edges backwards, against the direction of travel, for up to 3 hops and up to 5,000 m of accumulated road distance. Both bounds are needed. Hop count alone reaches 18.7 km through a ramp-dense interchange on the Miami graph, and a queue standing that far back would have taken more than an hour to arrive, by which time the incident floor that raised the query has decayed through two half-lives. Five kilometres is about twenty minutes at the stopping-wave speed, which is the window the floor actually survives.

**What each candidate carries** is its road and view, which side of the incident it sits on, the road distance and driving time to it, the number of hops, and the time a queue tail would take to reach it:

$$
\tau_{ij} = \frac{\Delta M_{ij}}{v_{\text{wave}}}, \qquad v_{\text{wave}} = 15 \text{ km/h}
$$

The stopping wave travels backwards against the traffic, which is why the quantity is computed for upstream candidates only and is left null elsewhere. The speed is a design setting rather than a measurement in this system. Empirical studies place the speed at which congestion propagates against the traffic between 15 and 20 km/h, varying with country and traffic composition (Treiber et al., 2010). The 15 km/h used here therefore sits at the slow end of that range, which delays the arrival of an inferred queue rather than hastening it.

**The queue floor.** The graph also acts without Jev. When a record puts a floor under a camera, every camera upstream of it on the same carriageway, within the walk's bounds, receives a smaller floor of its own.

$$
F_{\text{queue}} = F_{\text{anchor}} \cdot s \cdot \Big(1 - \frac{\Delta M}{M_{\max}}\Big) \cdot \min\Big(1, \frac{\Delta t}{\tau}\Big), \qquad s = 0.6,\; M_{\max} = 5{,}000 \text{ m}
$$

Here $F_{\text{anchor}}$ is the deterministic floor the record gives the camera it names, before any Jev adjustment. $\Delta M$ is the road distance upstream, $\Delta t$ is the record's age, and $\tau$ is the stopping-wave arrival time above. The share $s$ is below one because an upstream camera is inferred rather than seen. The last term ramps the floor in as a queue could plausibly have reached the camera. It is a ramp rather than a switch because the wave speed it depends on is an uncited design setting, and a hard cutoff on it would claim a precision the setting does not have. Because $F_{\text{anchor}}$ carries the record's half-life, the queue floor rises and then decays. Cameras the record names keep their own incident floor and receive no queue floor from it, and downstream and off-corridor cameras receive nothing.

As a worked example, computed from the formula rather than measured, a fresh closure reported beside one camera gives a camera 1.7 km upstream a queue floor of about 0.30 when the tail could first reach it, about seven minutes in, falling to about 0.09 an hour later. On the dispatch feed then in use, on the night of 20 September, 18 cameras across four cities carried an incident floor and 31 upstream cameras carried a queue floor, but none above 0.03, because every record then open was more than an hour old.

**The downstream connection.** When the Choice picks a camera the record named, that camera gains 1.25 while the record's other cameras keep 0.75, and only when the choice carries at least 0.5 confidence. When it confidently picks an upstream camera the record did not name, that camera receives a queue floor equal to the record's highest floor multiplied by what the verdict would give a named and chosen camera, and the named cameras keep their floors undiminished. The choice then adds a view of the event rather than taking one away. Upstream candidates are described to Jev with their pictures, as the named cameras are. In the first 68 live reviews they were described without them and were never once chosen, which is what exposed the gap.

Measured on the live graphs, the bounded walk reaches an upstream site from 74 of 77 Miami sites, 258 of 262 Tallahassee sites, and 46 of 47 Madison sites. The median distance to the nearest upstream site is 1,106 m in Miami, 462 m in Tallahassee, and 1,611 m in Madison. At the stopping-wave speed those correspond to tail arrival times of roughly four minutes, two minutes, and six minutes.

![Corridor](figures/09-corridor.svg)

### 4.3 Score: assigning display prominence

The Score primitive applies an ordinal prominence rubric with four levels, from a record not worth showing at all up to one worth the main panel. Its purpose is to allow major closures to preempt ambient feeds.

This rubric is distinct from the continuous attention score. The attention score is bounded between 0 and 1 and participates in feed ranking. The prominence rubric expresses an ordinal judgment, which is then mapped to a multiplier on the floor rather than to a display position.

All four incident questions travel in one call, because they are evaluated independently and in parallel, so asking four costs barely more than asking one. The mapping from answers to a multiplier is:

| Answer | Gate | Effect when the gate is met |
| --- | --- | --- |
| cleared (noul) | 0.8 | multiplies the floor by 0.1 |
| screen (score, 0 to 3) | 0.5 confidence | multiplies by $1 + 0.5(2n - 1)$ for normalized level $n$ |
| supported (noul) | 0.8 | multiplies by 1.2 |
| camera (choice) | 0.5 confidence | 1.25 for the chosen camera, 0.75 for the others |

Only the cleared answer can collapse a floor, and it leaves a tenth of it rather than nothing, because the record is still open. The other answers are not one-sided. A confident screen score at the bottom of the rubric halves the floor, and the cameras Jev did not choose keep three quarters of theirs. Supported is the only answer that can only lift.

**How often a record is re-read.** A verdict is not formed once and kept. The arbiter re-reads a record whenever two conditions hold together: at least 60 seconds have passed since its last answer, and at least one of its cameras has returned a new frame since then. The second condition is what makes the first affordable. The window says how soon an answer may be replaced, and the evidence check says whether replacing it could produce anything different, so a record whose cameras have all gone quiet keeps its answer until one of them speaks again.

This makes the arbitration track the polling tier without a separate schedule. A record on cameras somebody is watching is re-read about once a minute, because that is how often those cameras produce a frame. The same record on idle cameras is re-read about once every five minutes. An edited record is exempt from the window entirely, because the fingerprint that identifies it will not match.

![Incident arbitration](figures/07-arbiter.svg)

**One measured failure, recorded because it shaped the design.** With the picture guard bypassed, eight live records were scored on the screen rubric while every camera they named read "no picture yet". All eight returned between 0.3 and 1.1 of 3 whatever their dispatch code said, including two open roadblocks. The rubric's upper levels ask for a camera showing something, so absence of evidence was read as absence of severity. The guard that now prevents this refuses to ask about a record until at least one of its cameras has returned a difference. A floor must not be lowered because of a gap in our own coverage.

## 5. The corridor graph

The earlier draft referred to graph topology without specifying the graph. This section closes that gap, and it is the part of the design that makes upstream reasoning possible at all.

### 5.1 Nodes and edges

The graph is built per region by an offline pipeline and loaded at startup. Its vertices are **sites** rather than cameras. A site is a place on the road network, and it holds the one or more cameras that look at that place. The separation matters because several cameras routinely share a location, and because a direction-less camera at a divided highway is represented by a pair of sites, one per carriageway, rather than by a single ambiguous point.

Each site carries the snapped road it sits on, including the route references and the road class, which is also what the scale-prior fallback reads.

Edges are directed and typed. A freeway, ramp, or street edge runs in the direction of travel and carries a length in metres and a free-flow travel time in seconds. An edge arriving at a site comes from where traffic approaching that site comes from, which is the definition the upstream walk depends on. A `nearby` edge is undirected and means only that two sites are close without a road between them, so it carries no side and is never walked through.

The Miami region is representative in shape, with 77 sites and 254 edges, of which 41 are freeway, 165 are ramp, 47 are street, and 1 is nearby.

### 5.2 Why topology rather than a radius

Upstream and downstream queries follow directed edges rather than a Euclidean neighbourhood, and the difference is not a refinement. Two cameras 400 m apart in a straight line may be on opposite carriageways of a divided highway, on a frontage road, or on a crossing street. None of those is a place where a queue behind a blockage will appear, and a radius cannot tell any of them from the camera half a mile back on the same pavement, which is. Road distance rather than straight-line distance is also what the shockwave arrival time must be computed from for the number to mean anything.

### 5.3 How cameras reach the graph

Cameras are placed on the network by a snapping step that scores candidate roads by route-reference tokens and by direction, with the direction penalty graded by angle. Posted route directions are not compass bearings, and treating them as such produced 13 mismatches in Buffalo alone, where Interstate 190 is signed north where the pavement runs west. Only a disagreement greater than 135 degrees is now treated as a reversal.

Cameras whose names contain an intersection marker forfeit their route references and are kept off the mainline, because a camera named for a freeway at a cross street is usually a ramp-terminal view rather than a view of the freeway. Four cameras in Tallahassee named "I-10 South" were placed on the freeway before this rule existed.

### 5.4 How an event reaches its neighbours

The graph also decides what the server looks at. A camera that is not on screen is fetched every five minutes, and less often while its picture is quiet, so an event at one camera would otherwise reach its neighbours only when their own turn came round. The trigger is direct evidence at one camera. That means an incident floor or a confirmed standstill, or movement at least 1.8 times the camera's usual level for the hour once its hour-of-week profile holds five frames. Every camera within two hops of a triggering camera is then fetched at its source's own period for the next five minutes. Upstream neighbours are taken first, because a queue grows toward them, then downstream ones, because a moving disturbance travels that way, then the opposite carriageway at an interchange. A queue floor does not trigger promotion. It is itself inferred from the graph, and letting it trigger would cascade promotions along the corridor.

At most thirty cameras are promoted at once. Candidates are ordered by hop count before anything else, so every triggering camera has its adjacent cameras promoted before any trigger's second hop. Ordered by trigger strength alone, the two strongest triggers on the dispatch feed then in use took all thirty places between them and left every other event with nothing looked at. With every place filled at one-minute sources, promotion adds 0.4 requests a second.

A confirmed standstill is also carried upstream as a queue floor, by the formula Section 4.2 gives for dispatch records, with its age measured from when Jev confirmed it. Only confirmed events propagate as score. Raw movement travels only as attention to look, because carrying it as score would let a headlight flare or a rain squall at one camera raise every camera downstream of it.

## 6. Display allocation and decision logging

The display matrix allocator ranks feeds by the attention score and cuts them into tile sizes by rank position. Four-rank hysteresis keeps small ranking changes from causing unnecessary changes to the displayed set. Without it, cameras sitting either side of a cut swap places on noise alone.

**The national board.** A board of the thirty highest-scoring cameras across the country needs scores in every city, but a city is polled only while someone has it open. A low-rate radar closes that gap. In each city nobody is watching, ten cameras are sampled once every ten minutes, chosen by road size and rotated hourly so that a quiet city is sampled across its network over a day. That is about 0.017 requests a second per city, half a request a second across thirty. When a sampled camera passes the trigger of Section 5.4, its neighbours are promoted exactly as they would be in an open city. The board leaves off any camera whose newest picture is more than twenty minutes old, two radar periods, so a score from a city that has been closed never ranks against live ones.

The allocator ranked on raw frame-difference activity until recently, which meant none of the work described above reached the display. Measured on a live region at the moment of the change, 41 of 57 scored cameras would move rank under the attention score and 12 would move by four ranks or more. The agreement at the very top was higher, 11 of the leading 12, because ten of those cameras were saturated at the top of both scales, which makes their order arbitrary in either scheme.

The architecture also includes a decision logger. The earlier draft recorded the telemetry vector as four values. The implementation writes considerably more, one line per camera in the top 30, no more often than every 10 seconds, rotated daily and capped in size:

```text
ts, id, region, rank, attention, activity, diff,
anomaly, spectacle, baseline, baseline_n,
scale_prior, scale_prior_source, scale_amplifier, aadt, highway,
incident_floor, incident_floor_base, incident, jev,
ambiguous_zero, gate
```

Keeping the components separate is what makes the log usable for calibration. `incident_floor_base` is the floor before the arbiter touched it and `incident_floor` is the floor after, so the effect of every answer can be recovered from the log alone. The arbiter writes its own log in parallel, one line per call, carrying the full state sent, the answers returned, the latency, and the token usage, with the rubrics themselves written at the top of each day's file so that an answer can always be read against the question that produced it. The rubric version is recorded on every line and is incremented by hand whenever a rubric or the state feeding it changes, because answers under different versions are not comparable.

![The wall](figures/10-wall.svg)

## 7. Settings, what has been measured, and what remains open

### 7.1 Design settings

| Element | Setting |
| --- | --- |
| Visual-processing thumbnails | 64 × 48 pixels |
| Camera-pool coverage | 18 metropolitan areas, 17 states |
| Poll scheduling margin | 4 s after the expected regeneration |
| Rolling window | 24 changed frames |
| Baseline profiler | 168 hour-of-week cells |
| Shrinkage parameter | $K = 5$ |
| Anomaly at baseline | 0.5 |
| Axis weights | $w_a = w_s = 0.5$ |
| Absolute spectacle weight | $\alpha = 0$ |
| Scale amplifier range | 0.5 to 1.5 |
| Zero-motion thresholds | $\epsilon = 0.004$, $\tau = 0.008$, at least 5 frames in the cell |
| Incident floor levels | 0.9 closure, 0.6 road-relevant, 0 otherwise |
| Incident half-life | 30 minutes |
| Incident linking radius | 1.5 km, at most 6 cameras per record |
| Gridlock floor | 0.6, held for 10 minutes |
| Incident re-read window | 60 s, and only on a new frame |
| Gate re-read window | 5 minutes |
| Noul gate | 0.8 |
| Score and Choice confidence gate | 0.5 |
| Upstream walk | 3 hops, 5,000 m |
| Upstream queue share | 0.6 of the scene's floor, falling to zero at 5,000 m |
| Capacity prior range | 1 lane at 40 km/h to 4 lanes at 110 km/h, per direction |
| Neighbour promotion | 2 hops, at most 30 cameras, held 5 minutes |
| National radar | 10 cameras per unwatched city every 10 minutes, rotated hourly |
| Board freshness | newest picture within 20 minutes |
| Stopping-wave speed | 15 km/h |
| Arbiter rate limits | 20 calls per minute, 2 in flight, 3 gate calls per pass |
| Attention-score range | 0 to 1 |
| Display selection | Top 30 feeds |
| Display hysteresis | Four ranks |

These values describe the configuration as it runs. They do not establish ranking accuracy, latency, deployment coverage, or operator benefit.

### 7.2 What has been measured

| Quantity | Measurement | Where |
| --- | --- | --- |
| Cold-start agreement with the older activity measure | 75 of 75 cells at $N = 0$ identical, 0 mismatches | live run |
| Warm cells diverging from the rolling median | 227 of 250 | same run |
| Zero-motion gate trigger rate | 0 of 2,831 polls | Miami, daytime |
| Upstream reachability within the walk bounds | 74 of 77, 258 of 262, 46 of 47 sites | Miami, Tallahassee, Madison |
| Median distance to the nearest upstream site | 1,106 m, 462 m, 1,611 m | Miami, Tallahassee, Madison |
| Scale prior distinctness on an all-freeway network | 3 distinct values and 76 of 80 at 1.0 by road class, 9 and 42 of 80 with lanes and speed | Phoenix |
| Capacity proxy against published counts | Spearman 0.48, n = 548 | Florida |
| Arbiter call cost | 2,645 input and 210 output tokens, 408 ms | one live incident record |
| Request rate after scheduling and tiering changes | 4.4 to about 1.1 requests per second | one wall viewer |
| National radar request rate | 36 requests in 120 s, 0.30 per second, with no startup burst | 18 cities, none open |

The zero-motion result is the one to read carefully. A trigger rate of zero over 2,831 daytime polls says the gate is quiet, not that it is correct, and the sample contains no night hours and no jam conditions. The gate's value is that it makes the ambiguous case explicit and cheap to count, not that it has yet caught anything.

### 7.3 What remains unspecified

Four things in the earlier draft's list are now specified: the scale prior's injection into the score, the state and threshold behind the Noul gate, the candidate set and downstream connection for the queue-tail Choice, and the construction of the corridor graph. What remains open is different in kind, and most of it needs measurement rather than design.

An absolute measure of vehicle presence does not exist in the system. The spectacle axis is wired for one and currently carries none, and a detector resolving the zero-motion state directly would also supply it. The ambiguous-zero rate has not been observed at night or under congestion, which is where the gate is supposed to matter. The stopping-wave speed comes from the slow end of a published empirical range and has not been measured on these corridors. The capacity proxy that stands in for published counts tracks them only moderately, and dispatch coverage exists for one state of the seventeen. None of the arbiter's rubrics has been calibrated against labelled outcomes, which is what the decision log exists to make possible and what the rubric version number exists to keep comparable.

## Conclusion

The rt511 architecture treats camera selection as more than a search for visual activity. It combines anomaly and spectacle, amplified by how much traffic a road carries, with two separate consequence floors, and it uses episodic reasoning to address ambiguous states and network-level questions. Its clearest design commitment is that incident importance should not disappear simply because the associated image receives a low visual score.

The components the earlier draft could only name are now defined and running, and the decision log is structured so that the judgments each one makes can be taken apart afterwards. Evidence of effectiveness still requires an evaluation this document does not contain. What it contains is a specification precise enough that such an evaluation can be designed against it.

## References

AASHTO (2010). *Highway Safety Manual*, 1st ed. American Association of State Highway and Transportation Officials, Washington, DC.

Charnov, E. L. (1976). Optimal foraging, the marginal value theorem. *Theoretical Population Biology*, 9(2), 129–136. https://doi.org/10.1016/0040-5809(76)90040-X

Chow, C. K. (1970). On optimum recognition error and reject tradeoff. *IEEE Transactions on Information Theory*, 16(1), 41–46. https://doi.org/10.1109/TIT.1970.1054406

Collins, A. M., & Loftus, E. F. (1975). A spreading-activation theory of semantic processing. *Psychological Review*, 82(6), 407–428. https://doi.org/10.1037/0033-295X.82.6.407

Efron, B., & Morris, C. (1973). Stein's estimation rule and its competitors—An empirical Bayes approach. *Journal of the American Statistical Association*, 68(341), 117–130. https://doi.org/10.2307/2284155

Fishburn, P. C. (1974). Lexicographic orders, utilities and decision rules: A survey. *Management Science*, 20(11), 1442–1471. https://doi.org/10.1287/mnsc.20.11.1442

Greenshields, B. D., Bibbins, J. R., Channing, W. S., & Miller, H. H. (1935). A study of traffic capacity. *Highway Research Board Proceedings*, 14, 448–477.

Itti, L., & Baldi, P. (2009). Bayesian surprise attracts human attention. *Vision Research*, 49(10), 1295–1306. https://doi.org/10.1016/j.visres.2008.09.007

Itti, L., Koch, C., & Niebur, E. (1998). A model of saliency-based visual attention for rapid scene analysis. *IEEE Transactions on Pattern Analysis and Machine Intelligence*, 20(11), 1254–1259. https://doi.org/10.1109/34.730558

Lighthill, M. J., & Whitham, G. B. (1955). On kinematic waves II. A theory of traffic flow on long crowded roads. *Proceedings of the Royal Society of London. Series A*, 229(1178), 317–345. https://doi.org/10.1098/rspa.1955.0089

Nam, D., & Mannering, F. (2000). An exploratory hazard-based analysis of highway incident duration. *Transportation Research Part A*, 34(2), 85–102. https://doi.org/10.1016/S0965-8564(98)00065-2

Pirolli, P., & Card, S. (1999). Information foraging. *Psychological Review*, 106(4), 643–675. https://doi.org/10.1037/0033-295X.106.4.643

Richards, P. I. (1956). Shock waves on the highway. *Operations Research*, 4(1), 42–51. https://doi.org/10.1287/opre.4.1.42

Treiber, M., Kesting, A., & Helbing, D. (2010). Three-phase traffic theory and two-phase models with a fundamental diagram in the light of empirical stylized facts. *Transportation Research Part B*, 44(8–9), 983–1000. https://doi.org/10.1016/j.trb.2010.03.004

## Source and figures

This revision was prepared from the running implementation. The figures in `docs/figures` are generated by `scripts/figures.mjs`, which reads its constants from the built server, so regenerating them after a tuning change is the way to keep them accurate. The original architecture diagram is preserved as [rt511_attention_pipeline.drawio](rt511_attention_pipeline.drawio).
