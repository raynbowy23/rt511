# Architecture

Three programs and a contract between them.

```
  agency feeds (5)          OpenStreetMap            Nominatim
  caltrans, iowadot, ohgo,  Overpass + Natural Earth   geocoding
  tripcheck, necompass
        │                          │                      │
        └──────────┬───────────────┴──────────────────────┘
                   │  run by hand, occasionally
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
        ┌────────────────────────┐        live snapshots
        │  TypeScript server     │ ◀──────────────────────────── agency image hosts
        │  poller, API           │
        └────────────┬───────────┘
                     │ HTTP, types from shared/
                     ▼
        ┌────────────────────────┐
        │  React wall            │   web/
        │  map, tiles, player    │
        └────────────────────────┘
```

The split is between work done once and work done continuously. Finding cameras and matching them to roads is slow, occasional, and uses geometry libraries; that's Python. Polling snapshots and serving a browser is continuous and shares types with the frontend; that's TypeScript.

## 1. The Python pipeline (`src/rt511/`)

A batch tool. Each command runs, writes files, and exits. Nothing here stays running and nothing serves HTTP.

| Command | Does | Writes |
| --- | --- | --- |
| `sources` | Lists the camera sources, what each publishes, and its terms | — |
| `index` | Reads every camera position from every source's feed | `data/national_index.json` |
| `metros` | Clusters those positions into metro areas | — |
| `city` | Geocodes a city, picks the source covering that state | `data/regions.json` |
| `catalog` | Reads one city's cameras from its source's feed | `data/cameras_<city>.json` |
| `build` | Matches cameras to roads, builds the graph | `out/graph_<city>.json` |

Modules:

- `sources.py` loads `data/sources.json`, the table of camera sources. That table is JSON rather than code because the TypeScript server reads the same facts, and a measured fact written twice drifts.
- `regions.py` and `geocode.py` turn a city name into a bounding box and a source. Geocoding goes through Nominatim, once per city, cached.
- `catalog.py` fetches each camera's detail record and normalises it. Camera position, roadway, direction, mile marker, snapshot path, stream URL.
- `osm.py` downloads the road extract from Overpass, once per city, cached, and builds a directed graph of the road network with lengths and free-flow travel times.
- `network.py` does the matching. Each camera is scored against nearby road segments rather than snapped to the nearest one.
- `refs.py` parses route numbers out of camera names and OpenStreetMap tags, normalising them so `I-39/US 51`, `I 39;US 51` and `US 12/18` all compare correctly.
- `graph.py` clusters cameras into sites, derives which site follows which, classifies each edge, and runs the validation checks.

### How matching works

The hard part is deciding which road a camera watches. Naive nearest-segment matching fails constantly, because a freeway camera often sits closer to a frontage road than to the freeway.

Each candidate segment within 80 m is scored:

- Distance is the base score.
- A route number in common with the camera's roadway field is worth a large bonus, and a conflicting route number a penalty. This is the strongest signal and works in every state, unlike mile markers, which not every source publishes.
- If the camera has a direction code, segments are penalised in proportion to how far their bearing is from it. Graded, not pass or fail, because a direction code names the route's signed direction and a road curves away from that.
- A camera named as an intersection is penalised for landing on a motorway, since a mainline camera is never at a signalised junction.

Cameras within 40 m on the same carriageway then merge into one site. Sites are spliced into the road graph as nodes, and site adjacency comes from shortest paths between them, so an edge exists only when you could actually drive from one to the other without passing a third.

The 80 m cutoff is deliberate. In one earlier city, sixteen cameras had no road within 80 m; their nearest road was 110 to 300 m away and usually the wrong one. Widening the cutoff would confidently attach them to a road they don't watch. They stay unmatched, remain watchable, and are simply absent from the graph.

## 2. The TypeScript server (`server/`)

Long-running. Reads what the pipeline wrote, polls cameras, serves the API and the wall.

- `config.ts` loads and shape-checks every pipeline file at startup: sources, regions, catalogs, graphs, the national index, state outlines, road extracts.
- `client.ts` is one HTTP client per source. It holds that source's concurrency limit, the identifying User-Agent, and conditional snapshot requests.
- `poller.ts` runs one loop per camera and keeps a small ring buffer of recent frames with their metrics.
- `app.ts` defines the endpoints, merges graphs across cities, and renumbers camera ids.
- `http.ts` is a small router. Nine routes didn't justify a framework.

### Polling

Each camera has its own loop, started at a staggered offset so load spreads evenly.

Polling is per city and, by default, driven by what you're looking at. Launched with no `--regions`, the server loads every built city but starts nothing. The wall names the city it's showing on each state poll, which starts that city's cameras; a city nobody has named for two and a half minutes stops again and drops its frames. Naming cities on the command line pins them instead, polling them continuously whether or not anyone is watching.

The next poll is scheduled at the last `Last-Modified` plus the source's period plus a few seconds' margin rather than on a fixed timer. Some image hosts rebuild a snapshot on demand once the cached one has expired and stamp `Last-Modified` with the time of the request that rebuilt it, so a request arriving early gets the stale copy and resets the cache for another full period. Scheduling from `Last-Modified` avoids that wherever it happens and costs nothing where it doesn't.

A 304 is handled differently from a 200 with identical bytes. A 304 carries no new timestamp, so there's nothing to schedule from and the poller waits a fixed interval. A 200 does carry one, even when the image hasn't changed, which is common because the picture behind it updates more slowly than the cache expires. Freshness is therefore decided by comparing bytes, not timestamps.

