# Sakay Angeles — Jeepney Route Explorer (prototype)

[![Project status: prototype](https://img.shields.io/badge/status-prototype-7A8F5A)](#)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B%20%7C%2022.12%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20modules-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![MapLibre GL JS](https://img.shields.io/badge/MapLibre-GL%20JS-396CB2)](https://maplibre.org/)
[![AI-assisted with ChatGPT](https://img.shields.io/badge/AI%20assistance-ChatGPT-74AA9C)](chatgpt.md)

A mobile-friendly web prototype for exploring jeepney routes in Angeles City, Pampanga, Philippines, built around the supplied *HERE Angeles + Clark* route maps.

> **Honest status:** this is **not** a navigation service. The A/B terminal endpoints on the supplied route traces are verified from the project owner's real-world observations. The traced path between endpoints, intermediate boarding/drop-off points, service directions, and transfers still need verification. The app shows those limits in trip suggestions and does not show live vehicles, arrival times, fares or authoritative directions.

## Stack
Vite · plain JavaScript modules · [MapLibre GL JS](https://maplibre.org/) · [OpenFreeMap](https://openfreemap.org/) public style (no API key) · static JSON/GeoJSON data · Node's built-in test runner.

**Free-service caveats**
- OpenFreeMap's public instance is provided as-is, can change or be discontinued, and has no SLA. MapLibre shows the required attribution automatically (repeated in the page footer). For anything operationally important, self-host or use a provider with a contract. Style URL: `src/config.js`.
- Public **Nominatim** has a usage policy (max 1 request/second, no autocomplete, cache results, identify your app). The app searches only on an explicit *Search* press, throttles to one request per 1.1 s, and caches results. Swap the provider in `src/services/geocoding.js` for production use.

## Quick start
Requires Node.js `^20.19` or `>=22.12` and npm.

```bash
npm install
npm run dev        # http://localhost:5173 (requires the configured Node API server)
npm test           # planner, validation, UI renderers, services
npm run validate:data
npm run build      # outputs dist/
npm start          # authenticated production server at http://localhost:4173
```
`npm run dev:lan` exposes the dev server to your network (e.g. to test on a phone). Geolocation needs HTTPS or `localhost`.

## Route tracing tool
Route management is served by the Node server at `/admin/routes`. The route tracer is available at `/trace.html` after GitHub sign-in. **Never deploy `dist/` as a static site:** authentication, protected writes, route persistence, and history are enforced by `server.js`.

Configure a GitHub OAuth App with callback URL `<BASE_URL>/auth/callback`, then set these environment variables on the server:

```text
BASE_URL="http://localhost:3000"
GITHUB_CLIENT_ID="set-in-your-deployment-environment"
GITHUB_CLIENT_SECRET="set-in-your-deployment-environment"
SESSION_SECRET="set-in-your-deployment-environment"
ADMIN_GITHUB_USERS="rnzcrt"
```

The allowlist is checked on every OAuth login; credentials and OAuth tokens stay on the server. Admin sessions use HttpOnly, SameSite cookies and expire after 12 hours. Use a random `SESSION_SECRET` with at least 32 bytes. If OAuth is not configured, admin access remains disabled.

Route data and revision history live in the separate private `sakay-angeles-data` GitHub repository. Configure a fine-grained GitHub token with Contents read/write access only to that repository, plus these server environment variables:

```text
SAKAY_DATA_GITHUB_TOKEN="set-in-your-deployment-environment"
SAKAY_DATA_GITHUB_OWNER="repository-owner"
SAKAY_DATA_GITHUB_REPO="sakay-angeles-data"
SAKAY_DATA_GITHUB_BRANCH="main"
```

For local preflight and migration preview, put these four settings in the repository-root `.env` file using the same variable names and your own GitHub values. `.env` and `.env.*` are ignored by Git. The CLI commands load `.env` with Node's built-in environment-file support (Node 20.19+); variables already supplied by the shell take precedence. Do not commit or share the file. The migration preview and preflight remain read-only.

The token is used only by the Node server. The public website reads validated data through `/api/routes`; route edits and restores create single Git commits containing all three data files and an audit record. Writes compare the loaded branch commit SHA and reject stale edits. The server keeps a short in-memory cache and reloads the branch after restart. Local `public/data` files remain the reviewed migration and validation input; runtime reads and writes do not fall back to them.

For local development, build and start the Node server in one terminal (`npm run build && npm start`), then run `npm run dev` in another. The Vite API proxy forwards data and admin requests to the Node server.

Before migration or deployment, configure the four storage settings and run `npm run data:preflight`. This read-only command verifies GitHub authentication, the private repository, configured branch, and readability of all three route-data files; it reports status and commit SHA without showing private file contents or credentials. The Node server does not run this check during startup, so a GitHub outage does not prevent the server from starting. Route API requests still fail safely when remote data cannot be read, with no local-file fallback.

For first migration, run `npm run migrate:data:preview`. Its read-only report identifies the configured owner, repository, branch, current target branch SHA when available, repository/branch access, route-file presence, and whether the result would create files, make no changes, or be blocked. Review the target and validation report, then run `npm run migrate:data:apply` only when the configured private branch has no conflicting route dataset. The apply command creates a recoverable local backup under `.route-data-backups/` before committing. An exact repeat is a no-op; differing remote route data is never overwritten.

The application applies per-process rate limits to OAuth and admin writes. If running multiple instances, use a shared rate-limit store or an edge rate limit; the built-in limits do not coordinate between instances. Rate-limit keys use the direct socket address; forwarded client-IP headers are not trusted because the deployment's proxy-header chain has not been verified. `TRUST_PROXY_CLIENT_IP` is not supported.

Security response headers are set by the Node server. Keep the Node server in front of `dist/`; do not serve the build directly from static hosting because that bypasses protected route APIs and these headers.

Credential hygiene: older README revisions in the repository history contained credential-like values assigned to `GITHUB_CLIENT_SECRET` and `SESSION_SECRET`. Treat those historical values as exposed: rotate the GitHub OAuth client secret in GitHub, then update the Render environment variable, and replace `SESSION_SECRET` with a new random value of at least 32 bytes. Rotating the session secret logs out existing admin sessions. The repository history was not rewritten as part of the audit.

**Each jeepney route has two parts: Route 1 and Route 2.**
1. Pick a route.
2. **Route 1 — going.** Your first click is the first terminal (the START). Click along the road to the end. Your last click is the new terminal.
3. **Route 2 — coming back.** Press **Start Route 2 where Route 1 ends**, click along the road back (it can be a different road), then press **Finish Route 2 at the start of Route 1**. If the way back is the same road, **Copy Route 1 backwards** does it in one click.
4. The panel checks that Route 2 starts where Route 1 ends and ends where Route 1 starts (✔ / ✖).
- Traced one long line by mistake? Click the turnaround point and press **Split here**: Route 1 ends there and the rest becomes Route 2.
- **Snap to roads** (on by default) routes between your clicks with the public OSRM demo server, which follows one-way streets from OpenStreetMap. It is for light use only; if it is unreachable the tracer falls back to a straight line and tells you. Change the provider in `ROUTING_CONFIG` (`src/config.js`). Clicks made while snapping is still working are queued, never dropped. **Detour guard:** if snapping would take a long way round (for example one-way or unconnected streets) the piece is drawn straight instead and you are told; **hold Option/Alt while clicking** to add a straight piece on purpose; an existing line with detours shows a warning and a **Straighten the detours** button.
- Drag a point to move it, double-click to delete. **Click a point to select it, then *Cut after the selected point*** to throw away everything after it and keep tracing from there.
- Terminal names are optional. Route metadata and stops can be managed from the private dashboard.
- Review the dashed geometry in the tracer preview, complete the required change record, then publish. The server validates and commits the complete route dataset with an audit record. Git history provides revisions and restore creates a new commit; editing geometry or directions keeps them unverified. Feedback never changes routes by itself.
In the app, each part is ridden only in its traced order. When Route 1 and Route 2 join up (Route 1 ends where Route 2 starts and Route 2 ends where Route 1 starts) they are treated as one jeepney going round, so you can stay on board across the turnaround. Add `?offline` to either page for a blank basemap (testing).

## Switching the trip
The **⇅ Switch trip** button swaps start and destination and searches again. Routes are ridden in their traced order, so a switched trip uses Route 2 for the way back (or rides the jeepney round the loop the long way if that is the only way).

## Draft suggestions
Every route has a hand-traced line and verified terminal endpoints, but intermediate stops and directions are not modelled as a verified stop sequence. When the verified planner has nothing to offer the app automatically falls back to `src/routing/draftPlanner.js`:
- The route line displays immediately; pedestrian routing updates distances and times in the background. Walking access/egress is capped at 1.8 km, and route-to-route transfers are considered within 500 m.
- **Order of options:** after the walking legs are routed over the pedestrian network, options are ranked by estimated door-to-door time. The displayed walk distance and directions use the pedestrian route when available.
- **Same side of the road:** the boarding and drop-off points are shifted about 10 m (`kerbMeters`) toward you / your destination, so the stop is on your side of the road.
- Draft suggestions search the full traced-line network and can chain any number of distinct jeepney routes. A possible transfer is inferred when different route lines come within 150 m; it is not a verified stop or transfer. Route 1 + Route 2 that join up act as one jeepney going round.
- Walking legs request pedestrian paths and turn instructions from the public OSRM foot router (`WALKING_ROUTING_CONFIG`). A straight-line guide is used if the service is unavailable. The public router is for light use; self-host or use a contracted service for production.
- The app searches OpenStreetMap for nearby mapped crossings, footbridges and underpasses. It offers walking directions through mapped facilities and marks them on the map; mapping coverage and real-world access must still be checked. [OpenStreetMap crossing tags](https://wiki.openstreetmap.org/wiki/Key:crossing) · [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API).
Results are labelled *draft*. Terminal locations are shown as verified; boarding/drop-off points along the line and transfers are estimates. This is not a substitute for a fully surveyed stop sequence. The verified planner itself is unchanged and still requires ordered verified stop data.

## Repository layout
```text
index.html                Vite entry
public/data/              local migration/validation input (not runtime storage)
src/main.js               app wiring
server.js                 GitHub OAuth, admin authorization, public/admin data APIs
src/security/             rate limits · private GitHub data storage
admin.html · src/admin.js private route dashboard, stops, feedback and history
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
.github/workflows/        CI validation and build (no static deployment)
chatgpt.md                AI assistance and project attribution
```

## Route data
Schema, verification workflow and rules are in [`docs/ROUTE_DATA_GUIDE.md`](docs/ROUTE_DATA_GUIDE.md). Every route, direction, stop and transfer carries `unverified | partially-verified | verified`. Validation (`npm run validate:data`, also run when the app loads) reports duplicate ids, broken references, bad coordinates, malformed GeoJSON and “verified” records that depend on unverified parts. If data fails validation the app says so instead of planning.

Source labels are preserved as printed (e.g. “SAPANG BATO - ANGLES”, “PANDANG - PAMPANG”); ambiguities are listed per route in `labelNotes` and shown in the route detail card. Map line colors are *display* colors, not official paint specs.

## How the planner works
`src/routing/planner.js` builds a graph from **verified** data only:
- nodes are stops; ride edges join consecutive stops of one *directional* route variant (nothing is assumed two-way);
- a transfer exists only at the **same verified stop id** or via an explicit verified `transfers` record — never from proximity or similar landmark names;
- your start/end snap to boarding/alighting stops within 500 m straight-line (configurable); a stop that cannot be boarded/alighted in the needed direction does not count;
- depth-first search up to 10 transfers for this 12-route dataset, de-duplicated, ranked by total estimated time and then walking/transfer count;
- outcomes: `success`, `no_verified_route`, `origin_too_far_from_stop`, `destination_too_far_from_stop`, `invalid_input`, `data_error`.

Distances are straight-line estimates. No travel times are produced.

## Privacy
Location is requested only after you press *Use my location* and is used in your browser. Place searches you submit are sent to Nominatim (OpenStreetMap); map tiles are fetched from OpenFreeMap. Route data is served by this project's Node server. GitHub OAuth tokens are kept in server memory and are used only for administrator access and report moderation.

## AI Assistance & Credits
ChatGPT assisted the project maintainer with brainstorming and planning, code development and implementation guidance, debugging and troubleshooting, UI/UX improvements, documentation and README writing, and security reviews and testing guidance. The maintainer directed the project, made the decisions, reviewed and tested suggestions and code, and chose what to integrate. ChatGPT is an AI assistant; it is not the owner or creator of Sakay Angeles. See [`chatgpt.md`](chatgpt.md) for fuller attribution details.

## Deployment
Deploy the repository to a Node.js host that supports environment secrets, then run `npm ci`, `npm run build`, and `npm start`. Static hosting such as GitHub Pages cannot enforce the administrator boundary or serve the private-repository-backed APIs, so the GitHub workflow only validates and builds. Set `BASE_URL` to the public HTTPS origin, configure the OAuth variables and the four private data repository variables above, and complete the explicit data migration before enabling route management.

## Troubleshooting
- **Blank/grey map:** check the console and network tab for `tiles.openfreemap.org`; WebGL must be enabled. The page shows a banner or fallback and stays usable.
- **Geolocation fails:** allow location for the site; use `https://` or `localhost`; otherwise search or pick on the map.
- **Missing tiles:** the public service may be rate-limited or down; retry later or self-host.
- **“No verified route” results:** expected until real verified data is added (see the data guide).
- **No route lines on the map:** no geometry has been digitized yet.

## Source images and rights
The route names, colors and landmark lists come from the supplied “HERE Angeles + Clark — Angeles City Jeepneys” maps, credited on the schematic to **© 2021 Ray Haffenden / WayGo Maps**. **Permission to republish these images has not been confirmed — confirm it before any public release.** The schematic also shows lines that are not in the legend (e.g. Clark loop bus, Balibago–Marquee Mall shuttle); they are not modelled. No license is set yet; add one once code and data ownership are clear.
