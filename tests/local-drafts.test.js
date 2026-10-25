import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLocalDrafts, setIgnoreLocal, LOCAL_KEY, IGNORE_KEY } from '../src/data/localDrafts.js';
import { lineFromCoords, lineKey } from '../src/trace/geojson.js';
import { buildDraftLines } from '../src/routing/draftPlanner.js';
import { renderDraftResult } from '../src/ui/tripResults.js';
import { planDraftTrip as planAny } from '../src/routing/draftPlanner.js';
const planDraftTrip = (a) => planAny({ ...a, options: { maxWalkMeters: 500, ...a.options } });

const memory = (init = {}) => { const m = { ...init }; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, dump: () => m }; };
const routes = [
  { id: 'r1', name: 'Route 1', sourceLabel: 'R1', jeepneyColorName: 'Red', displayColor: '#aa0000', geometryStatus: 'unverified', directions: [] },
  { id: 'r2', name: 'Route 2', sourceLabel: 'R2', jeepneyColorName: 'Blue', displayColor: '#0000aa', geometryStatus: 'unverified', directions: [] },
];
const shipped = { routes, stops: [], transfers: [], geojson: { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { routeId: 'r1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.05, 0]] } },
  { type: 'Feature', properties: { routeId: 'r2' }, geometry: { type: 'LineString', coordinates: [[0, 0.02], [0.05, 0.02]] } },
] } };
const saved = (entries) => JSON.stringify(entries.map(([k, v]) => [k, v]));

test('without saved tracer lines the shipped data is used unchanged', () => {
  const r = mergeLocalDrafts(shipped, memory());
  assert.equal(r.data, shipped);
  assert.deepEqual(r.used, []);
  assert.equal(r.hasLocal, false);
});

test('saved tracer lines replace the shipped lines for those routes only', () => {
  const a = lineFromCoords([[0, 0.01], [0.05, 0.01]], { oneWay: true });
  const store = memory({ [LOCAL_KEY]: saved([[lineKey('r1', 'a'), a]]) });
  const r = mergeLocalDrafts(shipped, store);
  assert.deepEqual(r.used, ['Route 1']);
  const f1 = r.data.geojson.features.filter((f) => f.properties.routeId === 'r1');
  assert.equal(f1.length, 1);
  assert.equal(f1[0].properties.oneWay, true);
  assert.equal(f1[0].geometry.coordinates[0][1], 0.01); // not the shipped 0 latitude
  assert.equal(r.data.geojson.features.filter((f) => f.properties.routeId === 'r2').length, 1); // untouched
});

test('a saved loop (out one road, back another) is ridden in traced order; switching the trip rides it the long way', () => {
  // out along y=0.01 from west to east, back along y=0.025 (~1.7 km away) from east to west, closed at the start
  const loop = lineFromCoords([[0, 0.01], [0.05, 0.01], [0.05, 0.025], [0, 0.025], [0, 0.0101]], { oneWay: true });
  const merged = mergeLocalDrafts(shipped, memory({ [LOCAL_KEY]: saved([[lineKey('r1', 'a'), loop]]) }));
  const lines = buildDraftLines(merged.data.geojson, routes);
  assert.equal(lines.find((l) => l.route.id === 'r1').isLoop, true);
  const out = planDraftTrip({ origin: [0.005, 0.0102], destination: [0.045, 0.0102], lines });
  assert.equal(out.itineraries[0].legs[0].directionLabel, 'loop route');
  const outKm = out.itineraries[0].approxRideMeters;
  // the way back on the return road is ridden along the return pass
  const back = planDraftTrip({ origin: [0.045, 0.0252], destination: [0.005, 0.0252], lines });
  assert.equal(back.status, 'draft_success');
  assert.ok(back.itineraries[0].accessWalkMeters < 100);
  // going "backwards" on the OUT road means riding the loop the long way round
  const wrong = planDraftTrip({ origin: [0.045, 0.0102], destination: [0.005, 0.0102], lines });
  assert.equal(wrong.status, 'draft_success');
  assert.ok(wrong.itineraries[0].approxRideMeters > outKm * 1.5);
});

