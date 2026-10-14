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
Open `/trace.html` (also linked from the app footer). Pick a route and a direction (**A** or **B**). **Your first click is the START (the terminal) and your last click is the END** — marked S and E on the map — so there is nothing to type. Click along the road in the order the jeepney travels. **Start over** clears every traced line; from then on the main app shows only the routes you have traced (use *Use the shipped file instead* in the app to go back).
- **Two directions per route.** Jeepney routes are often one-way circuits whose way back uses different roads, so trace each direction separately. *Copy A reversed to B* gives you a starting point to edit.
- **Snap to roads** (on by default) routes between your clicks with the public OSRM demo server, which follows one-way streets from OpenStreetMap. It is for light use only; if it is unreachable the tracer falls back to a straight line and tells you. Change the provider in `ROUTING_CONFIG` (`src/config.js`).
- Drag a point to move it, double-click to delete. Terminal names are optional (under *Optional: add terminal names*) and saved in the export.
- A route list badge warns **⚠ goes back over itself** when a line retraces the same road (out-and-back), which usually means the return trip needs its own Direction B line.
- Export GeoJSON and replace `public/data/routes.geojson`. Each feature has `direction` (`a`/`b`) and `oneWay`. Files with no direction info (older exports) are treated as **two-way** lines.
Drafts autosave in your browser, and **the main app automatically uses the lines you traced in the same browser** (it shows a notice with a *Use the shipped file instead* switch). To share or keep them, export and replace `public/data/routes.geojson`; clearing browser data deletes unsaved drafts. Add `?offline` to either page for a blank basemap (testing).

## Switching the trip
The **⇅ Switch trip** button swaps start and destination and searches again. With one-way lines the way back only uses a line traced for that direction (Direction B), never the same road in reverse.

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
