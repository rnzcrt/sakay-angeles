# Sakay Angeles — Jeepney Route Explorer (prototype)

A mobile-friendly web prototype for exploring jeepney routes in Angeles City, Pampanga, Philippines, built around the supplied *HERE Angeles + Clark* route maps.

> **Honest status:** this is **not** a navigation service. The 11 route names/colors are transcribed from the legend image, but **no route has digitized geometry, verified stops, directions or transfers yet**. The app therefore lists and explains routes, lets you open the reference maps, and answers trip requests with *“We don't have enough verified route data to recommend a reliable trip yet.”* It never invents a route. It shows no live vehicle positions, arrival times, fares or authoritative directions.

## Stack
Vite · plain JavaScript modules · [MapLibre GL JS](https://maplibre.org/) · [OpenFreeMap](https://openfreemap.org/) public style (no API key) · static JSON/GeoJSON data · Node's built-in test runner.

**Free-service caveats**
- OpenFreeMap's public instance is provided as-is, can change or be discontinued, and has no SLA. MapLibre shows the required attribution automatically (repeated in the page footer). For anything operationally important, self-host or use a provider with a contract. Style URL: `src/config.js`.
- Public **Nominatim** has a usage policy (max 1 request/second, no autocomplete, cache results, identify your app). The app searches only on an explicit *Search* press, throttles to one request per 1.1 s, and caches results. Swap the provider in `src/services/geocoding.js` for production use.

## Quick start
Requires Node.js `^20.19` or `>=22.12` and npm.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # planner, validation, UI renderers, services
npm run validate:data
npm run build      # outputs dist/
npm run preview
```
`npm run dev:lan` exposes the dev server to your network (e.g. to test on a phone). Geolocation needs HTTPS or `localhost`.

## Route tracing tool
Open `/trace.html` (also linked from the app footer). **Each jeepney route has two parts: Route 1 and Route 2.**
1. Pick a route.
2. **Route 1 — going.** Your first click is the first terminal (the START). Click along the road to the end. Your last click is the new terminal.
3. **Route 2 — coming back.** Press **Start Route 2 where Route 1 ends**, click along the road back (it can be a different road), then press **Finish Route 2 at the start of Route 1**. If the way back is the same road, **Copy Route 1 backwards** does it in one click.
4. The panel checks that Route 2 starts where Route 1 ends and ends where Route 1 starts (✔ / ✖).
- Traced one long line by mistake? Click the turnaround point and press **Split here**: Route 1 ends there and the rest becomes Route 2.
- **Snap to roads** (on by default) routes between your clicks with the public OSRM demo server, which follows one-way streets from OpenStreetMap. It is for light use only; if it is unreachable the tracer falls back to a straight line and tells you. Change the provider in `ROUTING_CONFIG` (`src/config.js`). Clicks made while snapping is still working are queued, never dropped. **Detour guard:** if snapping would take a long way round (for example one-way or unconnected streets) the piece is drawn straight instead and you are told; **hold Option/Alt while clicking** to add a straight piece on purpose; an existing line with detours shows a warning and a **Straighten the detours** button.
- Drag a point to move it, double-click to delete. **Click a point to select it, then *Cut after the selected point*** to throw away everything after it and keep tracing from there.
- *Start over* clears every traced line; from then on the main app shows only the routes you have traced. Terminal names are optional.
- Export GeoJSON and replace `public/data/routes.geojson`. Drafts autosave in your browser, and the main app automatically uses the lines you traced in the same browser (with a notice and a *Use the shipped file instead* switch).
In the app, each part is ridden only in its traced order. When Route 1 and Route 2 join up (Route 1 ends where Route 2 starts and Route 2 ends where Route 1 starts) they are treated as one jeepney going round, so you can stay on board across the turnaround. Add `?offline` to either page for a blank basemap (testing).

## Switching the trip
The **⇅ Switch trip** button swaps start and destination and searches again. Routes are ridden in their traced order, so a switched trip uses Route 2 for the way back (or rides the jeepney round the loop the long way if that is the only way).

## Draft suggestions
Every route has a hand-traced draft line but none has verified stops, so when the verified planner has nothing to offer the app automatically falls back to `src/routing/draftPlanner.js`. It finds traced lines within 500 m of your start and destination, allows one connection where two lines come within 150 m, and ranks results by a **rough estimated time** (assumes ~4.5 km/h walking, ~12 km/h by jeepney and a few minutes' wait per ride; see `DRAFT_TIME` in `src/config.js`). Only the part of each line you would actually ride is drawn on the map, with dotted walking guides. Results are labelled *draft*, treat lines as one-way when they are marked `oneWay` (a closed loop may wrap around) and as two-way otherwise, give no stop names, and are **not** a substitute for verified data. The verified planner itself is unchanged and still refuses unverified data.

## Repository layout
```text
index.html                Vite entry
public/data/              routes.json · stops.json · routes.geojson (static data)
src/main.js               app wiring
src/config.js             map style, service area, planner and geocoder settings
src/data/                 validate.js (schema checks) · loadData.js
src/routing/              planner.js (verified graph planner) · draftPlanner.js (opt-in rough matcher) · geo.js
src/map/                  createMap.js · routeLayers.js
src/services/             geolocation.js · geocoding.js
src/trace.js · trace.html  route tracing tool (draft GeoJSON editor)
src/trace/                pure helpers for the tracer
src/ui/                   routeList.js · tripResults.js · notifications.js · referenceMaps.js · html.js
tests/                    node:test suites (+ synthetic fixtures)
assets/reference-maps/    the three supplied source images
docs/                     ROUTE_DATA_GUIDE.md · TEST_PLAN.md
.github/workflows/        GitHub Pages deployment
CLAUDE_PROMPT.md          the engineering brief this refactor followed
```

## Route data
Schema, verification workflow and rules are in [`docs/ROUTE_DATA_GUIDE.md`](docs/ROUTE_DATA_GUIDE.md). Every route, direction, stop and transfer carries `unverified | partially-verified | verified`. Validation (`npm run validate:data`, also run when the app loads) reports duplicate ids, broken references, bad coordinates, malformed GeoJSON and “verified” records that depend on unverified parts. If data fails validation the app says so instead of planning.

Source labels are preserved as printed (e.g. “SAPANG BATO - ANGLES”, “PANDANG - PAMPANG”); ambiguities are listed per route in `labelNotes` and shown in the route detail card. Map line colors are *display* colors, not official paint specs.

## How the planner works
`src/routing/planner.js` builds a graph from **verified** data only:
- nodes are stops; ride edges join consecutive stops of one *directional* route variant (nothing is assumed two-way);
- a transfer exists only at the **same verified stop id** or via an explicit verified `transfers` record — never from proximity or similar landmark names;
- your start/end snap to boarding/alighting stops within 500 m straight-line (configurable); a stop that cannot be boarded/alighted in the needed direction does not count;
- depth-first search up to 2 transfers (configurable), de-duplicated, ranked by **transfers → total walking → approximate ride distance → id**;
- outcomes: `success`, `no_verified_route`, `origin_too_far_from_stop`, `destination_too_far_from_stop`, `invalid_input`, `data_error`.

Distances are straight-line estimates. No travel times are produced.

## Privacy
Location is requested only after you press *Use my location*, is used in your browser, and is never sent to our code's servers (there are none). Place searches you submit are sent to Nominatim (OpenStreetMap). Map tiles are fetched from OpenFreeMap.

## Deploy to GitHub Pages
`vite.config.js` uses `base: './'`, so the build works under a repository sub-path.
1. Push to GitHub (branch `main`).
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) runs tests, builds and deploys `dist/`.

If you prefer an absolute base, set `base: '/<repo-name>/'` in `vite.config.js`.

## Troubleshooting
- **Blank/grey map:** check the console and network tab for `tiles.openfreemap.org`; WebGL must be enabled. The page shows a banner or fallback and stays usable.
- **Geolocation fails:** allow location for the site; use `https://` or `localhost`; otherwise search or pick on the map.
- **Missing tiles:** the public service may be rate-limited or down; retry later or self-host.
- **“No verified route” results:** expected until real verified data is added (see the data guide).
- **No route lines on the map:** no geometry has been digitized yet.

## Source images and rights
The route names, colors and landmark lists come from the supplied “HERE Angeles + Clark — Angeles City Jeepneys” maps, credited on the schematic to **© 2021 Ray Haffenden / WayGo Maps**. **Permission to republish these images has not been confirmed — confirm it before any public release.** The schematic also shows lines that are not in the legend (e.g. Clark loop bus, Balibago–Marquee Mall shuttle); they are not modelled. No license is set yet; add one once code and data ownership are clear.
