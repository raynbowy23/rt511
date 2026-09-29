# Architecture Specification

rt511 consists of three programs, an offline pipeline, a server and a web interface, coordinated through files on disk and a shared set of types for the network interface.

```
  agency feeds (5)             OpenStreetMap             Nominatim
  caltrans, iowadot, ohgo,     Overpass, Natural Earth   geocoding
  tripcheck, necompass
        │                            │                       │
        └──────────┬─────────────────┴───────────────────────┘
                   │  run by hand, when a city is added or refreshed
                   ▼
        ┌────────────────────────┐
        │  Python pipeline       │   src/rt511/
        │  catalog, build, index │
        └────────────┬───────────┘
                     │ writes JSON
                     ▼
              data/  and  out/
                     │ read at startup
                     ▼
        ┌────────────────────────┐          live snapshots
        │  TypeScript server     │ ◀──────────────────────────── agency image hosts
        │  poller, scorer, API   │
        └────────────┬───────────┘
                     │ HTTP, types from shared/
                     ▼
        ┌────────────────────────┐
        │  React interface       │   web/
        │  wall, maps, panels    │
        └────────────────────────┘
```

The split is between work done once and work done continuously. Finding cameras and matching them to roads is slow, occasional and uses geometry libraries, so it is written in Python. Polling pictures, scoring them and serving a browser is continuous and shares types with the interface, so it is written in TypeScript.

---

## 1. Offline Pipeline (`src/rt511/`)

The pipeline is a batch tool. Each command runs, writes files and exits. Nothing in it stays running, and nothing in it serves HTTP.

### Command registry

| Command | What it does | What it writes |
| --- | --- | --- |
| `sources` | Lists the camera sources, what each one publishes, and its terms. | Nothing |
| `index` | Reads every camera position from every source's feed, for the country map. | `data/national_index.json` |
| `metros` | Clusters those positions to show where cameras concentrate. | Nothing |
| `city` | Geocodes a city and chooses the source that covers its state. | `data/regions.json` |
| `catalog` | Reads one city's cameras from its source's feed. | `data/cameras_<city>.json` |
| `build` | Downloads the city's road network, matches cameras to it and builds the graph. | `data/osm_<city>.json`, `out/graph_<city>.json` |
| `counts` | Joins the agency's published traffic counts to the city's cameras, where it publishes them. | `data/aadt_<city>.json` |
| `setup` | Builds every configured city that has no graph yet and joins its counts. | As `build` and `counts` |

The modules divide the work as follows.

- `sources.py` loads `data/sources.json`, the table of camera sources. The table is JSON rather than code because the server reads the same facts, and a measured fact written in two places drifts.
- `regions.py` and `geocode.py` turn a city name into a bounding box and a source. Geocoding goes through Nominatim once per city and is cached.
- `feeds.py` holds one reader per kind of feed, and `catalog.py` normalizes each camera's record into its position, roadway, direction, mile marker, picture address and stream address.
- `osm.py` downloads the road extract from Overpass once per city, caches it, and builds a directed road graph with lengths and free-flow travel times.
- `network.py` matches cameras to road segments by score rather than by nearest distance.
- `refs.py` parses route numbers out of camera names and OpenStreetMap tags and normalizes them, so that `I-39/US 51`, `I 39;US 51` and `US 12/18` compare correctly.
- `graph.py` groups cameras into sites, derives which site follows which, classifies each edge and runs the validation checks.
- `counts.py` joins published traffic counts to mainline segments on each camera's own route.

### Corridor matching

The hardest part of the pipeline is deciding which road a camera watches. Matching each camera to the nearest segment fails often, because a freeway camera frequently sits closer to a frontage road than to the freeway itself. Each candidate segment within 80 m is scored instead.

