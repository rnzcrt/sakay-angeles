import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRouteDraft, removeRouteData } from '../src/admin/routeManagement.js';
import { gatherRouteFormEdits } from '../src/admin/routeFareClass.js';
import { makeData } from './fixtures.js';

test('new Jeepney draft has a caller-supplied stable id and no invented geometry or directions', () => {
  const route = createRouteDraft('owner-entered-id');
  assert.equal(route.id, 'owner-entered-id');
  assert.equal(route.active, true);
  assert.equal(route.geometryStatus, 'unverified');
  assert.deepEqual(route.directions, []);
  assert.equal(Object.hasOwn(route, 'geometry'), false);
  assert.throws(() => createRouteDraft(''), /stable route id/);
});

test('route deletion removes associated stops and geometry atomically while preserving unrelated records', () => {
  const data = makeData();
  data.routes[0].directions[0].orderedStopIds = ['A'];
  data.stops[0].routeId = 'R1';
  data.stops[1].routeId = 'R1';
  data.geojson = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { routeId: 'R1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] } },
    { type: 'Feature', properties: { routeId: 'R2' }, geometry: { type: 'LineString', coordinates: [[0.01, 0], [0.02, 0]] } },
  ] };
  data.transfers = [];
  const unrelatedRoute = structuredClone(data.routes[1]);
  const result = removeRouteData(data, 'R1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.impact, { directions: 1, stops: 2, features: 1, transfers: 0 });
  assert.equal(result.data.routes.some((route) => route.id === 'R1'), false);
  assert.equal(result.data.stops.some((stop) => stop.routeId === 'R1'), false);
  assert.deepEqual(result.data.geojson.features.map((feature) => feature.properties.routeId), ['R2']);
  assert.deepEqual(result.data.routes.find((route) => route.id === 'R2'), unrelatedRoute);
  assert.equal(data.routes.some((route) => route.id === 'R1'), true, 'input dataset remains untouched on the client before confirmed save');
});

test('route deletion removes only transfers linked to its deleted stops', () => {
  const data = makeData();
  data.stops[0].routeId = 'R1';
  data.geojson = { type: 'FeatureCollection', features: [] };
  data.transfers = [
    { id: 'transfer-a', fromStopId: 'A', toStopId: 'B', walkMeters: 50, verificationStatus: 'unverified' },
    { id: 'transfer-unrelated', fromStopId: 'X1', toStopId: 'X2', walkMeters: 50, verificationStatus: 'unverified' },
  ];
  const result = removeRouteData(data, 'R1');
  assert.equal(result.ok, true);
  assert.equal(result.impact.transfers, 1);
  assert.deepEqual(result.data.transfers.map((transfer) => transfer.id), ['transfer-unrelated']);
  assert.equal(data.routes.some((route) => route.id === 'R1'), true, 'input dataset remains unchanged until confirmed save');
});

test('the production admin gather path edits metadata, directions, and visible stop order', () => {
  const route = {
    id: 'route-a', name: 'Route A', sourceLabel: 'A', jeepneyColorName: 'Blue', displayColor: '#123456',
    geometryStatus: 'unverified', description: '', fareClass: null,
    directions: [{ id: 'route-a-out', label: 'Outbound', startPoint: 'A', destination: 'B', verificationStatus: 'unverified', active: true, orderedStopIds: ['stop-a', 'stop-b'], geometryId: 'route-a-out-geo' }],
  };
  const controls = Object.fromEntries(['name', 'sourceLabel', 'description', 'colorName', 'color', 'colorText', 'active', 'startPoint', 'destination', 'via', 'fareClass', 'evidenceSource', 'evidenceMethod', 'evidenceDate']
    .map((key) => [key, { value: ({ name: 'Route A', sourceLabel: 'A', description: '', colorName: 'Blue', color: '#123456', colorText: '#abcdef', active: 'true', fareClass: '' })[key] ?? '' }]));
  const directionValues = { label: 'Outbound revised', startPoint: 'A', destination: 'B', via: '', description: 'Revised direction description', active: 'true' };
  const directionRow = { dataset: { direction: 'route-a-out' }, querySelector(selector) { return { value: directionValues[selector.match(/data-field="([^"]+)/)[1]] }; } };
  const stops = [
    { id: 'stop-a', routeId: 'route-a', directionId: 'route-a-out', name: 'A', kind: 'terminal', coordinates: [120, 15], verificationStatus: 'unverified' },
    { id: 'stop-b', routeId: 'route-a', directionId: 'route-a-out', name: 'B', kind: 'terminal', coordinates: [120.1, 15], verificationStatus: 'unverified' },
  ];
  const stopRows = [...stops].reverse().map((stop) => ({ dataset: { stop: stop.id }, querySelector(selector) {
    const field = selector.match(/data-field="([^"]+)/)[1];
    return { value: field === 'directionId' ? 'route-a-out' : field === 'name' ? stop.name : field === 'kind' ? stop.kind : field === 'lng' ? String(stop.coordinates[0]) : field === 'lat' ? String(stop.coordinates[1]) : '' };
  } }));
  const result = gatherRouteFormEdits({ route, controls, original: { fareClass: '', evidence: null }, stops, selectedId: route.id, originalStops: stops, stopRows, directionRows: [directionRow] });
  assert.equal(result.route.directions[0].label, 'Outbound revised');
  assert.equal(result.route.directions[0].description, 'Revised direction description');
  assert.equal(result.route.displayColor, '#abcdef', 'the editable color value is saved rather than the picker fallback');
  assert.equal(result.route.directions[0].geometryId, 'route-a-out-geo', 'unrelated geometry reference is preserved');
  assert.deepEqual(result.route.directions[0].orderedStopIds, ['stop-b', 'stop-a'], 'move-up/down DOM ordering controls the direction stop sequence');
  assert.deepEqual(result.stops.map((stop) => stop.id), ['stop-b', 'stop-a']);
});

test('the Admin page provides the simplified create, save, trace, and delete workflow', () => {
  const admin = readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  assert.match(admin, /import \{ createRouteDraft as makeRouteDraft, removeRouteData \} from '\.\/admin\/routeManagement\.js'/);
  assert.match(admin, /\$\('add-route'\)\.addEventListener\('click',[\s\S]*?createRouteDraft/);
  assert.match(admin, /removeRouteData\(dataset, route\.id\)/);
  assert.match(html, /id="add-route"[\s\S]*?>\s*Add Jeepney\s*<\/button>/);
  assert.match(html, /id="route-color-text"[^>]*pattern="#\[0-9a-fA-F\]\{6\}"/);
  assert.match(admin, /\$\('route-color-text'\)\.addEventListener\('input'/);
  assert.match(html, /id="save-route"[^>]*>[\s\S]*?Save Jeepney/);
  assert.match(html, /id="open-tracer"[^>]*>[\s\S]*?Open Road Tracer/);
  assert.doesNotMatch(html, /Starting point|Destination|Via \(optional\)|Fare classification evidence|Change record|<h3>Directions/);
  assert.match(admin, /metadataOnly: true/);
});
