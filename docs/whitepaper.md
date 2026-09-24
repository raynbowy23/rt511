# Multi-Objective Visual Attention Allocation for Large-Scale Traffic Camera Walls

**Technical White Paper & System Specification**

## Abstract

Deploying large-scale public traffic camera streams onto automated, dynamic video walls presents a competing-objective optimization challenge[cite: 1]. Conventional approaches rely on scalar heuristics such as inter-frame luminance differences, which disproportionately elevate routine, high-volume peak-hour traffic while failing to detect critical, low-motion anomalies such as nighttime collisions or severe bottlenecks[cite: 1]. This paper presents the architecture for **rt511**, a real-time attention engine designed to rank and tile video feeds across metropolitan and national camera graphs[cite: 1]. The system formulates attention across three decoupled orthogonal axes—**Anomaly**, **Consequence**, and **Spectacle**—and introduces a non-linear floor constraint with temporal decay to handle emergency response events[cite: 1]. We address the fundamental computer vision ambiguity between free-flow starvation and dead-stop gridlock using an interpretability-first zero-motion gate, paired with a typed Bayesian arbitration interface (Jev) to resolve spatial and topological queue dynamics[cite: 1].

## 1. Introduction & Background

Public-facing 511 systems and traffic management centers oversee tens of thousands of Closed-Circuit Television (CCTV) cameras[cite: 1]. When monitoring extensive distributed networks, a fundamental question emerges: *which camera streams warrant prominent visual real estate, and which should remain minimized or deferred?*[cite: 1]

Early implementations address this with scalar ranking functions based on frame-differencing metrics[cite: 1]:

$$
\Delta I_t = \frac{1}{W \times H} \sum_{x=1}^{W} \sum_{y=1}^{H} \vert{}I_t(x,y) - I_{t-1}(x,y)\vert{}
$$

While computationally lightweight, this single-scalar approach conflates two fundamentally conflicting operational goals[cite: 1]:

1. **Ambient Visual Draw (Spectacle):** A multi-lane downtown junction during daytime peak hours features continuous, high-entropy motion[cite: 1]. It provides high visual movement but carries little individual operational consequence[cite: 1].
2. **Critical Event Detection (Consequence):** A fatal roadway departure or rollover crash occurring at 3:00 AM on a rural two-lane corridor carries critical operational urgency[cite: 1]. However, because vehicular throughput drops to zero, the resulting frame delta is indistinguishable from empty pavement[cite: 1].

A continuous linear scalar model consistently optimizes for peak-hour movement and suppresses critical, low-motion incidents[cite: 1]. To resolve this, rt511 models camera selection as a multi-objective decision system operating over temporal baselines, geometric road priors, incident dispatch records, and corridor topology graphs[cite: 1].

## 2. Methodology

### 2.1 The Three-Axis Attention Formulation

Rather than combining signals into a single scalar average, attention is split across three explicit axes[cite: 1]:

$$
\text{Attention}(c, t) = \operatorname{clamp}\Big( \max\big( w_a \cdot \text{Anomaly}(c,t) + w_s \cdot \text{Spectacle}(c,t),\; \text{Floor}(c,t) \big),\, 0,\, 1 \Big)
$$

[cite: 1]

#### Axis 1: Anomaly

Measures how atypical current visual motion is relative to that specific camera's historical profile for that specific hour of the week[cite: 1]:

$$
\text{Anomaly}(c, t) = \frac{\Delta I(c, t)}{\mu_{\text{baseline}}(c, \text{hourOfWeek})}
$$

[cite: 1]

#### Axis 2: Spectacle

Quantifies raw visual activity, balanced across roadway scales to prevent rural access roads from displacing major interstates during mild localized deviations[cite: 1]:

$$
\text{Spectacle}(c, t) = P_{\text{scale}}(c) \cdot \Big( \alpha \cdot E_{\text{abs}}(c, t) + (1 - \alpha) \cdot E_{\text{rel}}(c, t) \Big)
$$

[cite: 1]

* Where Annual Average Daily Traffic (AADT) open data is published, the scale prior is derived logarithmically: $P_{\text{scale}}(c) = \log_{10}(1 + \text{AADT}_c)$[cite: 1].
* For camera locations lacking dedicated count stations, $P_{\text{scale}}$ falls back onto an absolute roadway classification matrix parameterizing functional road class, lane count, and design speed[cite: 1].
* Prior to the deployment of real-time vehicle counters, $\alpha$ is locked to $0$, allowing $P_{\text{scale}}$ to carry the baseline structural weight[cite: 1].

#### Axis 3: Consequence (The Non-Linear Floor)

Consequence does not operate as an additive weight; it functions as a **hard lower bound**[cite: 1]. When a confirmed crash or full closure is registered by dispatch, the camera stream is guaranteed visual prioritization regardless of zero-motion pixel values[cite: 1]:

