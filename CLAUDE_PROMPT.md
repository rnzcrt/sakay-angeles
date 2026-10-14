# Master Prompt for Claude — Build Sakay Angeles Properly

Copy the entire prompt below into Claude Code or Claude with this repository attached. Ask Claude to edit the repository itself, not merely explain what it would do.

---

## ROLE

Act as a senior full-stack engineer, geospatial developer, UX designer, and test engineer. You are working on **Sakay Angeles**, a commuter-focused jeepney route finder for **Angeles City, Pampanga, Philippines**. The repository contains an initial MapLibre/OpenFreeMap prototype, a README, and three user-provided HERE Angeles + Clark jeepney route-map images under `assets/reference-maps/`.

Your job is to turn the prototype into a clean, maintainable, accessible, mobile-first project that can be pushed to GitHub and later deployed publicly. Work directly in the repository. Do not stop after giving advice or a code sample.

## PRODUCT GOAL

A commuter should be able to:

1. Explore all available jeepney routes in the Angeles City area before entering a trip.
2. Set the starting point using browser geolocation (only after an explicit click and browser permission), place search, or map click.
3. Set the destination using place search or map click.
4. Receive a transparent recommendation for a direct jeepney ride or a route with one or more **verified** transfers.
5. See the actual jeepney route name, the jeepney's color as listed in the supplied legend, boarding stop, alighting stop, transfer point, and walking connections where available.
6. Explore individual routes and inspect their ordered stops and source/verification status.
7. Use the site on a phone or desktop, including when location permission is denied.

The project is initially a prototype and must clearly distinguish verified facts from incomplete data. Do not claim live jeepney locations, live arrival times, exact travel times, or authoritative directions unless a real data source supports them.

## CURRENT SCREENSHOT / BUG CONTEXT

The current prototype has a decent starting layout: left search/route sidebar and right map. However, the displayed route paths look like angular lines cutting across roads and neighborhoods instead of following the road network. This is because the coordinates in `index.html` are illustrative map anchors, not digitized route geometry. The route suggestion logic picks nearby route vertices and matches route landmark strings; if there is no shared stop it can still show a two-jeepney combination. That can invent invalid transfers and is the most serious functional defect.

Fix the underlying data model and route-planning logic rather than only polishing CSS. A visually attractive but geographically false itinerary is unacceptable.

## SOURCE ROUTE INFORMATION

The user supplied three images:

- `assets/reference-maps/route-schematic.jpeg`: colored schematic lines and landmark/road labels.
- `assets/reference-maps/route-geographic-map.jpeg`: geographic context and roads/areas.
- `assets/reference-maps/route-legend.jpeg`: route names, color names, and textual route descriptions.

The legend appears to list these routes and colors:

1. `M Gate – Friendship` — Sand
2. `C'Point – Balibago – Hi'way` / `Checkpoint – Balibago – Highway` — Grey
3. `C'Point – Hensonville – Holy Rosary Church` — White
4. `SM – C'Point – Holy – Hi'way` — Lavender
5. `Clark – Main Gate – Dau` — Steel
6. `Marisol – Pampanga` — Green
7. `Sapang Bato – Angles` (the image may mean Angeles; preserve a source label and flag the spelling for verification) — Maroon
8. `Pandang – Pampanga` — Blue
9. `Sunset – Nepo` — Orange
10. `Villa – Pampanga` — Yellow
11. `Capaya – Angeles` — Pink

Preserve the legend's color names and route labels in the UI. If the text in the image is ambiguous, note the ambiguity in data rather than silently asserting a correction. The exact display color hex values can be selected for visibility, but label them as **map display colors** and do not imply that a map hex code is an official paint specification for a real jeepney.

