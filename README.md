# rt511

A traffic camera wall built from state transportation agencies' published camera feeds. It is dressed as an eighties security desk, amber phosphor and scanlines, and opens on the states it can see lifted out of the country and floating in a row, every camera a light lit by the sun that is on it right now. Step in to the map, pick a city, and you get that city's cameras laid out on its road network and ranked on a wall. Click one to watch it: a red LIVE badge where the agency streams video, a SNAPSHOT tag with its refresh where it publishes stills.

![The front page: the seven covered states floating in a row, every camera a point of light coloured by the sun on it](docs/images/front-page.jpg)

It reads only agencies whose written terms allow a third-party viewer to show their cameras, through the feeds they publish for that purpose: California, Iowa, Ohio, Oregon, Maine, New Hampshire and Vermont, 7,394 cameras in all. See [Camera sources](#camera-sources) and [Disclaimer](#disclaimer).

| The country map | A city's wall |
| --- | --- |
| ![The country map: each covered state a floating slab, west to east, with its cameras as lights and its cities as markers](docs/images/country-map.jpg) | ![A city's cameras ranked on the wall, each with its score, a SNAPSHOT tag and a countdown to its next picture](docs/images/wall.jpg) |

The wall above is a synthetic city: its pictures are drawn by the repository's mock server, so no agency's camera image is stored in this repository, as the disclaimer promises. The front page and the country map contain no camera pictures at all.

## Quickstart

You need Node 22 or newer with pnpm, and Python 3.12 or newer with [uv](https://docs.astral.sh/uv/).

```
make setup     # dependencies, then a road graph for each of the 29 included cities (about half an hour, since the OpenStreetMap server is asked politely; run it again if it stops, built cities are kept)
make start     # builds the wall and serves it
```

Open http://127.0.0.1:8511 and pick a city. Every included city works without a key. Ohio and Oregon need your own free API key only to refresh their camera lists and, for Ohio, to read incidents; see [Setup](#setup).

## Nothing is recorded

Worth saying first. A tool that watches hundreds of cameras could easily become an archive by accident. This one doesn't:

- **Video is never saved, and never touches the server.** Your browser loads the agency's own stream only while you have that camera open. Close it and the bytes are gone.
- **Snapshots are never saved.** The last few frames per camera are held in memory so you can scrub back a few minutes. Restart the server and they're gone.
- **Nothing is shared.** The server listens on localhost only.

The files on disk are all text, and none of them is a picture: the source table, camera lists read from the agencies' feeds, road geometry from OpenStreetMap, the graphs built from those, and text logs of the scorer's decisions under `out/`. The camera lists, the national index and everything in `out/` can be deleted and rebuilt with the pipeline.

## What it costs to run

The aim is that one person watching rt511 costs an agency about what one person watching its own 511 site does. Each server asks each agency for at most one on-screen picture every 5 seconds and one off-screen picture every 10 seconds, however big the wall: a wall of ten cameras refreshes each tile every minute, a wall of forty every three minutes or so, and cameras off screen every ten minutes or longer. No camera is asked more often than its agency refreshes it, every five minutes for Caltrans, which publishes that interval, and every minute elsewhere. Every request is conditional, so an unchanged picture costs a "not modified" reply of a few hundred bytes, and a picture that has stopped updating is asked about once a period, not sooner. A browser tab nobody can see asks for nothing, and a city nobody has open is not polled at all.

The camera open in the panel can go faster. Where an agency's pictures refresh quicker than the wall polls, that one camera is fetched at the agency's own rate for as long as the panel stays open: every 5 seconds in Ohio, which ODOT publishes. The panel crossfades from one picture to the next, and the badge says how often a new one arrives, as in "Snapshot · 5 s". A camera with video gets a red "Live" pill instead, on the panel and on its wall tile, so the two can be told apart at a glance. These pictures are kept apart from the replay and the scoring, which stay on the ordinary poll, and only the newest is held.

| | |
| --- | --- |
| Snapshot requests | at most one every 5 s on screen and one every 10 s off screen per agency, plus the one camera open in the panel at the agency's own rate, only for cities someone has open |
| Video | none from the server. The browser loads an agency's open stream only while you have that camera open |
| Disk written | none, apart from text logs under `out/` |

### Why some pictures are slow

Slow pictures are the policy working, not a fault. rt511 asks each agency for pictures no faster than the agency makes them, and within a small budget per agency, so a viewer here costs the agency about what one person on its own 511 site does. You will notice it in three places:

- **A wall fills in over a few minutes.** Tiles arrive about one every 5 seconds per agency, so a city of forty cameras takes around three minutes before every tile has a picture, and a score needs two pictures, so scores follow a little after.
- **A big wall refreshes slowly.** Each tile on screen is refreshed about every 5 seconds times the number of tiles from that agency, and never faster than the agency makes new pictures. Ten tiles refresh every minute; forty, every three minutes or so.
- **Some agencies publish only a still every few minutes.** Nothing on this side can make those faster. Where an agency publishes live video, opening the camera plays the agency's own stream straight away.

<details>
<summary>Where it is fast and where it is snapshot only</summary>

| State | Live video | A new still from the agency | A tile on the wall | The camera you open |
| --- | --- | --- | --- | --- |
| California | yes, on 2,184 of 3,412 cameras | every 5 minutes, as Caltrans publishes | every 5 minutes, longer on a big wall | the agency's video straight away where published, otherwise the still every 5 minutes |
| Iowa | yes, on 692 of 1,251 cameras | not published, polled every minute | every minute, longer on a big wall | the agency's video straight away where published, otherwise the still every minute |
| Ohio | no | every 5 seconds, as ODOT publishes | every minute, longer on a big wall | a new still every 5 seconds |
| Oregon | no | not published, about every 2 minutes when sampled | every minute, longer on a big wall | a new still every minute |
| Maine, New Hampshire, Vermont | no | about every 2 minutes, in one document per state | every 5 minutes | a new still every 5 minutes |

"Longer on a big wall" means about 5 seconds for every tile on screen from that agency. Counts and rates were measured against the live feeds in September 2026; see [Camera sources](docs/sources.md) for the detail.

</details>

Memory depends on what you run. Road and graph geometry is loaded once per city, roughly 40 MB each, and that's what lets the map draw without a tile server. The frame buffer is cameras times frames times snapshot size, and snapshots run 20 to 200 KB depending on the agency. Use `--ring` to trade replay history for memory; ten frames is about ten minutes.

Drawing costs nothing unless you're dragging the map. That matters for a screen left running. A busy city map takes about 34 ms per frame on a desktop CPU with no GPU, and scales with CPU speed, so a slow machine will feel it while panning and nowhere else.
## Being a good guest

Every request identifies the project and links to this repository in its User-Agent, and carries nothing else: no borrowed Referer, no token. Requests are capped per source. A camera returning a placeholder backs off for five minutes. The OpenStreetMap road extract is downloaded once per city and cached, since Overpass is run by volunteers.
## How it's put together

`docs/architecture.md` has the full picture. In short:

| Directory | Language | Role |
| --- | --- | --- |
| `src/rt511/` | Python | Offline pipeline. Finds cameras, matches them to roads, builds graphs. You run it by hand. |
| `server/` | TypeScript | The web service. Serves the API, the snapshots it holds in memory and the built wall. Video never passes through it. |
| `web/` | React | The wall itself. |
| `shared/` | TypeScript | Types shared by the server and the wall. |

Python here is a batch tool, not a server. It uses shapely and networkx for geometry and shortest paths, and serves no HTML.

## Setup

```
uv sync
pnpm install
cp .env.example .env
```

Ohio and Oregon need your own free API key, which you register for yourself under each agency's terms: OHGO at https://publicapi.ohgo.com/docs/registration and TripCheck at https://apiportal.odot.state.or.us/. Put them in `.env` as `OHIODOT_API` and `OREGONDOT_API`. They are used to read the camera lists and, for Ohio, the incident feed; images need no key. The project never ships a key, and without one those two states are simply unavailable.

## Running it

```
pnpm start
```

One command. It builds the server and the wall, then serves both on http://127.0.0.1:8511. Ctrl+C stops it and releases the port. You don't have to pick a city.

With no arguments every city you've built is loaded, so the national map and all the city maps work straight away, but **no camera is polled until you open one**. Open a city and its cameras start; leave it and they stop a couple of minutes later. A server nobody is looking at makes no requests at all.

Arguments pass through to the server:

```
pnpm start --regions oakland-ca,des-moines-ia    poll these cities from the start
pnpm start --cameras freeway                only freeway cameras
pnpm start --port 8512                      somewhere else
pnpm start --ring 30                        keep more replay history
```

Naming cities polls them continuously whether or not anyone is watching, which is what you want for a screen left on.

**Which would you watch?** is the other half of the idea: people's attention. **Which?** in a city's top bar shows two of its cameras side by side, pictures only, and you pick the one you would rather watch, or skip. The wall's own score for each is revealed after you choose. Every choice is a comparison, and a Bradley–Terry model in your browser learns from them what draws your eye, over the same things the equation looks at: unusual movement, road size, an incident or a queue, stopped traffic, darkness, brightness and freeway or street. It asks about the pairs it is least sure of, so it learns quickly. The panel beside it shows what you weigh, how often you and the wall agree and where you disagree most, and after ten choices it can rank the wall by your attention instead of the equation. Your choices stay in the browser's local storage and are never sent anywhere; Export saves them as JSON.

**Evaluate** switches Which? from learning your attention to judging the rankers against it. Pairs are drawn at random, and half the time from cameras the equation and the second look below put in opposite orders, and nothing is revealed while you choose; the running results show when you switch back to Learn. `uv run python scripts/evaluate_attention.py <export>.json --logs out` then scores each ranking on those blind choices.

**The second look** needs `JEV_API` in `.env`. While a city is open, Jev looks at its eight leading cameras together every few minutes and nudges each one's movement term between 0.75 and 1.25 times; it never changes an incident or stopped-traffic floor. Every look is logged beside the fixed equation's own order in `out/jev-<date>.jsonl`. Without a key the wall is ranked by the equation alone. How it all fits together is in [the whitepaper](docs/rt511_visual_attention_whitepaper.md).

**Attention spreading** is the scorer's reasoning made visible on a city's map. When a camera sees unusual movement, stopped traffic or an incident, the wall starts watching the cameras along its road more closely, and a camera upstream of an incident or stopped traffic gets a floor because the queue could reach it. Both are now drawn: small comets travel along the actual road from the camera that saw something to each camera it made worth watching, and a ring opens where they land, pale white for movement, deep orange for stopped traffic, red for an incident. Nothing new is decided for this; it shows what the scorer already does, from `/api/scores` and the queue floors in the poll. It stands still for anyone who asks for reduced motion.

**Road trip** in the top bar drives a numbered route through the city you are in, camera by camera in driving order: I-235 across Des Moines or I-10 through Los Angeles. Each camera stays up for a few seconds, longer where it has live video and where the next one is further down the road, and at the end of the route the trip turns around and drives it back. A trip is written into the page address (`#…&trip=I-235:eastbound`), so a screen left running resumes it after a reload.

**Sun relay** follows the sunset across the country. It shows whichever city the sun is setting over, stepping through that city's most interesting cameras, and hands off westward through the evening: Portland ME and Burlington first, Portland OR and Los Angeles last. Between sunsets it waits on the next one, and at night it waits on the first sunrise. `#relay` in the address resumes it.

**Snow** is read from the pictures. Each frame's share of bright, colourless pixels is compared with that camera's own recent frames, and when at least three cameras in a city turn white together in daylight the city reads as snow: a white ring on the national map, and a diary entry that says so, "first snow of the season" the first time each winter. Iowa's rural weather-station cameras are where this earns its keep. Like the murky-sky hint beside it, it is a hint from pixels, not a weather report.

**City pulse** is a small line under each city in the national list: how much its cameras moved, minute by minute, from midnight to midnight. Each minute is the median frame difference across the city's cameras with a recent picture, scaled to that city's own busiest minute, so a quiet city's rush hour shows as clearly as a big one's. It is numbers only, kept in `out/pulse-<date>.jsonl` so a restart keeps the day, and a city nobody has open is read from its sparse radar cameras.

**Night shift** puts the vehicle detector's count on the open camera once the sun is down there, in the camera's own local time: "3:12 AM · 2 cars". It needs `make detect` running and shows nothing without it. The count is the same one the gate logs to `out/detector-<date>.jsonl`, taken once per frame, and it is display only: it never enters the attention score.

The optional vehicle detector runs as its own process next to the server. It counts vehicles in a frame the zero-motion gate has flagged and hands the count to the arbiter as evidence. It needs the YOLO26 weights in `data/models/` (see [License](#license)):

```
uv sync --extra detector
uv run rt511 detect                         on 127.0.0.1:8513, the GPU when there is one
uv run rt511 detect --device cpu            when the GPU is busy
```

The server looks for it at startup and once a minute after that, so it can be started in either order. Set `RT511_DETECTOR_URL` in `.env` to point elsewhere. Without it, still cameras are asked about exactly as before.

| Command | Does |
| --- | --- |
| `pnpm start` | build, then serve |
| `pnpm serve` | serve without rebuilding |
| `pnpm dev` | Vite with hot reload on 5173 and the API on 8511, together, one Ctrl+C stops both |
| `pnpm build` | build only |
| `pnpm check` | type-check everything |

The `Makefile` wraps all of these and the `uv run rt511` pipeline commands below. Run `make` to list them. `make up` runs the server and the detector together, and `make add-city CITY="Buffalo, NY"` creates, catalogs and builds a city in one step.

`pnpm dev` runs the two processes through `concurrently`, so their output is labelled `api` and `web` and interrupting it takes both down.

## Adding a city

```
uv run rt511 sources
uv run rt511 metros --top 20 --name
uv run rt511 city "Des Moines, IA" --radius 12 --limit 60
uv run rt511 catalog --region des-moines-ia
uv run rt511 build --region des-moines-ia
uv run rt511 counts --region des-moines-ia    # Iowa, where the agency publishes counts
```

`sources` lists the agencies this project reads, what each publishes, and its terms. `metros` shows where cameras actually cluster, so you can pick somewhere worth watching. `city` geocodes the name, works out which source covers that state, keeps the cameras nearest the centre, and saves the region. `catalog` reads their details from the agency's feed and `build` matches them to roads. `counts` joins the agency's published traffic counts, where it publishes them under terms that allow it, so the scorer knows how big each road is from a measurement rather than from road class. A city in a state with no source is refused.

California and Iowa publish open video for many of their cameras. The other states publish stills only.
## Three levels of coverage

These scale very differently, which is why the project doesn't just fetch everything:

| | Scope | Cost |
| --- | --- | --- |
| **Indexed** | every camera's position | one read of each source's feed, refreshed by hand |
| **Catalogued** | one city's cameras in full detail | one read of its source's feed, once |
| **Polled** | cameras being watched now | one request per camera per refresh period, while watched |

Indexing is cheap and complete, so the national map shows every camera the sources publish. Cataloguing is a one-off. Polling is the one that has to stay small. Cities exist to bound it, and so does the road graph, since each city needs a multi-megabyte extract from Overpass.
## The camera graph

Cameras are matched to roads and then to each other, which is what turns a list of cameras into a corridor you can follow.

- **Sites** group cameras within 40 m of each other on the same carriageway. Motorway and surface cameras never share one.
- **Matching is scored, not nearest-wins.** A camera's route number, taken from its roadway field, is the strongest signal available, and it's what separates a mainline camera from the frontage road beside it. Direction codes break the remaining tie between carriageways. Cameras named as an intersection give up their route number and are kept off the mainline, so a camera labelled with the freeway it sits beside does not land on the freeway half a mile away.
- **A site with no direction code sits on both carriageways.** Iowa publishes no direction, so a camera would land on whichever side is nearer and consecutive cameras would end up facing opposite ways. When you can't tell which way a camera looks, the honest answer is that it covers the whole cross-section.
- **Edges follow traffic.** Site B follows site A if the shortest path between them passes no other site, comes within 60 m of no other camera, and isn't more than 2.5 times the straight-line distance. Each edge carries its length, free-flow travel time, road classes and geometry.
- **Kinds** are freeway, ramp, street, and nearby. Nearby joins two sites close enough to watch the same place with no way to drive between them: parallel one-way streets a block apart, a freeway camera and the arterial at its interchange, or the two carriageways of a divided highway.
- **Validation** checks direction codes against the carriageway, mile marker order, and how many cameras naming a route ended up on it. A source that publishes no direction codes gets an empty direction check instead of a failure.

Where it stands:

| | Oakland | Des Moines | Columbus | Portland | Burlington |
| --- | --- | --- | --- | --- |
| Cameras, sites | 80, 65 | 80, 75 | 80, 80 | 80, 78 | 9, 6 |
| Routes matched | 51/79 | 70/76 | 28/28 | 37/40 | 9/9 |
| Direction reversed | 1 of 51 | not published | not published | not published | 0 |
| Isolated sites | 6 | 1 | 0 | 2 | 3 |

Direction codes name the route's signed direction, not a compass bearing, so they sit some way off the carriageway's bearing even when correct: a median of 38° around Oakland. That's why the check only flags a near-reversal.

## Disclaimer

rt511 is an independent, non-commercial, open-source project. It is not affiliated with, endorsed by, or operated by any transportation agency. Camera images and traffic data belong to the agencies credited below and are shown as published, without modification and without any warranty of accuracy, completeness or availability. Images are held in memory only and are never stored or redistributed. Do not use while driving.

The same text is on screen whenever the wall is, and every camera shows the agency it comes from, the terms it is published under, and a link to those terms.

## Camera sources

rt511 reads cameras only from agencies whose published terms allow a third-party viewer to show them, and only through the feeds those agencies publish for the purpose. A state is added when its terms say yes, not when its cameras happen to be reachable.

| State | Agency and feed | Terms | Video |
| --- | --- | --- | --- |
| California | Caltrans Commercial Wholesale Web Portal (CWWP2) | [Public domain unless otherwise indicated](https://dot.ca.gov/conditions-of-use) | open HLS where published |
| Iowa | Iowa DOT open-data Traffic Cameras layer | [CC BY 4.0](https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5) | open HLS where published |
| Ohio | ODOT's OHGO Public API, your own key | [Public domain, per ODOT](https://publicapi.ohgo.com/docs/terms-of-use) | snapshots only |
| Oregon | ODOT's TripCheck API, your own key | [Use with credit, mirroring and ODOT's disclaimer](https://www.tripcheck.com/Pages/API) | snapshots only |
| Maine, New Hampshire, Vermont | Tri-State's New England Compass Developer Portal | [Use, reproduce and redistribute, crediting Tri-State](http://nec-por.ne-compass.com/DeveloperPortal/Home/Terms) | snapshots only |

Oregon's terms require its disclaimer to be repeated wherever its cameras are credited, so it appears in full with every Oregon camera. Ohio's terms cap each key at a published request rate, and this project stays well under it. Maine, New Hampshire and Vermont publish every camera's picture in one document per state, 5 to 10 MB, so the server fetches it at most once every five minutes and only while a city there is open.

States that are not listed either publish no terms permitting a third-party viewer, limit their content to individual use, or grant permission only through an agreement each user would have to apply for. They are left out rather than read in a way their owner has not agreed to.

Road geometry is © OpenStreetMap contributors under the ODbL. State boundaries come from Natural Earth and are public domain. There's deliberately no tile layer anywhere: the volunteer-run OpenStreetMap tile servers aren't meant to be an app's background, so roads are drawn as vectors from the cached extract instead.

Each person runs their own copy on their own machine. Nothing is hosted, and no camera data passes through anyone else.

If you have your own arrangement with an agency that is not listed, for instance a developer key whose terms need the agency's written consent before any public use, you can run it on your machine without it ever reaching a commit: see [Local sources](docs/sources.md#local-sources).

## License

rt511's own code is released under the MIT License, in `LICENSE`.

That licence covers the code in this repository and nothing it reads. Camera imagery belongs to the state Departments of Transportation that publish it, road geometry is © OpenStreetMap contributors under the ODbL, and state boundaries come from Natural Earth in the public domain, as described above.

The optional vehicle detector is designed to run Ultralytics YOLO26, whose code and model weights are licensed under AGPL-3.0. Those weights are not part of this repository and are never committed. They live in the git-ignored `data/models/` folder, and without them the detector switches itself off and everything else runs exactly as before. If you run rt511 with the YOLO26 weights, that deployment has to meet the AGPL-3.0 terms, which include making the source of the running service available. MIT code can be combined with AGPL code, so this repository's source already satisfies that for an unmodified copy. If you need the whole stack under permissive licences, use a permissively licensed detector in place of YOLO26.

