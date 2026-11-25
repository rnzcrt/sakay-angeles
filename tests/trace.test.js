import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyLine, lineFromCoords, pathOf, linesToGeoJson, geojsonToLines, lineKey, analyzeLine, lengthKm, validateDraftExport, geometryIdFor, insertWaypoint,
} from '../src/trace/geojson.js';
import { validateDataset } from '../src/data/validate.js';
import { planTrip, PLAN_STATUS } from '../src/routing/planner.js';
import { renderRoutePreview } from '../src/trace/preview.js';

const routes = JSON.parse(readFileSync(new URL('../public/data/routes.json', import.meta.url), 'utf8')).routes;
const line3 = [[0, 0], [0.001, 0.0005], [0.002, 0.002]];

const snappedLine = () => ({
  waypoints: [[0, 0], [0.002, 0.002]],
  segments: [[[0, 0], [0.001, 0.0002], [0.0015, 0.001], [0.002, 0.002]]],
  oneWay: true, startName: 'Terminal X', endName: 'Mall Y',
});

test('selected map editing inserts a vertex between existing waypoints and rebuilds only adjacent segments', async () => {
  const line = lineFromCoords([[120, 15], [120.02, 15], [120.04, 15]]);
  const unrelated = structuredClone(line.segments[1]);
  await insertWaypoint(line, 1, [120.01, 15], async (a, b) => [a, b]);
  assert.deepEqual(line.waypoints, [[120, 15], [120.01, 15], [120.02, 15], [120.04, 15]]);
  assert.deepEqual(line.segments[2], unrelated, 'the non-adjacent segment remains unchanged');
  assert.deepEqual(pathOf(line), line.waypoints);
});

test('route geometry insertion rejects malformed coordinates and invalid indices without altering the line', async () => {
  const line = lineFromCoords([[120, 15], [120.02, 15]]);
  const before = structuredClone(line);
  await assert.rejects(insertWaypoint(line, 1, [999, 15], async (a, b) => [a, b]), /Invalid route vertex insertion/);
  await assert.rejects(insertWaypoint(line, 4, [120.01, 15], async (a, b) => [a, b]), /Invalid route vertex insertion/);
  assert.deepEqual(line, before);
});

test('tracer preview renders the unsaved route, direction geometry, and ordered stops safely', () => {
  const html = renderRoutePreview({
    route: { name: '<New Jeepney>', jeepneyColorName: 'Silver', displayColor: '#667788', description: '<script>x</script>', startPoint: 'Angeles', destination: 'San Fernando', via: 'Town', active: true },
    directions: [{ label: 'Outbound', startPoint: 'Angeles', destination: 'San Fernando', via: '', active: true, geometryPointCount: 4, geometryLengthKm: 12.34, stops: [{ name: '<Terminal>', kind: 'terminal', geometryPosition: '120, 15' }], unlistedStops: [] }],
  });
  assert.match(html, /Unsaved draft preview/);
  assert.match(html, /&lt;New Jeepney&gt;/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /12\.34 km \(draft\)/);
  assert.match(html, /&lt;Terminal&gt;/);
  assert.match(html, /Angeles/);
  assert.match(html, /San Fernando/);
  assert.doesNotMatch(html, /<script>/);
});

test('pathOf joins segments without duplicating the shared point', () => {
  const l = { waypoints: [[0, 0], [1, 1], [2, 2]], segments: [[[0, 0], [0.5, 0.5], [1, 1]], [[1, 1], [1.5, 1.5], [2, 2]]], oneWay: true };
  assert.deepEqual(pathOf(l), [[0, 0], [0.5, 0.5], [1, 1], [1.5, 1.5], [2, 2]]);
  assert.deepEqual(pathOf({ waypoints: [[3, 3]], segments: [], oneWay: true }), [[3, 3]]);
  assert.deepEqual(pathOf(emptyLine()), []);
});

