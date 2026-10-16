# Test plan

Run automated tests with `npm test` (Node built-in runner, no extra dependencies). All planner fixtures are **synthetic** (placed near 0°,0°) and say nothing about Angeles City.

## Automated tests

| # | Requirement | Where |
|---|---|---|
| 1 | Direct route in correct stop order | `tests/planner.test.js` |
| 2 | Reverse order rejected on one-way direction (and OK if a reverse direction exists) | planner |
| 3 | One transfer at a verified shared stop | planner |
| 4 | No transfer from proximity alone; explicit verified transfer record works; unverified record ignored | planner |
| 5 | Unverified routes/directions/stops excluded | planner |
| 6 | No verified data → `no_verified_route` (also on shipped data) | planner, `data.test.js` |
| 7 | Origin/destination too far → distinct statuses | planner |
| 8 | Broken refs, bad coordinates, duplicate ids, malformed GeoJSON | `validate.test.js`, planner `data_error` |
| 9 | Route name/color rendered from metadata; no hard-coded duplicates in `src/ui`, `src/routing`, `src/map` | `ui.test.js` |
| 10 | Geolocation denied/timeout/unsupported/insecure; geocoding network/HTTP/timeout errors, caching, throttling | `services.test.js` |
| – | Transfer limit; ranking and de-duplication; shipped data has all 11 routes and stays unverified | planner, `data.test.js` |

Also run `npm run validate:data` and `npm run build`.

## Manual browser checklist

Test at 360, 390, 768, 1024 px and a wide desktop; Chrome/Edge, Firefox and Safari (iOS) if possible.

### Map and routes
- [ ] Map loads; attribution visible; legend explains solid = verified, dashed = draft.
- [ ] All 11 routes appear in the list with name and color **text**.
- [ ] Selecting a route shows its detail card (color label, source label, landmarks, verification state, items to verify). Routes without geometry say so; nothing is drawn for them.
- [ ] Show all / Hide all / Fit routes work (Fit says there is nothing to fit when no lines exist). Toggling a checkbox never selects a route and vice versa.
- [ ] **Original bug check:** no angular lines cut across neighborhoods; with the shipped data no route lines are drawn at all.
- [ ] Block `tiles.openfreemap.org` in dev tools: a banner explains the map failed; list, search and reference maps still work.
- [ ] With WebGL disabled the fallback message appears and the rest of the page works.
- [ ] Reference-map thumbnails open full-size images.

### Inputs and location
- [ ] Empty search shows a hint; Enter submits a search; no request is sent while typing.
- [ ] Multiple matches show a choice list; out-of-area results are tagged.
- [ ] “Use my location” asks permission only after the click; deny → helpful message, manual input still works. On plain `http://` (non-localhost) shows the secure-origin message.
- [ ] “Pick on map” (per field) shows a banner with Cancel; Esc cancels; dragging the map does not set a point.
- [ ] Editing a field text clears the old marker; Clear trip removes markers and results.

### Planner honesty
- [ ] With shipped data, Find route → “No verified route yet” explanation and no jeepney sequence.
- [ ] With a local, clearly-labelled test dataset (see below) results show route name, color name, boarding stop, alighting stop, transfer point and walking estimates; other routes are dimmed/hidden until “Show the whole network”.
- [ ] Walking and ride distances are labelled as straight-line estimates; no ETAs, fares or live positions anywhere.

### Route tracer (`/trace.html`)
- [ ] Clicking the map with no route selected shows a hint, not a point.
- [ ] Select a route, click 4+ points: dashed line and numbered-length stats update; points can be dragged; double-click deletes without adding a new point.
- [ ] Undo / Clear / Reverse work; reload the page and the drafts are still there.
- [ ] Export downloads `routes.geojson`; after replacing `public/data/routes.geojson` the main app draws the line dashed and still says "No verified route yet" for trips.
- [ ] Import of a previously exported file restores the lines.
- [ ] Optional terminal names survive export/import.
- [ ] Snap to roads follows streets and respects one-way streets; with networking blocked it falls back to a straight line with a message.
- [ ] Out-and-back lines show the ⚠ badge and warning; a true loop shows the loop note.
- [ ] In the main app, a one-way line is not suggested for the opposite direction (unless it is a closed loop).

### Route 1 and Route 2
- [ ] Trace Route 1, then *Start Route 2 where Route 1 ends* puts Route 2's first point exactly on Route 1's last point.
- [ ] *Finish Route 2 at the start of Route 1* ends Route 2 on Route 1's first point; the panel shows ✔ ✔.
- [ ] *Copy Route 1 backwards* creates Route 2 on the same road; cut and re-trace where the way back differs.
- [ ] A single long line that returns to its start shows a warning; selecting the turnaround point and pressing *Split here* makes Route 1 and Route 2.
- [ ] In the main app, Route 1 + Route 2 that join up appear as one jeepney loop; the switched trip uses Route 2 for the way back.

### Editing a route
- [ ] Click six points quickly: all six are recorded (the panel shows a working note while snapping).
- [ ] Select a point → *Cut after the selected point* removes the later points; new clicks continue from there.

### Start / end tracing
- [ ] First click shows an **S** marker and the hint says it is the start; the last point shows **E**; no typing is required.
- [ ] *Start over* clears all lines; the main app then lists only the routes traced since, with a notice.

### Switch trip and local drafts
- [ ] After tracing in `/trace.html`, reload the main app: the notice lists the routes taken from the tracer and the map shows the new lines.
- [ ] *Use the shipped file instead* reverts and *Use my traced lines* restores them.
- [ ] ⇅ Switch trip swaps the fields and markers and re-runs the search; on a loop route the switched trip rides the loop in its traced order (often the longer way round).
- [ ] Lines traced as “both ways” show the “Check the way back” warning.

### Accessibility
- [ ] Full keyboard operation; visible focus ring; skip link works.
- [ ] Status/error messages are announced (screen reader or inspect `aria-live` regions).
- [ ] Route identity is never color-only; white route has a dark casing when drawn.
- [ ] `prefers-reduced-motion` disables smooth scrolling.

## Trying the UI with test data
Copy synthetic data into `public/data/*` **on a scratch branch only** (stops, verified directions, matching GeoJSON) and never commit it as real data.

## Release acceptance criteria
Do not describe this as a reliable commuter service until geometry, ordered stops, boarding points, transfers and directionality are verified against local sources and map/image reuse permission is confirmed.
