import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrip, buildGraph, PLAN_STATUS } from '../src/routing/planner.js';
import { makeData, near, stopOf, route, direction, stop } from './fixtures.js';

const plan = (data, o, d, options) => planTrip({ origin: o, destination: d, data, options });

test('1. direct route found when stops are served in the correct order', () => {
  const data = makeData();
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'D')));
  assert.equal(r.status, PLAN_STATUS.SUCCESS);
  const best = r.itineraries[0];
  assert.equal(best.transfers, 0);
  assert.equal(best.legs[0].routeId, 'R1');
  assert.equal(best.legs[0].boardStop.id, 'A');
  assert.equal(best.legs[0].alightStop.id, 'D');
  assert.equal(best.legs[0].stopCount, 3);
});

test('2. direct route rejected when destination precedes origin on a one-way direction', () => {
  const data = makeData();
  const r = plan(data, near(stopOf(data, 'D')), near(stopOf(data, 'A')));
  assert.equal(r.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
  assert.deepEqual(r.itineraries, []);
});

test('2b. a separately modelled reverse direction makes the reverse trip valid', () => {
  const data = makeData();
  data.routes[0].directions.push(direction('R1-back', ['D', 'C', 'B', 'A']));
  const r = plan(data, near(stopOf(data, 'D')), near(stopOf(data, 'A')));
  assert.equal(r.status, PLAN_STATUS.SUCCESS);
  assert.equal(r.itineraries[0].legs[0].directionId, 'R1-back');
});

test('3. one-transfer itinerary works at a verified shared stop', () => {
  const data = makeData();
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'F')));
  assert.equal(r.status, PLAN_STATUS.SUCCESS);
  const it = r.itineraries[0];
  assert.equal(it.transfers, 1);
  assert.deepEqual(it.legs.map((l) => l.type), ['ride', 'transfer', 'ride']);
  assert.equal(it.legs[1].mode, 'same-stop');
  assert.equal(it.legs[1].fromStop.id, 'C');
  assert.equal(it.legs[2].routeId, 'R2');
});

test('4. no transfer is invented when routes are merely close geographically', () => {
  const data = makeData();
  // R1 ends at D; R4 starts at X1, ~55 m away, but they share no stop and no transfer record.
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'X2')));
  assert.equal(r.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
});

test('4b. an explicit verified walking transfer record does connect them', () => {
  const data = makeData();
  data.transfers = [{ id: 't1', fromStopId: 'D', toStopId: 'X1', walkMeters: 60, verificationStatus: 'verified' }];
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'X2')));
  assert.equal(r.status, PLAN_STATUS.SUCCESS);
  assert.equal(r.itineraries[0].legs[1].mode, 'walk');
  assert.equal(r.itineraries[0].legs[1].walkMeters, 60);
});

test('4c. an unverified transfer record is ignored', () => {
  const data = makeData();
  data.transfers = [{ id: 't1', fromStopId: 'D', toStopId: 'X1', walkMeters: 60, verificationStatus: 'partially-verified' }];
  assert.equal(plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'X2'))).status, PLAN_STATUS.NO_VERIFIED_ROUTE);
});

test('5. unverified routes, directions and stops are excluded from the graph', () => {
  const data = makeData();
  const graph = buildGraph(data);
  assert.ok(!graph.directionsById.has('RU-out'));
  assert.ok(graph.excluded.some((e) => e.directionId === 'RU-out'));
  // Route that is only reachable via the unverified route: B -> F directly would be 1 ride on RU.
  const r = plan(data, near(stopOf(data, 'B')), near(stopOf(data, 'F')));
  assert.equal(r.status, PLAN_STATUS.SUCCESS);
  assert.ok(r.itineraries.every((it) => it.legs.every((l) => l.type !== 'ride' || l.routeId !== 'RU')));
  // A verified direction on a route whose geometry is unverified is excluded too.
  const d2 = makeData();
  d2.routes[0].geometryStatus = 'partially-verified';
  assert.ok(!buildGraph(d2).directionsById.has('R1-out'));
});

