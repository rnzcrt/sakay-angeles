# Route data guide

## Why digitizing is required

The reference images are pictures, not geographic data. Pixel positions on the schematic must never be converted straight to latitude/longitude. Route lines must be traced against a real basemap (QGIS, geojson.io, etc.) and checked on the ground or with local sources.

## Files

| File | Purpose |
|---|---|
| `public/data/routes.json` | Route metadata and directions (ordered stop ids). |
| `public/data/stops.json` | Stops (`stops`) and verified walking links (`transfers`). |
| `public/data/routes.geojson` | Line geometry, one feature per route direction. |

Current state: all 11 routes have traced geometry. The A/B terminal endpoints (and any distinct endpoint on the return trace) are recorded as verified stops based on the project owner's real-world observations. Intermediate boarding/alighting stops, complete direction stop sequences, and transfers are not yet verified, so the app uses draft route matching for trip suggestions.

## Schemas

**Route** (`routes.json → routes[]`)

```json
{
  "id": "example-route",
  "name": "Display name",
  "sourceLabel": "LABEL EXACTLY AS PRINTED ON THE LEGEND",
  "jeepneyColorName": "Green",
  "displayColor": "#16834A",
  "fareClass": null,
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
- `fareClass` may be `traditional` or `modern` only when the vehicle class is verified for that route; leave it `null` or omit it when unknown. Unknown classes intentionally produce no fare quote.
- `geometryStatus` / `verificationStatus` ∈ `unverified | partially-verified | verified`.
- Model each direction separately when the stop order or road differs by direction.

**Stop** (`stops.json → stops[]`): `{ "id", "name", "coordinates": [lng, lat], "verificationStatus", "notes?" }`. The current verified stops are route terminal endpoints A/B, based on the project owner's real-world observations. Intermediate boarding/alighting points still need to be recorded before building fully verified direction sequences.

**Transfer** (`stops.json → transfers[]`): `{ "id", "fromStopId", "toStopId", "walkMeters", "verificationStatus" }` — an explicit, verified walking link between two different stops (treated as two-way).

**Geometry** (`routes.geojson`): `LineString` / `MultiLineString` features with `properties: { "routeId", "geometryId", "directionId?" }`. The app joins color/name from route metadata at load time.

## Jeepney fare class

Add `fareClass: "traditional"` or `fareClass: "modern"` only when that vehicle class has been confirmed for the route. Leave it absent or `null` when unknown; the planner will show an unavailable fare instead of guessing. The configurable estimate rules currently use the 2026-09-28 LTFRB fare guide rates reported by [PTV News](https://ptvnews.ph/ltfrb-releases-new-matrices-for-puv-fare-hikes-effective-sept-28/). Route-level and local fare matrices may differ; confirm the fare posted in the vehicle.

## Direction in traced lines
Each traced GeoJSON feature may carry `direction` (`"a"` or `"b"`), `oneWay` (`true` = ridden only in the traced order), and optional `startName` / `endName`. Features without these are treated as two-way. Trace a route's way back as Direction B whenever it uses different roads. GeoJSON endpoint stop IDs link each trace to verified terminal coordinates. The path between endpoints remains draft, and verified directions still need ordered intermediate stops (see above).

## Secondary sources
`routes.json` also carries `secondarySources` (and `unmatchedSecondaryRoutes`) with text from a WordPress blog ("The Pooch of the Philippines") supplied by the project owner. It is **unverified**, disagrees with the legend in places (e.g. Beige/Sand, Purple/Lavender, Red/Maroon, Silver/Steel, 'Pandan' vs 'PANDANG', a Brown Friendship–Check Point route that is not on the legend, Sunset–Nepo and Capaya merged into one entry), and its original URL/date are unknown. It is shown in the route detail card for contributors to check; it must not be promoted to verified without independent confirmation.

## Verification workflow

1. Confirm the source map edition and permission to reuse it. Treat a schematic as evidence for its printed labels and landmarks only, not the exact roads or service direction.
2. Keep each claim separate: terminal, geometry, direction, intermediate stop, transfer, vehicle/fare class, and operating period can have different statuses.
3. For each claim, record a source, verification method, and checked date. A user field observation is a valid source for what that person observed; it does not verify an entire route or all service times.
4. Trace each direction on a real basemap with `/trace.html`, then independently check the road sequence on the ground or against authoritative route documents. A traced line remains `unverified` until checked.
5. Survey actual boarding/alighting points; record coordinates and ordered stops for that direction. Add them as unverified first.
6. Confirm a transfer as a shared usable stop or a mapped pedestrian connection between distinct stops. Geometric proximity alone is not sufficient to mark it verified.
7. Confirm the vehicle class for that route before setting `fareClass`; add `fareClassEvidence` with `{ "source", "method", "checkedAt" }`. Fare-matrix sources and the route-class evidence are separate claims.
8. Add geometry and direction evidence (`geometryEvidence` and direction `evidence`, each `{ "source", "method", "checkedAt" }`), then promote only the supported claim. `npm run validate:data` rejects verified geometry/directions and assigned fare classes without this evidence.
9. Test known journeys end to end. Use `npm run audit:routes` before and after each incremental update to review exactly what changed.

The Angeles City traffic-code copy available online lists city route/color categories, but is not an authoritative digital route map and the currently surfaced copy is hosted by a document-sharing site. Contemporary reporting describes terminal restrictions for out-of-city public vehicles; neither source establishes the current street-by-street paths of the eleven mapped services. Use those as leads for a request to Angeles City's PTRO/ACPVFRB, not as evidence to promote the traced geometries. The owner-supplied terminal observations remain the evidence for the A/B points only.

- [Angeles City Traffic Code No. 609 (copy hosted on Scribd)](https://www.scribd.com/document/1014604322/Ordinance-No-609-s-2021) — lead for route names/colors and the responsible local board; obtain a certified/current copy from the city before relying on it.
- [Inquirer report on Angeles City terminal restrictions](https://newsinfo.inquirer.net/1613888/angeles-city-to-ban-public-vehicles-from-major-city-roads) — secondary report on the 2022 policy, not evidence of current operations or detailed local jeepney traces.
- [Angeles Map route guide](https://www.angelesmap.com/angeles-city-jeepney-routes) — local route description and schematic; useful for cross-checking labels and collecting questions, but not used to mark geometry or stops verified.

## Current audit snapshot

Run `npm run audit:routes` for per-route line counts, approximate stored geometry length, terminals, ordered directions, and fare-class evidence. Length is a geometry statistic, not a measure of verified route distance. Current data has 11 digitized route records, 0 verified directions, 0 intermediate stops, and 0 assigned route fare classes. The observed A/B terminals have source labels but their observation dates are not recorded. No new route or fare class has been promoted based on web search.

## A direction is used by the planner only if all of these hold

- `route.geometryStatus === "verified"`
- `direction.verificationStatus === "verified"`
- every stop in `orderedStopIds` exists and is `verified`
- the validator additionally requires a `geometryId` pointing to existing geometry

## Planner rules

See the README section “How the planner works”. In short: ordered directions only, transfers only at the same verified stop id or a verified transfer record, walking access limit 500 m and up to 10 transfers for the current 11-route data (configurable in `src/config.js`), no invented ETAs.

## Known gaps in the source material

- The schematic also draws lines that are not in the legend (e.g. a Clark loop bus, a Balibago–Marquee Mall shuttle, Dau Access Road). They are **not** modelled.
- Spelling/label ambiguities are recorded per route in `labelNotes`.
