import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDataset } from '../src/data/validate.js';
import { planTrip, buildGraph, PLAN_STATUS } from '../src/routing/planner.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const routesFile = read('routes.json');
const stopsFile = read('stops.json');
const dataset = { routes: routesFile.routes, stops: stopsFile.stops, transfers: stopsFile.transfers, geojson: read('routes.geojson') };

test('shipped data validates', () => {
  const r = validateDataset(dataset);
  assert.deepEqual(r.errors, []);
});

test('updated traces keep all route directions and their verified terminal links without verifying geometry', () => {
  assert.equal(dataset.geojson.features.length, 22);
  const routes = new Map(dataset.routes.map((route) => [route.id, route]));
  const stops = new Map(dataset.stops.map((stop) => [stop.id, stop]));
  const directionIds = dataset.geojson.features.map((feature) => feature.properties.directionId);
  assert.equal(new Set(directionIds).size, directionIds.length);
  assert.deepEqual(new Set(dataset.geojson.features.map((feature) => feature.properties.routeId)), new Set(routes.keys()));
  for (const feature of dataset.geojson.features) {
    const p = feature.properties;
    const route = routes.get(p.routeId);
    const start = stops.get(p.startStopId);
    const end = stops.get(p.endStopId);
    assert.ok(route, p.routeId);
    assert.ok(start && end, p.directionId);
    assert.equal(start.verificationStatus, 'verified');
    assert.equal(end.verificationStatus, 'verified');
    assert.equal(start.routeId, p.routeId);
    assert.equal(end.routeId, p.routeId);
    assert.equal(p.draft, true);
    assert.equal(route.geometryStatus, 'unverified');
    assert.ok(['LineString', 'MultiLineString'].includes(feature.geometry.type));
  }
});

test('all 11 legend routes exist with source labels and color names', () => {
  assert.equal(routesFile.routes.length, 11);
  const colors = routesFile.routes.map((r) => r.jeepneyColorName).sort();
  assert.deepEqual(colors, ['Blue', 'Green', 'Grey', 'Lavender', 'Maroon', 'Orange', 'Pink', 'Sand', 'Steel', 'White', 'Yellow']);
  for (const r of routesFile.routes) {
    assert.ok(r.sourceLabel && r.name && /^#[0-9A-Fa-f]{6}$/.test(r.displayColor), r.id);
    assert.equal(r.geometryStatus, 'unverified', `${r.id} must stay unverified until digitized`);
  }
});

test('legend spellings are preserved, not silently corrected', () => {
  const labels = routesFile.routes.map((r) => r.sourceLabel);
  assert.ok(labels.includes('SAPANG BATO - ANGLES'));
  assert.ok(labels.includes('PANDANG - PAMPANG'));
});

test('shipped data produces no_verified_route and never a made-up itinerary', () => {
  assert.equal(buildGraph(dataset).directions.length, 0);
  const r = planTrip({ origin: [120.59, 15.15], destination: [120.56, 15.17], data: dataset });
  assert.equal(r.status, PLAN_STATUS.NO_VERIFIED_ROUTE);
  assert.deepEqual(r.itineraries, []);
});

test('blog-derived notes are attached as unverified secondary sources and never alter legend labels', () => {
  assert.ok(routesFile.secondarySourceWarning);
  for (const r of routesFile.routes) {
    assert.equal(r.secondarySources.length, 1, r.id);
    assert.equal(r.secondarySources[0].status, 'unverified');
    assert.ok(r.secondarySources[0].conflictsWithLegend.length > 0, r.id);
  }
  assert.equal(routesFile.unmatchedSecondaryRoutes.length, 1);
  // legend wording is still what the app shows
  assert.ok(routesFile.routes.some((r) => r.jeepneyColorName === 'Maroon' && r.sourceLabel === 'SAPANG BATO - ANGLES'));
});

test('Pandan route uses the owner-confirmed display name; legend label is kept as printed', () => {
  const r = routesFile.routes.find((x) => x.id === 'pandang-pampang');
  assert.equal(r.name, 'Pandan – Pampang');
  assert.equal(r.sourceLabel, 'PANDANG - PAMPANG');
});