Route descriptions in the source image include landmarks such as Main Gate, Checkpoint, Friendship/Korea Town, Fields Avenue, Johnnies, Marlim, SR Lim, Robinsons, Marisol, AUF, Kuliat, Lakandula, HAU, Holy Angel University, Jenra Mall, Plaridel, San Nicolas, Pampanga Market, Richtofen/Crossing, Sapang Bato, Margot, Anunas, Timog Park, Carmenville, City College, Kalayaan, Sunset, 1976, Initial, Champaca, Nepo Mart, SM, Telebastagan, L&S, Villa Angela, Villa Gloria, Villa Angelina, Bale Herencia, Rizal, Pamintuan Residence, City Hall, Mining, MacArthur, and Holy Rosary Church. Treat these as source landmarks, not proof of exact stop coordinates or order unless supported by the source and subsequently verified.

## CRITICAL GEOSPATIAL DATA RULES

1. Do not convert pixels from a screenshot directly into latitude/longitude without a georeferencing process.
2. Do not draw approximate straight-line segments and describe them as actual jeepney roads.
3. Do not infer a valid transfer because two routes are close or because landmark names look similar.
4. Do not invent stops, stop coordinates, legal boarding points, travel times, fares, service frequency, or live vehicle locations.
5. Create a data model that supports route and stop verification states: `unverified`, `partially-verified`, `verified`.
6. Until route geometry is verified, display it as an explicitly labeled **illustrative draft** (or hide draft geometry from journey calculations). Do not let unverified draft geometry generate authoritative recommendations.
7. If verified route data is missing, show an honest state such as “We don't have enough verified route data to recommend a reliable trip yet.” Let the user still explore the route list and reference maps.
8. Add visible source attribution and a note that source-map reuse permissions must be confirmed before public release.

## REQUIRED TECHNICAL DIRECTION

Keep the stack simple and suitable for a student/early-stage project:

- Vite + modern JavaScript modules.
- MapLibre GL JS for the interactive map.
- OpenFreeMap public style for initial development, with the style URL and attribution centralized in configuration.
- GeoJSON for line geometry.
- JSON for stops and route metadata if separating it from GeoJSON is useful.
- No paid API key required for the initial map display.
- No backend is required for the first version; route data can be static files. If you propose a backend, justify why it is necessary and do not make it a blocker for the prototype.
- Keep dependencies small and maintained. Avoid a heavy framework unless there is a clear benefit.

Check current MapLibre/OpenFreeMap documentation and service terms if web access is available. Do not assume a public tile endpoint has unlimited capacity or a permanent SLA. Keep attribution visible and document the service's limits.

## REQUIRED PROJECT STRUCTURE

Refactor toward a structure like this (adjust if there is a strong reason):

```text
sakay-angeles-project/
├── index.html
├── package.json
├── README.md
├── CLAUDE_PROMPT.md
├── .gitignore
├── public/
│   └── data/
│       ├── routes.geojson
│       ├── routes.json
│       └── stops.json
├── src/
│   ├── main.js
│   ├── styles.css
│   ├── config.js
│   ├── map/
│   │   ├── createMap.js
│   │   └── routeLayers.js
│   ├── routing/
│   │   ├── planner.js
│   │   └── geo.js
│   ├── services/
│   │   ├── geocoding.js
│   │   └── geolocation.js
│   └── ui/
│       ├── routeList.js
│       ├── tripResults.js
│       └── notifications.js
├── assets/reference-maps/
└── docs/
    ├── ROUTE_DATA_GUIDE.md
    └── TEST_PLAN.md
```

If you keep the prototype in a single file temporarily, still separate route data and routing logic into modules before declaring the project complete.

## ROUTE DATA SCHEMA

Design and document a robust schema. Example only; coordinates and stop IDs below are placeholders, not real data:

```json
{
  "id": "marisol-pampanga",
  "name": "Marisol – Pampanga",
  "sourceLabel": "MARISOL - PAMPANG",
  "jeepneyColorName": "Green",
  "displayColor": "#16834A",
  "geometryStatus": "unverified",
  "source": "user-provided route legend image",
  "directions": [
    {
      "id": "marisol-pampanga-outbound",
      "label": "Marisol to Pampanga",
      "orderedStopIds": ["stop-001", "stop-002"],
      "geometryId": "marisol-pampanga-outbound"
    }
  ]
}
```