$$
\text{Floor}(c, t) = F_{\text{incident}}(\text{code}, \text{distance}) \cdot \exp(-\lambda \cdot \Delta t_{\text{age}})
$$

[cite: 1]

The exponential decay term $\exp(-\lambda \cdot \Delta t_{\text{age}})$ is mathematically necessary[cite: 1]. Without temporal decay, unclosed CAD entries or persistent construction notices (such as long-term municipal utility work) permanently lock the video wall layout[cite: 1].

---

### 2.2 Cold-Start Baselines via Empirical Bayes Shrinkage

To eliminate the requirement for a mandatory multi-week calibration warm-up period, historical profile tracking employs an empirical Bayes shrinkage estimator across a 168-cell matrix ($\text{Day of Week} \times \text{Hour of Day}$)[cite: 1]:

$$
\mu_{\text{baseline}}(c, h, d) = \left( \frac{N}{N + K} \right) \bar{x}_{\text{observed}} + \left( \frac{K}{N + K} \right) \mu_{\text{rolling}}
$$

[cite: 1]

* $N$ represents the count of valid historical observations accumulated within that specific weekly bin[cite: 1].
* $K$ is a shrinkage pseudo-weight constant (set to $K = 5$)[cite: 1].
* $\mu_{\text{rolling}}$ represents the 24-frame short-term median[cite: 1].

At system initialization ($N = 0$), the estimator returns the short-term rolling median, matching historical baselines with zero regression risk[cite: 1]. As operational hours accrue, cell-specific historical profiles smoothly assume weight without requiring pipeline interruptions or manual re-indexing[cite: 1].

### 2.3 Resolving the Zero-Motion Inversion: The Ambiguity Gate

Inter-frame difference is non-monotonic with respect to actual vehicular volume[cite: 1]:

$$
\lim_{k \to 0} \Delta I(t) \to 0 \quad (\text{Free-flow / Empty Roadway})
$$

[cite: 1]

$$
\lim_{k \to k_{\text{jam}}} \Delta I(t) \to 0 \quad (\text{Complete Gridlock Standstill})
$$

[cite: 1]

Rather than executing computationally expensive convolutional object detectors continuously across tens of thousands of streams, the pipeline introduces an interpretability gate[cite: 1]:

$$
\text{Trigger if: } \Delta I(c, t) \le \epsilon \quad \text{AND} \quad \mu_{\text{baseline}}(c, h, d) \ge \tau_{\text{active}}
$$

[cite: 1]

When this condition is met, the system logs an `AMBIGUOUS_ZERO` telemetry state, isolating two distinct traffic states[cite: 1]:

1. **Vehicular Standstill ($k \to k_{\text{jam}}$):** Queue backup requiring incident promotion[cite: 1].
2. **Corridor Starvation ($k \to 0$):** Total absence of vehicles during historically active windows, indicating an unmapped upstream blockage preventing traffic from reaching the sensor downstream[cite: 1].

### 2.4 Semantic & Topological Arbitration via Jev

#### Architectural Role

High-level contextual reasoning cannot be solved via continuous linear formulas[cite: 1]. rt5

#### Why Jev Uses Typed Primitives (Nouls, Scores, Choices)

Unlike standard generative language models that produce unstructured natural-language explanations, Jev enforces typed Bayesian evaluation primitives[cite: 1]:

1. **The Noul Primitive (Epistemic Verification):**
   * *Definition:* A binary or categorical epistemic validation construct governed by strict boundary criteria[cite: 1]. Rather than emitting chat prose, a Noul evaluates state variables and returns a discrete categorical distribution paired with an explicit confidence metric ($p \in [0.0, 1.0]$)[cite: 1].
   * *Operational Use Case:* `incident_visually_manifesting`[cite: 1].
     * **Criteria:** Evaluates whether low motion vectors and emergency dispatch timestamps correlate with actual physical disruption rather than stale reporting[cite: 1].
     * **Confidence Gating:** If confidence falls below an established operational threshold, the pipeline defaults to a conservative fallback ("display stream normally") and suppresses destructive floor overrides[cite: 1].
2. **The Score Primitive (Bounded Structural Rubrics):**
   * *Definition:* An ordinal, rubric-defined integer evaluation scale (e.g., $L \in \{0, 1, 2, 3, 4\}$) mapped to operational severity criteria[cite: 1].
   * *Operational Use Case:* Determining how aggressively an incident-adjacent camera should preempt ambient feeds on the main display matrix[cite: 1].
3. **The Choice Primitive (Directed Graph Traversal):**
   * *Definition:* A discrete selection over an explicit set of topological candidates[cite: 1].
   * *Operational Use Case:* Upstream queue-tail arbitration[cite: 1]. When an incident closes an interstate, the primary incident camera is often static[cite: 1]. Jev parses the upstream camera sequence along the corridor graph, identifies the active deceleration shockwave, and elevates the camera showing the dynamic queue tail[cite: 1].