test('the ignore switch, corrupt storage and invalid saved data are handled', () => {
  const a = lineFromCoords([[0, 0.01], [0.05, 0.01]], { oneWay: true });
  const store = memory({ [LOCAL_KEY]: saved([[lineKey('r1', 'a'), a]]) });
  setIgnoreLocal(store, true);
  assert.equal(store.dump()[IGNORE_KEY], '1');
  const ignored = mergeLocalDrafts(shipped, store);
  assert.equal(ignored.data, shipped);
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.hasLocal, true);
  setIgnoreLocal(store, false);
  assert.equal(mergeLocalDrafts(shipped, store).used.length, 1);
  assert.deepEqual(mergeLocalDrafts(shipped, memory({ [LOCAL_KEY]: '{not json' })).used, []);
  assert.deepEqual(mergeLocalDrafts(shipped, null).used, []);
  const unknownRoute = memory({ [LOCAL_KEY]: saved([[lineKey('ghost', 'a'), a]]) });
  assert.deepEqual(mergeLocalDrafts(shipped, unknownRoute).used, []); // ghost route is not in the route list
});

test('the public traced-lines preview can override a previously saved ignore preference without changing it', () => {
  const a = lineFromCoords([[0, 0.01], [0.05, 0.01]], { oneWay: true });
  const store = memory({ [LOCAL_KEY]: saved([[lineKey('r1', 'a'), a]]), [IGNORE_KEY]: '1' });
  const preview = mergeLocalDrafts(shipped, store, { ignoreLocal: false });
  assert.deepEqual(preview.used, ['Route 1']);
  assert.equal(preview.data.geojson.features.filter((f) => f.properties.routeId === 'r1').length, 1);
  assert.equal(store.dump()[IGNORE_KEY], '1'); // previewing does not change the tracer preference
});

test('results note when the return direction may use different streets', () => {
  const legacy = buildDraftLines(shipped.geojson, routes);
  const r = planDraftTrip({ origin: [0.005, 0.0002], destination: [0.045, 0.0002], lines: legacy });
  assert.match(renderDraftResult(r), /return direction may use different streets/);
  const oneWay = buildDraftLines({ features: [{ type: 'Feature', properties: { routeId: 'r1', direction: 'a', oneWay: true }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.05, 0]] } }] }, routes);
  const r2 = planDraftTrip({ origin: [0.005, 0.0002], destination: [0.045, 0.0002], lines: oneWay });
  assert.doesNotMatch(renderDraftResult(r2), /return direction may use different streets/);
});

import { setReplaceShipped, REPLACE_KEY } from '../src/data/localDrafts.js';

test('"Start over" mode hides the old shipped lines and shows only what was traced since', () => {
  const store = memory({ [LOCAL_KEY]: '[]' });
  setReplaceShipped(store, true);
  assert.equal(store.dump()[REPLACE_KEY], '1');
  const empty = mergeLocalDrafts(shipped, store);
  assert.equal(empty.replaced, true);
  assert.equal(empty.data.geojson.features.length, 0); // nothing traced yet → no old lines either
  const a = lineFromCoords([[0, 0.01], [0.05, 0.01]], { oneWay: true });
  store.setItem(LOCAL_KEY, saved([[lineKey('r1', 'a'), a]]));
  const one = mergeLocalDrafts(shipped, store);
  assert.deepEqual(one.used, ['Route 1']);
  assert.equal(one.data.geojson.features.length, 1); // r2's old shipped line is hidden
  setIgnoreLocal(store, true);
  assert.equal(mergeLocalDrafts(shipped, store).data, shipped); // the escape hatch still restores the shipped file
  setReplaceShipped(store, false);
  setIgnoreLocal(store, false);
  assert.equal(mergeLocalDrafts(shipped, store).data.geojson.features.length, 2);
});
