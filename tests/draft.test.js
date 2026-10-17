import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftLines, planDraftTrip as planAny, DRAFT_STATUS, shiftToward } from '../src/routing/draftPlanner.js';
// The original tests describe the strict 500 m walking behaviour; new long-walk tests call planAny directly.
const planDraftTrip = (a) => planAny({ ...a, options: { maxWalkMeters: 500, ...a.options } });
import { renderDraftResult } from '../src/ui/tripResults.js';

// SYNTHETIC lines near 0°,0°: ~1.1 km per 0.01°.
const rt = (id) => ({ id, name: `Route ${id}`, jeepneyColorName: `C-${id}`, displayColor: '#123456' });
const feat = (routeId, coordinates) => ({ type: 'Feature', properties: { routeId }, geometry: { type: 'LineString', coordinates } });
const routes = [rt('H'), rt('V'), rt('F')];
const geo = {
  type: 'FeatureCollection',
  features: [
    feat('H', [[0, 0], [0.05, 0]]),                 // horizontal, ~5.5 km
    feat('V', [[0.03, -0.001], [0.03, 0.05]]),      // vertical, crosses H at x=0.03
    feat('F', [[0.2, 0.2], [0.25, 0.2]]),           // far away
  ],
};
const lines = buildDraftLines(geo, routes);

test('direct draft match when one line passes near both points', () => {
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  assert.equal(r.itineraries[0].transfers, 0);
  assert.equal(r.itineraries[0].legs[0].routeId, 'H');
  assert.ok(r.itineraries[0].approxRideMeters > 4000);
  assert.equal(r.itineraries[0].draft, true);
});

test('draft transfer only where lines actually come close', () => {
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.0303, 0.04], lines });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  const it = r.itineraries[0];
  assert.equal(it.transfers, 1);
  assert.deepEqual(it.legs.map((l) => l.routeId), ['H', 'V']);
  assert.ok(it.transferWalkMeters <= 150);
});

test('no match when lines do not connect or points are far', () => {
  assert.equal(planDraftTrip({ origin: [0.005, 0.0005], destination: [0.2, 0.2005], lines }).status, DRAFT_STATUS.NONE);
  assert.equal(planDraftTrip({ origin: [0.5, 0.5], destination: [0.045, 0.0005], lines }).status, DRAFT_STATUS.NONE);
  // two lines that never come within 150 m do not produce a transfer
  const apart = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]]), feat('V', [[0.03, 0.01], [0.03, 0.05]])] }, routes);
  assert.equal(planDraftTrip({ origin: [0.005, 0.0005], destination: [0.0303, 0.04], lines: apart }).status, DRAFT_STATUS.NONE);
});

test('too-short rides, invalid input and no lines are handled', () => {
  assert.equal(planDraftTrip({ origin: [0.005, 0.0005], destination: [0.006, 0.0005], lines }).status, DRAFT_STATUS.NONE);
  assert.equal(planDraftTrip({ origin: null, destination: [0, 0], lines }).status, 'invalid_input');
  assert.equal(planDraftTrip({ origin: [0, 0], destination: [0.01, 0], lines: [] }).status, DRAFT_STATUS.NO_LINES);
});

test('draft results are always rendered with an unverified warning and route metadata', () => {
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines });
  const html = renderDraftResult(r);
  assert.match(html, /Draft guidance only/);
  assert.match(html, /unverified/);
  assert.match(html, /Route H/);
  assert.match(renderDraftResult({ status: 'draft_none', message: 'x', itineraries: [] }), /Draft guidance only/);
});

test('each leg carries only the ridden segment, ordered from boarding to getting off', () => {
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines });
  const leg = r.itineraries[0].legs[0];
  assert.ok(leg.segment.length >= 2);
  const first = leg.segment[0];
  const last = leg.segment.at(-1);
  assert.ok(Math.abs(first[0] - leg.boardPoint[0]) < 0.0003 && Math.abs(last[0] - leg.alightPoint[0]) < 0.0003); // the stop is at the kerb, a few metres beside the line
  // the 0–0.05° line is cut down to roughly 0.005 → 0.045
  assert.ok(leg.segment.every((p) => p[0] >= 0.004 && p[0] <= 0.046));
  assert.equal(r.itineraries[0].walkLines.length, 2);
});

test('segment is reversed when riding against the traced order', () => {
  const r = planDraftTrip({ origin: [0.045, 0.0005], destination: [0.005, 0.0005], lines });
  const seg = r.itineraries[0].legs[0].segment;
  assert.ok(seg[0][0] > seg.at(-1)[0]);
});

test('estimated minutes are present and results are sorted fastest first', () => {
  const l2 = buildDraftLines({ features: [
    feat('H', [[0, 0], [0.05, 0]]),
    feat('V', [[0.03, -0.001], [0.03, 0.05]]),
    feat('S', [[0.0, 0.004], [0.05, 0.004]]), // slower: ~450 m walk each end
  ] }, [...routes, rt('S')]);
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines: l2 });
  const mins = r.itineraries.map((i) => i.estimatedMinutes);
  assert.ok(mins.every((m) => Number.isInteger(m) && m > 0));
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b));
  assert.equal(r.itineraries[0].legs[0].routeId, 'H');
});

