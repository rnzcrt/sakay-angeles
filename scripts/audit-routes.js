// Usage: npm run audit:routes
// Summarizes what the dataset supports without promoting traced geometry to verified.
import { readFileSync } from 'node:fs';
import { haversineMeters } from '../src/routing/geo.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8'));
const routeFile = read('routes.json');
const stopFile = read('stops.json');
const geometry = read('routes.geojson');
const byRoute = new Map(routeFile.routes.map((route) => [route.id, {
  features: [],
  route,
}]));

for (const feature of geometry.features ?? []) {
  byRoute.get(feature.properties?.routeId)?.features.push(feature);
}

const summarizeFeature = (feature) => {
  const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const meters = lines.reduce((sum, line) => sum + line.slice(1).reduce((lineSum, point, index) => lineSum + haversineMeters(line[index], point), 0), 0);
  return { vertices: lines.reduce((sum, line) => sum + line.length, 0), km: meters / 1000 };
};

const rows = routeFile.routes.map((route) => {
  const stops = stopFile.stops.filter((stop) => stop.routeId === route.id);
  const terminals = stops.filter((stop) => stop.kind === 'terminal');
  const verifiedTerminals = terminals.filter((stop) => stop.verificationStatus === 'verified');
  const features = byRoute.get(route.id).features;
  const metrics = features.map(summarizeFeature);
  return {
    id: route.id,
    name: route.name,
    color: route.jeepneyColorName,
    geometry: route.geometryStatus,
    lines: features.length,
    approxKm: metrics.reduce((sum, metric) => sum + metric.km, 0),
    vertices: metrics.reduce((sum, metric) => sum + metric.vertices, 0),
    directions: (route.directions ?? []).map((direction) => direction.verificationStatus),
    verifiedTerminals: `${verifiedTerminals.length}/${terminals.length}`,
    intermediateStops: stops.filter((stop) => stop.kind !== 'terminal').length,
    fareClass: route.fareClass ?? 'unknown',
    fareEvidence: route.fareClass
      ? route.fareClassEvidence?.source ?? 'missing'
      : 'not assigned',
    source: route.source,
  };
});

console.log('ROUTE AUDIT — distances describe stored geometry only; they do not verify roads, direction, service, or stops.');
for (const row of rows) {
  console.log(`\n${row.id} · ${row.name} · ${row.color}`);
  console.log(`  Geometry: ${row.geometry}; ${row.lines} line feature(s), ${row.vertices} vertices, approx. ${row.approxKm.toFixed(2)} km digitized`);
  console.log(`  Directions: ${row.directions.length ? row.directions.join(', ') : 'none verified or sequenced'}`);
  console.log(`  Terminals: ${row.verifiedTerminals} verified; intermediate stops recorded: ${row.intermediateStops}`);
  console.log(`  Fare class: ${row.fareClass}; fare-class evidence: ${row.fareEvidence}`);
  console.log(`  Source: ${row.source}`);
}

const verifiedDirections = rows.reduce((sum, row) => sum + row.directions.filter((status) => status === 'verified').length, 0);
const fareClasses = new Set(rows.filter((row) => row.fareClass !== 'unknown').map((row) => row.fareClass));
console.log(`\nTotals: ${rows.length} routes; ${verifiedDirections} verified directions; ${fareClasses.size} route fare classes assigned.`);
console.log('No route is promoted by this audit. Add evidence to the source data and pass validation before changing a verification status.');