1. **Distance** is the base score. A camera with no candidate within 80 m is left unplaced. In one earlier city, sixteen cameras had no road within 80 m, and their nearest roads, 110 to 300 m away, were usually the wrong ones, so widening the cutoff would attach them confidently to roads they do not watch. An unplaced camera is still polled and can still be watched. It is only absent from the graph.
2. **Route agreement.** A route number shared with the camera's roadway field earns a large bonus, and a conflicting route number a penalty. This is the strongest signal available and works in every state, unlike mile markers, which not every source publishes.
3. **Direction.** Where a camera publishes a direction, segments are penalized in proportion to how far their bearing is from it. The penalty is graded rather than pass or fail, because a published direction names the route's signed direction and a road curves away from that. Only a disagreement greater than 135 degrees is treated as a reversal.
4. **Intersections.** A camera named as an intersection is penalized for landing on a motorway, since a mainline camera is never at a signalized junction.
5. **Sites and edges.** Cameras within 40 m of each other on the same carriageway merge into one site. Sites are spliced into the road graph as nodes, and an edge between two sites exists only when the shortest path from one to the other passes no third site.

---

## 2. Server (`server/`)

The server runs continuously. It reads what the pipeline wrote, polls cameras, scores them, consults the reasoning model when it is configured, and serves the API and the built interface.

- `config.ts` loads and checks the shape of every pipeline file at startup, including the sources, regions, catalogs, graphs, national index, state outlines and road extracts.
- `client.ts` provides one HTTP client per source, which holds that source's rate limit, the identifying User-Agent and the conditional picture requests.
- `poller.ts` runs one loop per camera, schedules each poll within the per-agency budget, and keeps a small ring buffer of recent frames with their measurements.
- `attention.ts` computes the hour-of-week baselines, the road-size prior, the consequence floors and the attention score, and writes the decision log.
- `corridor.ts` carries queue floors upstream along the graph and promotes the neighbors of cameras where something is happening.
- `jev.ts` asks the reasoning model its typed questions and turns the answers into bounded adjustments.
- `cad.ts` reads the incident feed, `detector.ts` talks to the optional vehicle detector, and `radar.ts` and `board.ts` keep the national board.
- `app.ts` defines the endpoints, merges the graphs of all cities and renumbers camera ids, and `http.ts` is a small router.

### Polling

Each camera has its own loop, started at a staggered offset so that load spreads evenly.

- **Driven by the viewer.** Started without `--regions`, the server loads every built city but polls nothing. The interface names the city it is showing on each state request, which starts that city's cameras. A city that nobody has named for 150 seconds stops again and drops its frames. Naming cities on the command line pins them, so they are polled whether or not anyone is watching.
- **Budget.** Each server asks each agency for at most one on-screen picture every 5 seconds and one off-screen picture every 10 seconds, and no off-screen camera more often than every 10 minutes. The camera open in the panel is outside the budget and is fetched at its agency's own rate.
- **Scheduling.** Some image hosts rebuild a picture on demand once the cached copy has expired and stamp `Last-Modified` with the time of the request that rebuilt it, so a request that arrives early receives the stale copy and resets the cache for another full period. A poll is therefore timed to land 4 seconds after the next picture is due, counted from the newest `Last-Modified`. A `Last-Modified` older than one period, a missing one, or a `304 Not Modified` reply waits one full period.
- **Freshness.** A `200` reply often carries a picture identical to the last, because the picture behind it changes more slowly than the cache expires. Freshness is therefore decided by comparing bytes, not timestamps.
- **Availability.** A camera with no feed can return a valid placeholder image, so availability is decided by the content type each source declares for a real picture, and a camera returning a placeholder waits 5 minutes.
- **Measurement.** Each new frame is decoded, converted to grayscale, resized to 64 × 48 and compared with the previous thumbnail, which gives its brightness and its mean absolute difference. Only the newest thumbnail is kept, since it exists only to difference the next frame against.

### Video

Every source that publishes video serves open HLS with permissive CORS. `/api/stream/:id` returns the agency's own address, and the browser plays it directly. Nothing is fetched until someone opens a camera, and video never passes through the server.

### Camera ids

Camera ids are unique only within one source. The feeds carry no id that is numeric, stable and small, so the pipeline hashes each camera's image address into a native id below ten million. Each source then receives a block of ten million according to its position in the sorted source list, so Iowa's native id 7961432 becomes 17961432. Region graphs are renumbered into that space as they are served.

---

## 3. Web Interface (`web/`)