test('an out-and-back traced line uses the shorter pass, not a mixed one', () => {
  // outbound along y=0, return along y=0.0003 (~33 m apart): a 550 m trip must not become a ~10 km ride
  const loop = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0], [0.05, 0.0003], [0, 0.0003]])] }, routes);
  const r = planDraftTrip({ origin: [0.005, 0.0002], destination: [0.01, 0.0002], lines: loop });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  assert.ok(r.itineraries[0].approxRideMeters < 1000, `ride was ${r.itineraries[0].approxRideMeters} m`);
});

test('rendered draft cards show the fastest badge and a rough-time note', () => {
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines });
  const html = renderDraftResult(r);
  assert.match(html, /Fastest \(estimated\)/);
  assert.match(html, /rough estimate/);
  assert.match(html, /not schedules/);
});

// ---- direction / one-way rules ----
const dirFeat = (routeId, direction, coordinates, extra = {}) => ({ type: 'Feature', properties: { routeId, direction, oneWay: true, ...extra }, geometry: { type: 'LineString', coordinates } });

test('a one-way line is only ridden in its traced direction', () => {
  const oneWay = buildDraftLines({ features: [dirFeat('H', 'a', [[0, 0], [0.05, 0]])] }, routes);
  const fwd = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.045, 0.0005], lines: oneWay });
  assert.equal(fwd.status, DRAFT_STATUS.SUCCESS);
  assert.equal(fwd.itineraries[0].legs[0].oneWay, true);
  const back = planDraftTrip({ origin: [0.045, 0.0005], destination: [0.005, 0.0005], lines: oneWay });
  assert.equal(back.status, DRAFT_STATUS.NONE);
});

test('a separately traced Route 2 makes the way back possible, on its own road', () => {
  const both = buildDraftLines({ features: [
    dirFeat('H', 'a', [[0, 0], [0.05, 0]]),
    dirFeat('H', 'b', [[0.05, 0.003], [0, 0.003]]), // the return uses a different road ~330 m north
  ] }, routes);
  const back = planDraftTrip({ origin: [0.045, 0.0032], destination: [0.005, 0.0032], lines: both });
  assert.equal(back.status, DRAFT_STATUS.SUCCESS);
  assert.equal(back.itineraries[0].legs[0].directionLabel, 'Route 2 (coming back)');
  // walking to the A road (330 m away) would also be possible but B must be the better match here
  assert.ok(back.itineraries[0].accessWalkMeters < 100);
});

test('a closed one-way loop can be ridden past its start point', () => {
  const loopCoords = [[0, 0], [0.03, 0], [0.03, 0.03], [0, 0.03], [0, 0.0002]];
  const loop = buildDraftLines({ features: [dirFeat('H', 'a', loopCoords)] }, routes);
  assert.equal(loop[0].isLoop, true);
  // from the north side back round to the start region: only possible by wrapping around the loop
  const r = planDraftTrip({ origin: [0.015, 0.0302], destination: [0.015, 0.0002], lines: loop });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  const open = buildDraftLines({ features: [dirFeat('H', 'a', [[0, 0], [0.03, 0], [0.03, 0.03], [0, 0.03]])] }, routes);
  assert.equal(open[0].isLoop, false);
  assert.equal(planDraftTrip({ origin: [0.015, 0.0302], destination: [0.015, 0.0002], lines: open }).status, DRAFT_STATUS.NONE);
});

test('legacy features without direction stay two-way', () => {
  const legacy = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]])] }, routes);
  assert.equal(legacy[0].oneWay, false);
  assert.equal(planDraftTrip({ origin: [0.045, 0.0005], destination: [0.005, 0.0005], lines: legacy }).status, DRAFT_STATUS.SUCCESS);
});

test('two directions of the same route are never chained as a transfer', () => {
  const both = buildDraftLines({ features: [dirFeat('H', 'a', [[0, 0], [0.03, 0]]), dirFeat('H', 'b', [[0.03, 0.0002], [0.06, 0.0002]])] }, routes);
  const r = planDraftTrip({ origin: [0.005, 0.0005], destination: [0.055, 0.0005], lines: both });
  assert.equal(r.status, DRAFT_STATUS.NONE);
});


test('Route 1 + Route 2 that join up are one jeepney loop: you can stay on board across the turnaround', () => {
  const R1 = dirFeat('H', 'a', [[0, 0], [0.05, 0]]);                 // going
  const R2 = dirFeat('H', 'b', [[0.05, 0], [0.05, 0.02], [0, 0.02], [0, 0.0002]]); // coming back by another road, ends at the start
  const lines = buildDraftLines({ features: [R1, R2] }, routes);
  assert.equal(lines.filter((l) => l.route.id === 'H').length, 1);
  assert.equal(lines[0].directionLabel, 'Route 1 + Route 2 (one loop)');
  assert.equal(lines[0].isLoop, true);
  // board near the end of Route 1, get off on the way back (Route 2): possible without changing jeepney
  const r = planDraftTrip({ origin: [0.045, 0.0002], destination: [0.02, 0.0202], lines });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  assert.equal(r.itineraries[0].transfers, 0);
  // and the way back is only ridden in its own direction
  const wrong = planDraftTrip({ origin: [0.02, 0.0202], destination: [0.045, 0.0002], lines });
  assert.equal(wrong.status, DRAFT_STATUS.SUCCESS);
  assert.ok(wrong.itineraries[0].approxRideMeters > r.itineraries[0].approxRideMeters);
});

