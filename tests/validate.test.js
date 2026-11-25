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

test('verified geometry and stops need evidence; optional fare evidence is validated when present', () => {
  const geometry = makeData();
  delete geometry.routes[0].geometryEvidence;
  assert.ok(codes(validateDataset(geometry)).includes('missing_verification_evidence'));

  const direction = makeData();
  delete direction.routes[0].directions[0].evidence;
  assert.ok(codes(validateDataset(direction)).includes('missing_verification_evidence'));

  const fare = makeData();
  fare.routes[0].fareClass = 'traditional';
  assert.equal(validateDataset(fare).valid, true);
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

test('optional active flags must be booleans and legacy records remain compatible', () => {
  const legacy = makeData();
  assert.equal(validateDataset(legacy).valid, true, 'records without active flags preserve existing behavior');
  const d = makeData();
  d.routes[0].active = false;
  d.routes[0].directions[0].active = true;
  assert.equal(validateDataset(d).valid, true);
  d.routes[0].directions[0].active = 'no';
  assert.ok(codes(validateDataset(d)).includes('malformed_direction'));
  d.routes[0].directions[0].active = true;
  d.routes[0].active = 0;
  assert.ok(codes(validateDataset(d)).includes('malformed_route'));
});

test('direction-associated stops must reference a direction on the same route', () => {
  const d = makeData();
  d.stops[0].routeId = 'R1';
  d.stops[0].directionId = 'R1-out';
  assert.equal(validateDataset(d).valid, true);
  d.stops[0].directionId = 'missing-direction';
  assert.ok(codes(validateDataset(d)).includes('broken_reference'));
  d.stops[0].directionId = 'R2-out';
  assert.ok(codes(validateDataset(d)).includes('broken_reference'));
});

test('stop order is unique and stop-direction assignments agree in both directions', () => {
  const duplicate = makeData();
  duplicate.routes[0].directions[0].orderedStopIds = ['A', 'B', 'A'];
  assert.ok(codes(validateDataset(duplicate)).includes('malformed_direction'));

  const mismatch = makeData();
  mismatch.stops[0].routeId = 'R1';
  mismatch.stops[0].directionId = 'R1-out';
  mismatch.routes[0].directions[0].orderedStopIds = ['B', 'C', 'D'];
  assert.ok(codes(validateDataset(mismatch)).includes('broken_reference'));

  const crossDirection = makeData();
  crossDirection.stops[0].routeId = 'R1';
  crossDirection.stops[0].directionId = 'R2-out';
  assert.ok(codes(validateDataset(crossDirection)).includes('broken_reference'));
});

test('geometry direction IDs must resolve while legacy a/b feature IDs remain compatible', () => {
  const d = withGeo(makeData());
  d.geojson.features[0].properties.directionId = 'R1-out';
  assert.equal(validateDataset(d).valid, true);
  d.geojson.features[0].properties.directionId = 'R1-ghost';
  assert.ok(codes(validateDataset(d)).includes('broken_reference'));
  const legacy = withGeo(makeData());
  legacy.routes[0].directions = [];
  legacy.geojson.features[0].properties.directionId = 'R1-a';
  legacy.geojson.features[0].properties.direction = 'a';
  assert.equal(validateDataset(legacy).valid, true, 'legacy direction feature IDs remain valid before explicit directions exist');
});

test('explicit geometry direction and geometry references must resolve consistently', () => {
  const matchingById = withGeo(makeData());
  matchingById.geojson.features[0].properties.directionId = 'R1-out';
  assert.equal(validateDataset(matchingById).valid, true);

  const wrongGeometry = withGeo(makeData());
  wrongGeometry.geojson.features[0].properties.directionId = 'R1-out';
  wrongGeometry.geojson.features[0].properties.geometryId = 'unrelated-geometry';
  assert.ok(codes(validateDataset(wrongGeometry)).includes('broken_reference'));

  const unknownDirectionWithKnownGeometry = withGeo(makeData());
  unknownDirectionWithKnownGeometry.geojson.features[0].properties.directionId = 'R1-ghost';
  assert.ok(codes(validateDataset(unknownDirectionWithKnownGeometry)).includes('broken_reference'));

  const geometryOnly = withGeo(makeData());
  delete geometryOnly.geojson.features[0].properties.directionId;
  assert.equal(validateDataset(geometryOnly).valid, true, 'a stored geometryId can associate a feature with its direction');

  const partialLegacy = withGeo(makeData());
  partialLegacy.geojson.features.push({
    type: 'Feature',
    properties: { routeId: 'R1', directionId: 'R1-b', direction: 'b', geometryId: 'legacy-R1-b' },
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] },
  });
  assert.equal(validateDataset(partialLegacy).valid, true, 'an exact legacy a/b feature remains compatible beside explicit directions');

  const generatedGeometryId = withGeo(makeData());
  generatedGeometryId.routes[0].geometryStatus = 'unverified';
  generatedGeometryId.routes[0].directions[0].verificationStatus = 'unverified';
  generatedGeometryId.routes[0].directions[0].geometryId = undefined;
  generatedGeometryId.geojson.features[0].properties.directionId = 'R1-out';
  generatedGeometryId.geojson.features[0].properties.geometryId = 'R1-out-draft';
  assert.equal(validateDataset(generatedGeometryId).valid, true, 'a direction ID can associate a newly drawn feature before a stored geometryId exists');
});

test('non-object / missing arrays are reported', () => {
  assert.equal(validateDataset(null).valid, false);
  assert.equal(validateDataset({ routes: [] }).valid, false);
});
