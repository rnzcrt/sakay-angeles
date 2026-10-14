# Route data guide

## Why digitizing is required

The reference images are pictures, not geographic data. Pixel positions on the schematic must never be converted straight to latitude/longitude. Route lines must be traced against a real basemap (QGIS, geojson.io, etc.) and checked on the ground or with local sources.

## Files

| File | Purpose |
|---|---|
| `public/data/routes.json` | Route metadata and directions (ordered stop ids). |
| `public/data/stops.json` | Stops (`stops`) and verified walking links (`transfers`). |
| `public/data/routes.geojson` | Line geometry, one feature per route direction. |

Current state: all 11 routes are listed from the legend; **there are no stops, directions or geometry yet.** The app therefore cannot recommend any trip.

## Schemas

**Route** (`routes.json → routes[]`)

```json
{
  "id": "example-route",
  "name": "Display name",
  "sourceLabel": "LABEL EXACTLY AS PRINTED ON THE LEGEND",
  "jeepneyColorName": "Green",
  "displayColor": "#16834A",
  "geometryStatus": "unverified",
  "description": "Legend text, if any",
  "sourceLandmarks": ["as listed on legend"],
  "labelNotes": ["ambiguities to verify"],
  "source": "route-legend.jpeg",
  "directions": [
    {
      "id": "example-route-outbound",
      "label": "A to B",
      "verificationStatus": "unverified",
      "orderedStopIds": ["stop-id-1", "stop-id-2"],
      "geometryId": "example-route-outbound"
    }
  ]
}
```

- `displayColor` is a *map display color* chosen for visibility, not an official paint spec.
- `geometryStatus` / `verificationStatus` ∈ `unverified | partially-verified | verified`.
- Model each direction separately when the stop order or road differs by direction.

**Stop** (`stops.json → stops[]`): `{ "id", "name", "coordinates": [lng, lat], "verificationStatus", "notes?" }`. A stop is a surveyed boarding/alighting point, not a road intersection or landmark name.

**Transfer** (`stops.json → transfers[]`): `{ "id", "fromStopId", "toStopId", "walkMeters", "verificationStatus" }` — an explicit, verified walking link between two different stops (treated as two-way).

**Geometry** (`routes.geojson`): `LineString` / `MultiLineString` features with `properties: { "routeId", "geometryId", "directionId?" }`. The app joins color/name from route metadata at load time.

## Direction in traced lines
Each traced GeoJSON feature may carry `direction` (`"a"` or `"b"`), `oneWay` (`true` = ridden only in the traced order), and optional `startName` / `endName`. Features without these are treated as two-way. Trace a route's way back as Direction B whenever it uses different roads. This is *draft* geometry; verified directions still need ordered stops (see above).

## Secondary sources
`routes.json` also carries `secondarySources` (and `unmatchedSecondaryRoutes`) with text from a WordPress blog ("The Pooch of the Philippines") supplied by the project owner. It is **unverified**, disagrees with the legend in places (e.g. Beige/Sand, Purple/Lavender, Red/Maroon, Silver/Steel, 'Pandan' vs 'PANDANG', a Brown Friendship–Check Point route that is not on the legend, Sunset–Nepo and Capaya merged into one entry), and its original URL/date are unknown. It is shown in the route detail card for contributors to check; it must not be promoted to verified without independent confirmation.

## Verification workflow

1. Confirm the source map edition and your permission to reuse it.
2. For each route, trace each direction on a real basemap with the route tracing tool (`/trace.html`) and export GeoJSON.
3. Survey actual boarding/alighting points; record coordinates and the **stop order per direction**.
4. Add stops (`unverified` first), directions and geometry. Run `npm run validate:data`.
5. Confirm with local commuters/drivers or an authoritative source. Only then promote, bottom-up: stops → direction → route `geometryStatus` to `verified`.
6. Confirm transfers (same stop id, or a verified `transfers` record). Street names or proximity are not evidence.
7. Test known journeys end to end.

## A direction is used by the planner only if all of these hold

- `route.geometryStatus === "verified"`
- `direction.verificationStatus === "verified"`
- every stop in `orderedStopIds` exists and is `verified`
- the validator additionally requires a `geometryId` pointing to existing geometry

## Planner rules

See the README section “How the planner works”. In short: ordered directions only, transfers only at the same verified stop id or a verified transfer record, walking limit 500 m and max 2 transfers (both configurable in `src/config.js`), no invented ETAs.

## Known gaps in the source material

- The schematic also draws lines that are not in the legend (e.g. a Clark loop bus, a Balibago–Marquee Mall shuttle, Dau Access Road). They are **not** modelled.
- Spelling/label ambiguities are recorded per route in `labelNotes`.