test('export writes one feature per direction with direction, oneWay and terminal names', () => {
  const lines = new Map([[lineKey(routes[0].id, 'a'), snappedLine()], [lineKey(routes[0].id, 'b'), lineFromCoords(line3, { oneWay: true })]]);
  const geo = linesToGeoJson(lines, routes);
  assert.equal(geo.features.length, 2);
  const [a, b] = geo.features;
  assert.equal(a.properties.direction, 'a');
  assert.equal(a.properties.oneWay, true);
  assert.equal(a.properties.geometryId, geometryIdFor(routes[0].id, 'a'));
  assert.equal(a.properties.startName, 'Terminal X');
  assert.equal(a.geometry.coordinates.length, 4); // the snapped path, not just the two clicks
  assert.equal(b.properties.direction, 'b');
  assert.notEqual(a.properties.geometryId, b.properties.geometryId);
});

test('tracer imports and exports independently identified direction records beyond legacy a/b', () => {
  const route = { id: 'dynamic-route', name: 'Dynamic route', sourceLabel: 'Dynamic test', jeepneyColorName: 'Slate', displayColor: '#667788', geometryStatus: 'unverified', directions: [
    { id: 'dynamic-out', label: 'Angeles to San Fernando', geometryId: 'dynamic-out-geometry', verificationStatus: 'unverified', orderedStopIds: [] },
    { id: 'dynamic-via-market', label: 'Via market', verificationStatus: 'unverified', orderedStopIds: [] },
    { id: 'dynamic-return', label: 'San Fernando to Angeles', verificationStatus: 'unverified', orderedStopIds: [] },
  ] };
  const lines = new Map(route.directions.map((direction, index) => [lineKey(route.id, direction.id), lineFromCoords([[120, 15], [120 + (index + 1) * 0.01, 15]])]));
  const exported = linesToGeoJson(lines, [route]);
  assert.deepEqual(exported.features.map((feature) => feature.properties.directionId), route.directions.map((direction) => direction.id));
  assert.equal(exported.features[0].properties.geometryId, 'dynamic-out-geometry');
  const imported = geojsonToLines(exported, [route]);
  for (const direction of route.directions) assert.deepEqual(imported.get(lineKey(route.id, direction.id)).waypoints, lines.get(lineKey(route.id, direction.id)).waypoints);
});


test('tracer refuses MultiLineString geometry instead of flattening disconnected parts', () => {
  const multipart = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { routeId: 'x', direction: 'a', geometryId: 'x-a' },
      geometry: { type: 'MultiLineString', coordinates: [line3, [[120.1, 15.1], [120.2, 15.2]]] },
    }],
  };
  assert.throws(() => geojsonToLines(multipart), /Cannot edit multipart geometry.*separate line parts were preserved/);
});

test('tracer refuses explicit geometry references that cannot be resolved to a direction', () => {
  const route = { id: 'dynamic-route', directions: [
    { id: 'dynamic-out', geometryId: 'dynamic-out-geometry' },
    { id: 'dynamic-return' },
  ] };
  const feature = (directionId, geometryId = 'dynamic-out-geometry') => ({
    type: 'Feature',
    properties: { routeId: route.id, directionId, geometryId, direction: 'a' },
    geometry: { type: 'LineString', coordinates: line3 },
  });
  assert.throws(
    () => geojsonToLines({ type: 'FeatureCollection', features: [feature('missing-direction')] }, [route]),
    /references unknown direction/,
  );
  assert.throws(
    () => geojsonToLines({ type: 'FeatureCollection', features: [feature('dynamic-return')] }, [route]),
    /conflicting direction and geometry references/,
  );
});

test('tracer preserves a valid legacy a/b feature beside partially explicit direction metadata', () => {
  const route = { id: 'partial-route', directions: [{ id: 'partial-route-a', geometryId: 'partial-a-geometry' }] };
  const geo = { type: 'FeatureCollection', features: [{
    type: 'Feature',
    properties: { routeId: 'partial-route', directionId: 'partial-route-b', direction: 'b', geometryId: 'partial-b-geometry' },
    geometry: { type: 'LineString', coordinates: line3 },
  }] };
  const imported = geojsonToLines(geo, [route]);
  assert.deepEqual(imported.get(lineKey('partial-route', 'b')).waypoints, line3);
});

test('tracer refuses multiple features for one direction rather than joining them with an invented segment', () => {
  const feature = (coordinates) => ({
    type: 'Feature',
    properties: { routeId: 'x', direction: 'a' },
    geometry: { type: 'LineString', coordinates },
  });
  assert.throws(
    () => geojsonToLines({ type: 'FeatureCollection', features: [feature(line3), feature([[120.1, 15.1], [120.2, 15.2]])] }),
    /More than one geometry feature maps/,
  );
});

