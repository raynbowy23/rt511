# Changelog

Each release lists the commits it carries, in the order they landed.

## 0.3.0 (2026-09-27)

rt511 0.3.0 grows from 12 cities to 31 and gets a front door.

- **A front page.** Every camera in the country as a point of light, coloured by the sun on it right now: gold by day, amber at sunset, blue at night. Click the country to step in.
- **Live video or a snapshot, at a glance.** A red LIVE pill where the agency streams video, a grey SNAPSHOT with its refresh where it publishes stills, on the camera and on every wall tile.
- **Faster pictures where the agency allows.** The camera you have open is fetched at its agency's own rate, every 5 seconds in Ohio and every 15 in Kentucky, and fades from one picture to the next. The live attention line now reads those pictures too.
- **A wall that shows its thinking.** Each tile carries its score and what drove it, a line counting down to its next picture, and a glow when one lands. Early scores no longer read 1.00 before a camera has history.
- **Nineteen more cities** from the states rt511 already reads: seven in Iowa, seven in California, Dayton, Akron and Toledo, Portsmouth and Manchester, and Eugene.
- **Smoother throughout.** A zoom into a city from the country map, tiles arriving one after another, a gentle fade between views, and a loading ring while a stream tunes in.

Under the hood: checks, tests and a browser smoke test on every change, tests for the wall's own logic, releases cut by one command, and the server build no longer committed.

Every change:

- Update sharp to 0.35.4 for the libvips and libheif advisories
- Lint the Python with ruff in make check
- Format the Python with ruff format
- Check the Python formatting in make check
- Lint the TypeScript with ESLint in make check
- Type-check the wall in make check
- Fetch the open camera at its agency's own refresh rate, and crossfade the panel
- Label snapshot cameras as live snapshots, and keep the open camera on its source's period
- Rework the top bar so each control says what it does
- Fix fullscreen on close, pin the footer and minimap properly, and take Jev out of the interface
- Add a front page, and tell live video from live snapshots
- Move the wall's Video tag into the label strip, off the agencies' captions
- Make the front page one picture: every camera as a light, coloured by the sun on it
- Smooth the front page, shrink its map, and let the wall show its score and its clock
- Calm a new camera's early scores, brighten the front page, and give the disclaimer a readable place
- Let the front-page map answer the pointer, open only from the country, and fade between views
- Fly into a city from the country map, and tune in to a camera rather than wait on it
- Bring the wall's tiles in one after another
- Keep the word Live for video: the map's cities read Watching or Ready
- Revert "Keep the word Live for video: the map's cities read Watching or Ready"
- Tell live video from a snapshot at a glance: a red Live pill against a grey framed Snapshot
- Read the vendor 511 developer API, and keep sources held under a private arrangement local
- Fill out the states rt511 already reads: 19 new cities and a wider Des Moines
- Measure the fast snapshots, clear the Scores tab, group the cities by state, and warm the daytime lights
- Bring the README and architecture notes up to what the wall now is
- Number published sources before local ones in the camera id space
- Run the checks and tests on GitHub for every push and pull request
- Test the wall's own logic with Vitest
- Drive the built wall in a browser on every change
- Keep the state facts in the data, and the scoring constants in one place
- Have the smoke test report an unexpected error with its cause
- Cut releases with make release
- Let Chrome exit before the smoke test removes its profile
- Stop committing the server build
- Show the front page, the country map and a wall in the README
- Open each release with a short summary written by hand

