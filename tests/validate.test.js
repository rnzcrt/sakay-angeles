import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset } from '../src/data/validate.js';
import { makeData } from './fixtures.js';

const codes = (r) => r.errors.map((e) => e.code);
const line = (routeId, geometryId, coords = [[0, 0], [0.01, 0]]) => ({
  type: 'Feature', properties: { routeId, geometryId }, geometry: { type: 'LineString', coordinates: coords },
});
const withGeo = (data) => ({
  ...data,
  geojson: { type: 'FeatureCollection', features: [line('R1', 'geo-R1-out'), line('R2', 'geo-R2-out'), line('R4', 'geo-R4-out'), line('RU', 'geo-RU-out')] },
});

test('valid synthetic dataset passes', () => {
  const r = validateDataset(withGeo(makeData()));
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('8. broken stop references are caught', () => {
  const d = makeData();
  d.routes[0].directions[0].orderedStopIds.push('MISSING');
  assert.ok(codes(validateDataset(d)).includes('broken_reference'));
});

test('8. malformed / out-of-range coordinates are caught', () => {
  for (const bad of [[200, 0], [0, 95], ['x', 1], [1], null, [NaN, 0]]) {
    const d = makeData();
    d.stops[0].coordinates = bad;
    assert.ok(codes(validateDataset(d)).includes('invalid_coordinates'), JSON.stringify(bad));
  }
});

test('8. duplicate ids are caught for stops, routes, directions', () => {
  let d = makeData(); d.stops.push({ ...d.stops[0] });
  assert.ok(codes(validateDataset(d)).includes('duplicate_id'));
  d = makeData(); d.routes.push({ ...d.routes[0] });
  assert.ok(codes(validateDataset(d)).includes('duplicate_id'));
  d = makeData(); d.routes[1].directions[0].id = 'R1-out';
  assert.ok(codes(validateDataset(d)).includes('duplicate_id'));
});

test('8. malformed GeoJSON is caught', () => {
  const d = makeData();
  assert.ok(codes(validateDataset({ ...d, geojson: { type: 'Feature' } })).includes('malformed_geojson'));
  const g = withGeo(d);
  g.geojson.features[0].geometry = { type: 'Point', coordinates: [0, 0] };
  assert.ok(codes(validateDataset(g)).includes('malformed_geometry'));
  const h = withGeo(d);
  h.geojson.features[0].geometry.coordinates = [[0, 0]];
  assert.ok(codes(validateDataset(h)).includes('malformed_geometry'));
  const k = withGeo(d);
  k.geojson.features[0].geometry.coordinates = [[0, 0], [999, 0]];
  assert.ok(codes(validateDataset(k)).includes('invalid_coordinates'));
  const m = withGeo(d);
  m.geojson.features[0].properties.routeId = 'GHOST';
  assert.ok(codes(validateDataset(m)).includes('broken_reference'));
});

test('direction pointing at missing geometry is caught', () => {
  const g = withGeo(makeData());
  g.geojson.features.shift(); // drop geo for R1
  assert.ok(codes(validateDataset(g)).includes('broken_reference'));
});

test('a verified direction may not use unverified stops or lack geometry', () => {
  const d = makeData();
  d.routes[0].directions[0].orderedStopIds = ['A', 'U2'];
  assert.ok(codes(validateDataset(d)).includes('incomplete_verified'));
  const e = makeData();
  delete e.routes[0].directions[0].geometryId;
  assert.ok(codes(validateDataset(e)).includes('incomplete_verified'));
});

test('verified route geometry, directions, stops, and fare classes need traceable evidence', () => {
  const geometry = makeData();
  delete geometry.routes[0].geometryEvidence;
  assert.ok(codes(validateDataset(geometry)).includes('missing_verification_evidence'));

  const direction = makeData();
  delete direction.routes[0].directions[0].evidence;
  assert.ok(codes(validateDataset(direction)).includes('missing_verification_evidence'));

  const fare = makeData();
  fare.routes[0].fareClass = 'traditional';
  assert.ok(codes(validateDataset(fare)).includes('missing_verification_evidence'));
  fare.routes[0].fareClassEvidence = { source: 'PTRO', method: 'operator confirmation', checkedAt: '2026-10-20' };
  assert.equal(validateDataset(fare).valid, true);
  fare.routes[0].fareClassEvidence.checkedAt = '2026-99-99';
  assert.ok(codes(validateDataset(fare)).includes('missing_verification_evidence'));

  const stopSource = makeData();
  delete stopSource.stops[0].source;
  assert.ok(codes(validateDataset(stopSource)).includes('missing_verification_evidence'));
});

test('invalid verification statuses and transfers are caught', () => {
  const d = makeData();
  d.stops[0].verificationStatus = 'sure';
  d.transfers = [{ id: 't', fromStopId: 'A', toStopId: 'NOPE', walkMeters: -3, verificationStatus: 'verified' }];
  const c = codes(validateDataset(d));
  assert.ok(c.includes('invalid_status'));
  assert.ok(c.includes('broken_reference'));
  assert.ok(c.includes('malformed_transfer'));
});

test('non-object / missing arrays are reported', () => {
  assert.equal(validateDataset(null).valid, false);
  assert.equal(validateDataset({ routes: [] }).valid, false);
});