Stops should have stable IDs, names, coordinates in `[longitude, latitude]` order, verification status, and optional notes. Route geometry should be valid GeoJSON. Model both directions separately when route order or road geometry differs by direction.

Never use the example coordinates in this prompt as actual Angeles City data. Add schema validation and useful errors for missing stops, invalid coordinates, duplicate IDs, broken references, and malformed GeoJSON.

## ROUTE-PLANNING ALGORITHM

Replace the existing heuristic. Implement a small, testable graph-based planner:

- Build a graph from **verified** route directions and ordered stops.
- Ride edges connect consecutive stops on the same route direction.
- A transfer is permitted only when route directions share the same verified stop ID, or when an explicit transfer record connects two stops with a verified walking path/distance.
- Origin and destination should be snapped to suitable verified stops only within a configurable walking radius. Explain walking assumptions to the user.
- Find candidate paths with a graph algorithm (BFS for fewest edges/transfers on a small unweighted graph, or Dijkstra with explicit weights). Prefer fewer transfers, then reasonable access/egress walking distance and route distance. Make ranking rules explicit and testable.
- A direct journey must follow the ordered route direction from a boarding stop to a later alighting stop.
- Do not assume every route is bidirectional.
- Bound the search to a reasonable number of transfers (configurable, e.g. 2) to avoid confusing itineraries.
- Deduplicate equivalent itineraries and present the best few alternatives.
- Return structured outcomes: `success`, `no_verified_route`, `origin_too_far_from_stop`, `destination_too_far_from_stop`, `invalid_input`, or `data_error`.
- Never silently return a made-up route if no connection exists.
- If the data currently has no verified route geometry/stops, the planner should safely return `no_verified_route` and the UI should explain why. Do not seed fake verified coordinates just to make demo results appear successful.

Travel-time ranking is optional. If added, make the assumed speeds/dwell times configurable and label the output as an estimate. Do not claim live traffic or vehicle arrival data.

## MAP UX REQUIREMENTS

- Initial view centered on the Angeles City/Clark area at an appropriate zoom, with bounds fitted to available route geometry.
- Show all routes by default when their geometry is available. Distinguish verified routes from draft/unverified ones with a legend and/or dash style.
- White route must have a contrasting casing so it remains visible on a light basemap.
- Clicking a route highlights it and shows its name, jeepney color label, route description, source, and verification state.
- Route visibility checkboxes must not accidentally select a route or toggle when the user clicks unrelated controls.
- “Show all,” “Hide all,” “Fit routes,” and “Clear trip” must work.
- When a trip is found, emphasize only the recommended itinerary while retaining a way to reveal the whole network.
- Add origin and destination markers with clear labels.
- The map selection control should have an obvious state: choose origin, then destination, cancel selection. Avoid accidental map picks while panning.
- Include loading, error, empty, and no-results states.
- Do not show a successful route recommendation until the graph planner returns a valid path from verified data.

## SEARCH AND LOCATION REQUIREMENTS

- Use browser geolocation only in response to a user click. Handle denied permission, timeout, unavailable device, and insecure-origin errors with helpful messages.
- Manual input must always remain available.
- Add map-click selection for origin and destination.
- Geocoding must be debounced if autocomplete is implemented; do not send a request on every keystroke.
- Scope searches to Angeles City/Pampanga when possible, but let users understand when a result falls outside the supported service area.
- The public Nominatim service has a usage policy and is not an unlimited autocomplete service. For the prototype, use explicit submit/search rather than aggressive autocomplete. Include attribution and a clear provider adapter so the provider can be replaced.
- Handle network errors, empty results, ambiguous place names, and results outside the service area.
- Do not store or transmit a user's precise location unless necessary and clearly disclosed.