The interface is styled after an eighties security desk, with one amber phosphor on near-black in a monospace face, scanlines laid over the screen, and a short burst of static when the view changes. Canvases take their colors from `web/src/retro.ts`, beside the stylesheet's tokens of the same names. The scanlines darken the screen above the pictures and never alter them, and all motion stops for a viewer who has asked their system for reduced motion.

- **Front page.** One 2D canvas shows the covered states laid out as in the country view, with every indexed camera a point of light on its state, colored by where the sun is on it (day, sunset and sunrise, or night). The lights are drawn once into a dozen layers that brighten and dim on their own cycles, so each frame costs a dozen blends. Nothing is polled while the front page is open.
- **Country view.** Only the states with a camera source are drawn. Each is lifted out of the country as a slab and set in a row from west to east on a tilted table, with its size eased toward the others so that Vermont is not a speck beside California (`web/src/slabs.ts`). Cameras are binned into lights on their own slab. Polled cities appear as markers and configured cities as dashed outlines.
- **City map.** The road network is drawn underneath and the camera graph on top, with edge kinds told apart by the phosphor's strength and by dashing, and nodes sized and warmed by activity. Promotions and queue floors are drawn as pulses traveling along the roads.
- **Wall.** The tile grid for one city crossfades as pictures arrive and sizes tiles by attention rank, with four ranks of hysteresis. Each tile carries its score and what drove it, a line that fills until its next picture is due, a LIVE or SNAPSHOT tag, and its channel number and picture time.
- **Scores pane.** A collapsible pane summarizes attention by city and by camera and breaks each score into movement times road size, times the second-look factor where there is one, and the incident, queue and stopped-traffic floors. It reads `/api/scores`, a read-only endpoint, so opening it never changes what is polled and never causes a model call. The reasoning model is not named in the interface.

React owns navigation, the lists, the tile grid, the camera panel and the splitter. Canvas drawing and video playback stay imperative behind effects that create and destroy them, since pushing thousands of paths through the virtual DOM would be slower for no benefit. The camera panel is placed by CSS grid rather than moved between parents, so one video element survives a change of view.

---

## 4. Shared Contract (`shared/`)

Every API response type is imported by both the server and the interface, so a renamed field is a compile error rather than an undefined value at runtime.

The shared layer also brands the two coordinate orders. `/api/national` sends GeoJSON `[longitude, latitude]` pairs, while `/api/graph` and `/api/roads` send `[latitude, longitude]`. Both are pairs of numbers, so mixing them would compile and render a plausible but rotated map. They are distinct types, converted only where raw JSON is validated. The interface still checks the top level of each response at runtime, because a built page can meet an older server, or a proxy's error page instead of a server.

---

## Data Artifacts

| Path | Written by | Read by | Contents |
| --- | --- | --- | --- |
| `data/sources.json` | Maintained by hand | The pipeline and the server | The camera sources and their terms |
| `data/regions.json` | `rt511 city` | The pipeline and the server | The configured cities |
| `data/cameras_<city>.json` | `rt511 catalog` | `rt511 build` and the server | One city's cameras |
| `data/osm_<city>.json` | `rt511 build` | `rt511 build` and the server's map endpoint | The city's road geometry |
| `data/aadt_<city>.json` | `rt511 counts` | The server | Published traffic counts joined to cameras |
| `data/national_index.json` | `rt511 index` | The server's national endpoint | Every camera's position |
| `data/us_states.json` | `rt511 index` | The server's national endpoint | State outlines |
| `out/graph_<city>.json` | `rt511 build` | The server | The city's directed camera graph and its build report |
| `out/attention-<date>.jsonl` | The server | Offline analysis | The decision log |
| `out/jev-<date>.jsonl` | The server | Offline analysis | Every reasoning call, its state and its answers |
| `out/detector-<date>.jsonl` | The server | Offline analysis | Vehicle counts from the optional detector |
| `out/pulse-<date>.jsonl`, `out/diary-<date>.jsonl` | The server | The server, after a restart | Each city's movement through the day, and the diary |

The server writes only these text logs. No picture or video is ever stored.