---

## 3. System Architecture & Implementation

### 3.1 Network Tiering: Radar vs. Spotlight

To scale across national network topologies without unmetered bandwidth consumption, polling operates across two distinct operational tiers[cite: 1]:

* **Tier 1 (National Radar):** A background polling cycle querying a rotating sample of 10 anchor cameras per metro across 18 target metropolitan areas at 1 frame per 10 minutes ($\approx 0.3 \text{ req/s}$ total ingress)[cite: 1].
* **Tier 2 (Metropolitan Spotlight):** Activated when an anchor camera trips the anomaly threshold or a verified CAD incident occurs, promoting that specific corridor into high-rate polling[cite: 1].

### 3.2 Display Stabilization via Hysteresis

To prevent rapid visual oscillation (layout thrashing) along ranking tier boundaries, the display allocator enforces a four-rank hysteresis window[cite: 1]. A camera currently assigned to an active display tier must decline by at least four positional ranks before being displaced by an ascending feed[cite: 1].

### 3.3 Subsystem Execution Status

The current implementation boundaries are structured as follows[cite: 1]:

| Component / Subsystem                             | Operational Status    | Technical Notes                                                                    |
| :------------------------------------------------ | :-------------------- | :--------------------------------------------------------------------------------- |
| **Frame Differencing & Photometrics**       | Live in Production    | Normalized$64 \times 48$ thumbnail analysis running at the edge[cite: 1].        |
| **Corridor Network Graph**                  | Live in Production    | Snapped roadway topology covering 18 metropolitan areas[cite: 1].                  |
| **Dispatch Feed Processing**                | Live in Production    | Structured incident ingestion from the Ohio OHGO feed, dated by first sighting.     |
| **Scale Prior (AADT Integration)**          | Live in Production    | Logarithmic normalization over Florida DOT count station layers[cite: 1].          |
| **Three-Axis Scorer & Decay Floor**         | Active Implementation | In-process execution with configurable decay parameter$\lambda$[cite: 1].        |
| **Shrinkage Baseline Profiler**             | Active Implementation | $168\text{-cell}$ hour-of-week matrix initialized at $K = 5$[cite: 1].         |
| **Telemetry & Decision Logging**            | Active Implementation | Structured JSON logging of full attention feature vectors[cite: 1].                |
| **Zero-Motion Gating (`AMBIGUOUS_ZERO`)** | Active Implementation | Passive telemetry capture measuring live trigger frequency distributions[cite: 1]. |
| **YOLO Object Detection Engine**            | Deferred (Phase 2)    | Targeted inference resolving the zero-motion gate state[cite: 1].                  |
| **Jev Reasoning Arbiter**                   | Deferred (Phase 2)    | Stubbed behind typed interfaces pending baseline stabilization[cite: 1].           |
| **National Polling Radar**                  | Deferred (Phase 2)    | Multi-metro background polling across all target nodes[cite: 1].                   |

---

## 4. Experimental Evaluation

*(Section intentionally left blank for upcoming empirical calibration trials, detector trigger distribution metrics, and display stability validation data.)*

---

## 5. Conclusion & Future Work

By decoupling visual attention into Anomaly, Consequence, and Spectacle, rt511 resolves the systematic blind spots inherent in single-scalar video ranking engines[cite: 1]. Enforcing an decaying floor constraint guarantees that high-consequence incidents are preserved without permitting dead dispatch tickets to dominate display real estate[cite: 1]. Furthermore, pairing a low-overhead heuristic gate with a typed Bayesian reasoning layer (Jev) isolates heavy computational inference to ambiguous states and topological arbitrations[cite: 1]. Future iterations will focus on populating empirical validation benchmarks, integrating national AADT shapefiles, and resolving the zero-motion gate through automated edge detection[cite: 1].

---

## References

1. Lighthill, M. J., & Whitham, G. B. (1955). On kinematic waves II. A theory of traffic flow on long crowded roads. *Proceedings of the Royal Society of London. Series A. Mathematical and Physical Sciences*, 229(1178), 317–345.
2. Pirolli, P., & Card, S. (1999). Information foraging. *Psychological Review*, 106(4), 643–675.
3. Kerner, B. S. (2004). *The Physics of Traffic: Empirical Freeway Pattern Features, Engineering Applications, and Efficient Solutions*. Springer Science & Business Media.
4. Treisman, A. M., & Gelade, G. (1980). A feature-integration theory of attention. *Cognitive Psychology*, 12(1), 97–136.
5. Florida Department of Transportation. (2024). *Florida Traffic Online: Annual Average Daily Traffic (AADT) Open Data Reports*. FDOT Transportation Data and Analytics Office.
6. rt511 Internal Design Record. (2026). *Attention Engine: Multi-Objective Attention Allocation Specification and Status Ledger*, Project Technical Documentation[cite: 1].
