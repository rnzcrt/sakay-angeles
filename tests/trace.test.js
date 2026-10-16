import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyLine, lineFromCoords, pathOf, linesToGeoJson, geojsonToLines, lineKey, analyzeLine, lengthKm, validateDraftExport, geometryIdFor,
} from '../src/trace/geojson.js';
import { validateDataset } from '../src/data/validate.js';
import { planTrip, PLAN_STATUS } from '../src/routing/planner.js';

const routes = JSON.parse(readFileSync(new URL('../public/data/routes.json', import.meta.url), 'utf8')).routes;
const line3 = [[0, 0], [0.001, 0.0005], [0.002, 0.002]];

const snappedLine = () => ({
  waypoints: [[0, 0], [0.002, 0.002]],
  segments: [[[0, 0], [0.001, 0.0002], [0.0015, 0.001], [0.002, 0.002]]],
  oneWay: true, startName: 'Terminal X', endName: 'Mall Y',
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

test('single-point and empty lines are not exported; exports validate', () => {
  const lines = new Map(routes.flatMap((r) => [[lineKey(r.id, 'a'), lineFromCoords(line3, { oneWay: true })], [lineKey(r.id, 'b'), lineFromCoords(line3.slice(0, 1))]]));
  const geo = linesToGeoJson(lines, routes);
  assert.equal(geo.features.length, 11);
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

test('shipped legacy traces: the known out-and-back routes are flagged, the true loop is not', () => {
  const geo = JSON.parse(readFileSync(new URL('../public/data/routes.geojson', import.meta.url), 'utf8'));
  const lines = geojsonToLines(geo);
  const flagged = (id) => analyzeLine(pathOf(lines.get(lineKey(id, 'a')))).retraced;
  for (const id of ['checkpoint-balibago-highway', 'checkpoint-hensonville-holy', 'clark-main-gate-dau', 'pandang-pampang', 'villa-pampang']) assert.equal(flagged(id), true, id);
  assert.equal(flagged('marisol-pampang'), false);
  assert.equal(flagged('m-gate-friendship'), false);
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
