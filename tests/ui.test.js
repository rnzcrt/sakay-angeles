import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderRouteItem, renderRouteDetail, routeHasGeometry } from '../src/ui/routeList.js';
import { renderPlanResult, renderGeocodeChoices } from '../src/ui/tripResults.js';
import { planTrip, PLAN_STATUS } from '../src/routing/planner.js';
import { makeData, near, stopOf } from './fixtures.js';

const real = JSON.parse(readFileSync(new URL('../public/data/routes.json', import.meta.url), 'utf8')).routes;

test('9. route item renders name and color from supplied metadata', () => {
  const r = { ...real[0], name: 'Custom <Name>', jeepneyColorName: 'Teal', displayColor: '#00AAAA' };
  const html = renderRouteItem(r, { hasGeometry: true });
  assert.match(html, /Custom &lt;Name&gt;/);
  assert.match(html, /Teal jeepney/);
  assert.match(html, /#00AAAA/);
  assert.ok(!html.includes('<Name>'), 'must be escaped');
});

test('9. route item shows text, not just color, and disables toggle without geometry', () => {
  const html = renderRouteItem(real[2], { hasGeometry: false });
  assert.match(html, /White jeepney/);
  assert.match(html, /No digitized line yet/);
  assert.match(html, /disabled/);
});

test('9. itinerary rendering uses planner metadata', () => {
  const data = makeData();
  data.routes[0].name = 'Metadata Route';
  data.routes[0].jeepneyColorName = 'Mauve';
  data.routes[0].displayColor = '#ABCDEF';
  const result = planTrip({ origin: near(stopOf(data, 'A')), destination: near(stopOf(data, 'D')), data });
  const html = renderPlanResult(result);
  assert.match(html, /Metadata Route/);
  assert.match(html, /Mauve jeepney/);
  assert.match(html, /#ABCDEF/);
  assert.match(html, /Direct ride/);
});

test('9. UI and routing source files contain no hard-coded route names or colors', () => {
  const needles = real.flatMap((r) => [r.name, r.displayColor, r.jeepneyColorName]).filter((n) => n.length > 3);
  for (const dir of ['../src/ui/', '../src/routing/', '../src/map/']) {
    for (const f of readdirSync(new URL(dir, import.meta.url))) {
      const text = readFileSync(new URL(dir + f, import.meta.url), 'utf8');
      for (const n of needles) assert.ok(!text.includes(n), `${dir}${f} hard-codes "${n}"`);
    }
  }
});

test('non-success outcomes render honest states and never a route', () => {
  const none = renderPlanResult({ status: PLAN_STATUS.NO_VERIFIED_ROUTE, message: "We don't have enough verified route data to recommend a reliable trip yet.", itineraries: [], details: { verifiedDirectionCount: 0, excludedDirectionCount: 11 } });
  assert.match(none, /No verified route yet/);
  assert.match(none, /enough verified route data/);
  assert.ok(!/Board/.test(none));
  assert.match(renderPlanResult({ status: PLAN_STATUS.ORIGIN_TOO_FAR, message: 'x', details: { nearestStop: { name: 'S', distanceMeters: 900 } } }), /starting point is too far/);
  assert.match(renderPlanResult({ status: PLAN_STATUS.DATA_ERROR, message: 'bad', details: { errors: [{ message: 'oops' }] } }), /oops/);
});

test('route detail flags source ambiguities and unverified status', () => {
  const html = renderRouteDetail(real.find((r) => r.id === 'checkpoint-hensonville-holy'), { hasGeometry: false });
  assert.match(html, /To verify/);
  assert.match(html, /Holy Rosary Church/);
  assert.match(html, /Not verified/);
});

test('geocode choices flag results outside the service area', () => {
  const html = renderGeocodeChoices('origin', [{ label: 'Somewhere', inServiceArea: false }, { label: 'Else', inServiceArea: true }]);
  assert.match(html, /outside Angeles–Clark area/);
});

test('routeHasGeometry matches on routeId', () => {
  const g = { features: [{ properties: { routeId: 'a' } }] };
  assert.equal(routeHasGeometry({ id: 'a' }, g), true);
  assert.equal(routeHasGeometry({ id: 'b' }, g), false);
});

test('route detail shows secondary-source notes labelled as unverified', () => {
  const r = real.find((x) => x.id === 'sapang-bato-angeles');
  const html = renderRouteDetail(r, { hasGeometry: false });
  assert.match(html, /Unverified secondary source/);
  assert.match(html, /Not used for trip suggestions/);
});