test('single-point and empty lines are not exported; exports validate', () => {
  const lines = new Map(routes.flatMap((r) => [[lineKey(r.id, 'a'), lineFromCoords(line3, { oneWay: true })], [lineKey(r.id, 'b'), lineFromCoords(line3.slice(0, 1))]]));
  const geo = linesToGeoJson(lines, routes);
  assert.equal(geo.features.length, routes.length);
  assert.deepEqual(validateDraftExport(geo, routes).errors, []);
});

test('round trip keeps direction, oneWay and terminal names; legacy features import as two-way', () => {
  const lines = new Map([[lineKey(routes[1].id, 'b'), snappedLine()]]);
  const back = geojsonToLines(linesToGeoJson(lines, routes));
  const l = back.get(lineKey(routes[1].id, 'b'));
  assert.equal(l.oneWay, true);
  assert.equal(l.startName, 'Terminal X');
  assert.equal(pathOf(l).length, 4);
  const legacy = geojsonToLines({ features: [{ type: 'Feature', properties: { routeId: 'x' }, geometry: { type: 'LineString', coordinates: line3 } }] });
  assert.equal(legacy.get(lineKey('x', 'a')).oneWay, false);
});

test('analyzeLine flags out-and-back traces, accepts true loops and one-way lines', () => {
  const out = []; for (let i = 0; i <= 50; i += 1) out.push([i * 0.001, 0]);
  const back = [...out].reverse().map((c) => [c[0], 0.0001]);
  const outAndBack = analyzeLine([...out, ...back]);
  assert.equal(outAndBack.retraced, true);
  assert.ok(outAndBack.retraceRatio > 0.4);
  const loop = []; // a rectangle ~5 km x 1 km, different roads each side
  for (let i = 0; i <= 50; i += 1) loop.push([i * 0.001, 0]);
  for (let j = 1; j <= 10; j += 1) loop.push([0.05, j * 0.001]);
  for (let i = 49; i >= 0; i -= 1) loop.push([i * 0.001, 0.01]);
  for (let j = 9; j >= 0; j -= 1) loop.push([0, j * 0.001]);
  const l = analyzeLine(loop);
  assert.equal(l.retraced, false);
  assert.equal(l.closesLoop, true);
  assert.equal(analyzeLine(out).retraced, false);
  assert.equal(analyzeLine([[0, 0]]).retraced, false);
});

test('shipped traces: wherever both Route 1 and Route 2 exist, Route 2 starts at Route 1\'s end and ends at its start, with no round-trip lines', () => {
  const geo = JSON.parse(readFileSync(new URL('../public/data/routes.geojson', import.meta.url), 'utf8'));
  const lines = geojsonToLines(geo);
  let pairs = 0;
  for (const r of routes) {
    const a = lines.get(lineKey(r.id, 'a'));
    const b = lines.get(lineKey(r.id, 'b'));
    if (!a || !b) continue;
    pairs += 1;
    assert.equal(checkDirectionPair(a, b, 150).ok, true, `${r.id}: Route 2 must start where Route 1 ends and end where Route 1 starts`);
    for (const l of [a, b]) assert.equal(analyzeLine(pathOf(l)).retraced, false, `${r.id}: a line should not go back over itself`);
  }
  assert.ok(pairs >= 1);
});

test('lengthKm and draft lines never enable verified planning', () => {
  assert.equal(lengthKm([[0, 0]]), 0);
  const geo = linesToGeoJson(new Map(routes.map((r) => [lineKey(r.id, 'a'), lineFromCoords(line3, { oneWay: true })])), routes);
  assert.equal(validateDataset({ routes, stops: [], transfers: [], geojson: geo }).valid, true);
  assert.equal(planTrip({ origin: [120.59, 15.15], destination: [120.56, 15.17], data: { routes, stops: [], transfers: [] } }).status, PLAN_STATUS.NO_VERIFIED_ROUTE);
});