## DESIGN / ACCESSIBILITY REQUIREMENTS

- Keep the current clean green-and-white visual direction, but refine spacing and hierarchy.
- Mobile-first: on narrow screens, place the map and trip planner in a usable stacked layout. Ensure inputs and buttons are easy to tap.
- Desktop: sidebar + large map is fine.
- Use semantic headings, labels, buttons, focus indicators, keyboard support, and accessible status/error announcements.
- Do not rely on route color alone; show route name and color text. Use a casing/outline so white and pale colors remain visible.
- Avoid tiny text for critical trip instructions.
- Respect reduced-motion preferences where relevant.
- Ensure the app remains understandable if geolocation is denied or map tiles fail.

## TESTS REQUIRED

Add automated tests for planner logic using Node's built-in test runner or a lightweight test framework. At minimum test:

1. Direct route exists when origin and destination stops are served in the correct order.
2. Direct route is rejected if destination stop occurs before origin in a one-way route direction.
3. One-transfer itinerary works at a verified shared stop.
4. No transfer is invented when two routes are merely close geographically.
5. Unverified routes are excluded from route calculations.
6. No verified route returns a clear no-route result.
7. Origin/destination too far from all stops returns a clear error.
8. Broken stop references and malformed coordinates are caught by validation.
9. Route color/name rendering uses the metadata and not hard-coded duplicated values.
10. The app handles geolocation denial and geocoding network errors.

Add a manual browser test checklist for desktop and mobile, including the screenshot problem that triggered this work.

## DOCUMENTATION REQUIRED

Update `README.md` so a new contributor can clone, install, run, test, build, and deploy the project. Include:

- Project purpose and honest prototype limitations.
- Tech stack and free-service caveats.
- Prerequisites and exact commands.
- Repository tree.
- Route data schema and how to add/edit routes.
- How to digitize/verify routes and stops.
- How the route graph and transfer logic works.
- Location privacy behavior.
- OpenFreeMap/MapLibre attribution and Nominatim usage limitations.
- GitHub Pages deployment steps, including Vite base path configuration for a repository site.
- Troubleshooting for blank map, geolocation permission, missing tiles, and no verified route results.
- Source image reuse rights caveat.

Add `docs/TEST_PLAN.md` with test cases and acceptance criteria.

## GITHUB / QUALITY REQUIREMENTS

- Keep `.gitignore` appropriate; never commit `node_modules`, build artifacts, or secrets.
- Include useful npm scripts: `dev`, `build`, `preview`, and `test`.
- Run tests and production build, and fix failures.
- Keep browser console clean; no uncaught exceptions.
- Use relative asset paths that work on GitHub Pages subpaths.
- Do not introduce paid services or secrets without asking first.
- Do not claim that real routes have been digitized or validated if they have not.
- Do not invent a GitHub repository URL or claim to have pushed code unless you actually have repository access and performed the push.

## DEFINITION OF DONE

The task is done when:

1. The repository has a maintainable structure and the app starts with `npm install && npm run dev`.
2. `npm run build` succeeds.
3. `npm test` succeeds.
4. All 11 route records from the supplied legend exist with source labels and color names.
5. Unverified geometry is clearly marked and is not used to generate misleading journey recommendations.
6. The planner only recommends journeys supported by verified stops, ordered directions, and valid transfer edges.
7. Empty/no-route/error states are understandable and do not invent a route.
8. Desktop and mobile layouts are usable.
9. README and test plan are complete.
10. The final response summarizes changed files, commands run, remaining real-world data gaps, and exactly what the user must do next to verify route data.

## HOW TO WORK

First inspect the existing files and the three reference images. Then implement the changes directly. Do not ask me to manually write code that you can write. If geographic facts are unavailable, build the data schema, route validation, UI states, and safe planner now, and clearly leave coordinates/stops marked unverified rather than fabricating them. Finish by running the tests and build and reporting their real results.

---
