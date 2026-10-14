// Usage: npm run validate:data
import { readFileSync } from 'node:fs';
import { validateDataset } from '../src/data/validate.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const routesFile = read('routes.json');
const stopsFile = read('stops.json');
const result = validateDataset({
  routes: routesFile.routes,
  stops: stopsFile.stops,
  transfers: stopsFile.transfers ?? [],
  geojson: read('routes.geojson'),
});
const verifiedDirs = routesFile.routes.flatMap((r) => r.directions ?? []).filter((d) => d.verificationStatus === 'verified').length;
console.log(`${routesFile.routes.length} routes, ${stopsFile.stops.length} stops, ${verifiedDirs} verified directions.`);
if (result.valid) console.log('Data is valid.');
else {
  for (const e of result.errors) console.error(`✗ [${e.code}] ${e.message} (${e.path})`);
  process.exit(1);
}