test('analyzeLine reports when start and end are the same place (round trip vs loop)', () => {
  const out = []; for (let i = 0; i <= 50; i += 1) out.push([i * 0.001, 0]);
  const roundTrip = analyzeLine([...out, ...[...out].reverse().map((c) => [c[0], 0.0001])]);
  assert.equal(roundTrip.sameStartEnd, true);
  assert.equal(roundTrip.retraced, true); // same place AND same road → a round trip squeezed into one line
  const oneWayLine = analyzeLine(out);
  assert.equal(oneWayLine.sameStartEnd, false);
  assert.ok(oneWayLine.startEndMeters > 4000);
});

import { checkDirectionPair } from '../src/trace/geojson.js';

test('checkDirectionPair: B must start where A ends and end where A starts', () => {
  const A = lineFromCoords([[0, 0], [0.02, 0], [0.04, 0]], { oneWay: true });
  const goodB = lineFromCoords([[0.04, 0.001], [0.02, 0.003], [0, 0.0005]], { oneWay: true });
  const good = checkDirectionPair(A, goodB);
  assert.equal(good.ok, true);
  // B that begins at A's start and runs out and back (a round trip): both checks fail
  const roundTripB = lineFromCoords([[0, 0], [0.04, 0], [0, 0.0002]], { oneWay: true });
  const bad = checkDirectionPair(A, roundTripB);
  assert.equal(bad.bStartsAtAEnd, false);
  assert.ok(bad.startGapM > 4000);
  assert.equal(bad.bEndsAtAStart, true);
  assert.equal(bad.ok, false);
  assert.equal(checkDirectionPair(A, lineFromCoords([[0, 0]])), null);
});

import { splitLineAt } from '../src/trace/geojson.js';

test('splitLineAt: Route 1 ends at the chosen point and Route 2 starts there', () => {
  const l = {
    waypoints: [[0, 0], [0.02, 0], [0.04, 0], [0.02, 0.003], [0, 0]],
    segments: [[[0, 0], [0.01, 0], [0.02, 0]], [[0.02, 0], [0.04, 0]], [[0.04, 0], [0.02, 0.003]], [[0.02, 0.003], [0, 0]]],
    oneWay: true, startName: 'Start', endName: '',
  };
  const [one, two] = splitLineAt(l, 2);
  assert.deepEqual(one.waypoints, [[0, 0], [0.02, 0], [0.04, 0]]);
  assert.equal(one.segments.length, 2);
  assert.deepEqual(two.waypoints, [[0.04, 0], [0.02, 0.003], [0, 0]]);
  assert.equal(two.segments.length, 2);
  assert.deepEqual(pathOf(one).at(-1), pathOf(two)[0]);
  assert.equal(checkDirectionPair(one, two).ok, true);
  assert.equal(one.startName, 'Start');
  assert.equal(two.endName, 'Start');
  assert.equal(one.oneWay && two.oneWay, true);
});

import { isDetour, findDetours, straightenDetours } from '../src/trace/geojson.js';

test('isDetour: a path far longer than the gap between the clicks is a detour', () => {
  assert.equal(isDetour(100, 130), false);
  assert.equal(isDetour(100, 400), false);   // short gap: needs +350 m AND 2.2x
  assert.equal(isDetour(100, 600), true);
  assert.equal(isDetour(1000, 1900), false); // 1.9x is OK
  assert.equal(isDetour(1000, 3000), true);
});

test('findDetours / straightenDetours fix only the bad segments', () => {
  const wp = [[120.58, 15.13], [120.585, 15.13], [120.59, 15.13]];       // ~540 m gaps
  const good = [wp[0], [120.5825, 15.1301], wp[1]];
  const around = [wp[1], [120.585, 15.14], [120.59, 15.14], wp[2]];       // goes ~1.1 km north and back: a detour
  const line = { waypoints: wp, segments: [good, around], oneWay: true };
  const d = findDetours(line);
  assert.equal(d.length, 1);
  assert.equal(d[0].index, 1);
  assert.equal(d[0].from, 2);
  assert.equal(d[0].to, 3);
  assert.equal(straightenDetours(line), 1);
  assert.deepEqual(line.segments[1], [wp[1], wp[2]]);
  assert.deepEqual(line.segments[0], good); // untouched
  assert.equal(findDetours(line).length, 0);
  assert.equal(straightenDetours(line), 0);
});