A camera with no feed can return a valid placeholder image, so availability is decided by the content type each source declares for a real picture, not by inspecting the bytes.

Each new frame is decoded, converted to greyscale, resized to 64×48, and compared to the previous thumbnail. That gives brightness and a mean absolute difference. Only the newest thumbnail is kept, since it's only there to difference the next frame against.

### Activity

Raw frame difference isn't comparable between cameras. A quiet rural road and a downtown junction differ by an order of magnitude, so any fixed threshold would leave the same few cameras permanently lit.

Each camera is scored against its own recent median instead. Sitting at its median reads as 0.5, twice its median saturates at 1. Until a camera has enough history, it borrows its city's median, which is what lets the wall start responding within a minute instead of ten.

### Video

Every source that publishes video serves open HLS with permissive CORS. `/api/stream/:id` returns the agency's own URL with `direct: true` and the browser plays it itself, bypassing the server entirely. Nothing is fetched until someone opens a camera, and the server never touches video.

### Camera ids

Camera ids are only unique within one source. The feeds carry no id that is numeric, stable and small, so the pipeline hashes each camera's image URL into a native id below ten million. Each source then gets a block of ten million based on its position in the sorted source list, so Iowa's native id 7961432 becomes 17961432. Region graphs are renumbered into that space as they're served.

## 3. The React wall (`web/`)

A front page, then three levels: the country, a city, a camera. The whole wall is dressed as an eighties security desk, one amber phosphor on near-black in a monospace face, with scanlines laid over the screen and a burst of snow when the view changes channel. The canvases take their colours from `web/src/retro.ts`, beside the stylesheet's tokens of the same names. The scanlines darken the screen above the pictures and never alter them, and all motion stops for a viewer who asks for less.

- **Front page** is one canvas: the covered states laid out as in the national view below, every indexed camera a point of light on its state, coloured by the sun on it now (day, sunset and sunrise, night), drawn once into a dozen layers that breathe on their own cycles so a frame costs a dozen blends. Clicking a state opens the country map, and the sources table with each agency's terms and the disclaimer sit behind one link. Nothing is polled while it is open.

- **National** draws only the states that have a camera source. Each is lifted out of the country as a slab and set in a row west to east on a tilted table, its size eased toward the others so Vermont is not a speck beside California (`web/src/slabs.ts`). Indexed cameras are binned into lights on their own slab. Cities being polled appear as markers, cities merely configured as dashed outlines. Hovering a slab raises it and names its cities, and clicking one away from its cities brings that state up to fill the view.
- **City** draws the road network underneath and the camera graph on top, edges told apart by the phosphor's strength and a dash, nodes sized and warmed by activity. Clicking a node opens that camera beside the map.
- **Wall** is the tile grid for one city, cross-fading as frames arrive and resizing tiles by attention, so a camera with a crash reported on it can hold a large tile while its picture sits still. The bar under each tile still shows raw activity, which is what the picture is doing rather than what the camera is worth. Each tile also carries its score and what drove it (moving, incident, queue, stopped), a line along its top that fills until its next picture is due, a LIVE or SNAPSHOT tag, and its channel number and picture time in the label strip, so a wall of stills a minute apart still shows it is working. The tiles come in one after another, busiest first, when the wall opens.
- **Scores** is a collapsible right pane summarising attention by city and by camera, with each camera's score broken down into movement times road size, times the second-look factor where there is one, the incident floor, and the stopped-traffic floor. Jev, when a key is set, adjusts those floors and gives the second look behind the scenes, but the interface does not name it. It reads `/api/scores`, a read-only endpoint built on the same scoring code as the wall, so opening it never changes what the server polls and never causes a model call.

React owns navigation, the breadcrumb, the city list, the tile grid, the camera panel and the splitter. Canvas drawing and video playback stay imperative behind effects that create and destroy them, because pushing thousands of paths through the virtual DOM would be slower for no benefit. The camera panel is placed by CSS grid rather than moved between parents, so one video element survives switching views.

## 4. The shared contract (`shared/`)

Every API response type, imported by both the server and the wall, so a renamed field is a compile error rather than an undefined at runtime.

It also brands the two coordinate orders. `/api/national` sends GeoJSON `[lon, lat]`; `/api/graph` and `/api/roads` send `[lat, lon]`. Both are pairs of numbers, so mixing them compiles cleanly and renders a plausible but rotated map, which is worse than crashing. They're distinct types, converted only at the point where raw JSON is validated.

The wall still checks the top level of each response at runtime, because a built page can meet an older server, or a proxy error page instead of a server.

## Data flow at a glance

| File | Written by | Read by |
| --- | --- | --- |
| `data/sources.json` | hand-maintained | Python and the server |
| `data/regions.json` | `rt511 city` | Python and the server |
| `data/cameras_<city>.json` | `rt511 catalog` | `rt511 build`, the server |
| `data/osm_<city>.json` | `rt511 build` | `rt511 build`, the server's map endpoint |
| `data/national_index.json` | `rt511 index` | the server's national endpoint |
| `data/us_states.json` | `rt511 index` | the server's national endpoint |
| `out/graph_<city>.json` | `rt511 build` | the server |

Nothing flows back the other way. The server never writes to disk, which is why no snapshot or video is ever stored.