test('Route 1 and Route 2 that do not join up stay separate one-way lines', () => {
  const lines = buildDraftLines({ features: [dirFeat('H', 'a', [[0, 0], [0.05, 0]]), dirFeat('H', 'b', [[0.08, 0.02], [0.03, 0.02]])] }, routes);
  assert.equal(lines.filter((l) => l.route.id === 'H').length, 2);
});


// ---- far trips, nearest-first ordering, kerb side ----
test('far trips still get a route: walk to the line, ride, walk from the drop-off', () => {
  // start 2.2 km north of the H line, destination 2.2 km south of it (well beyond 500 m)
  const lines = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]])] }, routes);
  assert.equal(planDraftTrip({ origin: [0.005, 0.02], destination: [0.045, -0.02], lines }).status, DRAFT_STATUS.NONE); // strict 500 m
  const r = planAny({ origin: [0.005, 0.02], destination: [0.045, -0.02], lines });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  const it = r.itineraries[0];
  assert.ok(it.accessWalkMeters > 2000 && it.egressWalkMeters > 2000);
  assert.equal(it.walkLines.length, 2);
  assert.equal(it.legs[0].routeId, 'H');
});

test('too far from every route (beyond the walking limit) explains how far', () => {
  const lines = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]])] }, routes);
  const r = planAny({ origin: [0.005, 0.2], destination: [0.045, 0.0005], lines });
  assert.equal(r.status, DRAFT_STATUS.NONE);
  assert.match(r.message, /Your start is \d+\.\d km from the nearest traced route/);
  assert.ok(r.details.originGapMeters > 20000);
});

test('the option with the nearest start and drop-off is first; the quickest is badged too', () => {
  // Line N passes right next to both points but is slow to get around; line F is 450 m away from both but short
  const lines = buildDraftLines({ features: [
    feat('H', [[0.005, 0.0002], [0.005, 0.02], [0.045, 0.02], [0.045, 0.0002]]), // passes right beside both points but goes a long way round between them
    feat('V', [[0, 0.0045], [0.05, 0.0045]]),                                              // direct, but ~490 m north of the points
  ] }, routes);
  const r = planAny({ origin: [0.005, 0.0], destination: [0.045, 0.0], lines });
  assert.equal(r.status, DRAFT_STATUS.SUCCESS);
  const [first] = r.itineraries;
  assert.ok(first.totalWalkMeters < 100, `first option walk was ${first.totalWalkMeters} m`);
  const fastest = r.itineraries.find((i) => i.isFastest);
  assert.ok(fastest);
  assert.equal(r.itineraries.filter((i) => i.isFastest).length, 1);
  const bestMinutes = Math.min(...r.itineraries.map((i) => i.estimatedMinutes));
  assert.equal(fastest.estimatedMinutes, bestMinutes);
});

test('the stop is on the same side of the road as the person (shifted toward them)', () => {
  const lines = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]])] }, routes);
  // start north of the road, destination south of the road, each ~110 m from the line
  const r = planAny({ origin: [0.005, 0.001], destination: [0.045, -0.001], lines });
  const leg = r.itineraries[0].legs[0];
  assert.ok(leg.boardPoint[1] > 0, 'boarding stop should be on the north (start) side');
  assert.ok(leg.alightPoint[1] < 0, 'drop-off should be on the south (destination) side');
  assert.ok(leg.boardPoint[1] < 0.001 && leg.alightPoint[1] > -0.001);
  // walking is shortened by the kerb shift (about 110 m − 10 m)
  assert.ok(r.itineraries[0].accessWalkMeters < 105 && r.itineraries[0].accessWalkMeters > 95);
});

test('shiftToward moves a point toward a target by at most the given metres', () => {
  const p = [0, 0];
  const q = shiftToward(p, [0, 0.001], 10); // target ~111 m north
  assert.ok(q[1] > 0 && q[1] < 0.0002);
  assert.deepEqual(shiftToward(p, [0, 0.00001], 10), [0, 0.00001]); // closer than 10 m: lands on the target
  assert.deepEqual(shiftToward(p, p, 10), p);
});

test('results label long walks and show the nearest/fastest badges', () => {
  const lines = buildDraftLines({ features: [feat('H', [[0, 0], [0.05, 0]])] }, routes);
  const r = planAny({ origin: [0.005, 0.02], destination: [0.045, -0.02], lines });
  const html = renderDraftResult(r);
  assert.match(html, /a long walk/);
  assert.match(html, /on foot/);
  assert.match(html, /Nearest start &amp; drop-off/);
  assert.match(html, /same side of the road as your destination/);
});