test('6. no verified route returns a clear no_verified_route result', () => {
  const data = makeData();
  data.routes.forEach((r) => { r.geometryStatus = 'unverified'; r.directions.forEach((d) => { d.verificationStatus = 'unverified'; }); });
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'D')));
  assert.equal(r.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
  assert.match(r.message, /enough verified route data/);
  assert.equal(r.details.verifiedDirectionCount, 0);
  const shipped = plan({ routes: [], stops: [] }, [0, 0], [0.01, 0]);
  assert.equal(shipped.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
});

test('7. origin / destination too far from every verified stop', () => {
  const data = makeData();
  const far = [0.5, 0.5];
  const o = plan(data, far, near(stopOf(data, 'D')));
  assert.equal(o.status, PLAN_STATUS.ORIGIN_TOO_FAR);
  assert.ok(o.details.nearestStop.distanceMeters > 500);
  const d = plan(data, near(stopOf(data, 'A')), far);
  assert.equal(d.status, PLAN_STATUS.DESTINATION_TOO_FAR);
  assert.equal(plan(data, near(stopOf(data, 'A')), far, { maxWalkMeters: 100000 }).status !== PLAN_STATUS.DESTINATION_TOO_FAR, true);
});

test('7b. the last stop of a direction cannot be a boarding stop', () => {
  const data = { stops: [stop('P', 0), stop('Q', 0.002)], routes: [route('RX', [direction('RX-out', ['P', 'Q'])])], transfers: [] };
  const r = plan(data, [0.002, 0], [0, 0], { maxWalkMeters: 100 });
  assert.equal(r.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
  assert.match(r.message, /no verified jeepney direction lets you board/);
});

test('invalid input is reported, not guessed', () => {
  const data = makeData();
  assert.equal(plan(data, undefined, [0, 0]).status, PLAN_STATUS.INVALID_INPUT);
  assert.equal(plan(data, [0, 0], [200, 0]).status, PLAN_STATUS.INVALID_INPUT);
  assert.equal(plan(data, [0, 0], [NaN, 0]).status, PLAN_STATUS.INVALID_INPUT);
});

test('8b. broken stop references yield data_error from the planner', () => {
  const data = makeData();
  data.routes[0].directions[0].orderedStopIds.push('NOPE');
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'D')));
  assert.equal(r.status, PLAN_STATUS.DATA_ERROR);
  assert.ok(r.details.errors.length > 0);
});

test('transfer limit is respected', () => {
  const data = makeData();
  const direct = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'F')), { maxTransfers: 0 });
  assert.equal(direct.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
  assert.equal(plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'F')), { maxTransfers: 1 }).status, PLAN_STATUS.SUCCESS);
});

test('ranking: fewer transfers first, then less walking; duplicates removed', () => {
  const data = makeData();
  // Add a second direct route from A to F so a 0-transfer option exists beside the 1-transfer one.
  data.routes.push(route('R5', [direction('R5-out', ['A', 'F'])]));
  const r = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'F')));
  assert.equal(r.itineraries[0].transfers, 0);
  assert.equal(r.itineraries[0].legs[0].routeId, 'R5');
  assert.equal(r.itineraries[1].transfers, 1);
  const ids = r.itineraries.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('itinerary carries route name and color from metadata', () => {
  const data = makeData();
  data.routes[0].name = 'Renamed Route';
  data.routes[0].jeepneyColorName = 'Teal';
  data.routes[0].displayColor = '#00AAAA';
  const leg = plan(data, near(stopOf(data, 'A')), near(stopOf(data, 'D'))).itineraries[0].legs[0];
  assert.equal(leg.routeName, 'Renamed Route');
  assert.equal(leg.jeepneyColorName, 'Teal');
  assert.equal(leg.displayColor, '#00AAAA');
});
