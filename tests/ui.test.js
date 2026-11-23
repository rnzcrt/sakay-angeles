import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderRouteItem, renderRouteDetail, routeHasGeometry, toggleRouteList } from '../src/ui/routeList.js';
import { renderPlanResult, renderGeocodeChoices } from '../src/ui/tripResults.js';
import { planTrip, PLAN_STATUS } from '../src/routing/planner.js';
import { makeData, near, stopOf } from './fixtures.js';

const real = JSON.parse(readFileSync(new URL('../public/data/routes.json', import.meta.url), 'utf8')).routes;

test('route list collapse toggles only the list and keeps its state separate from route visibility', () => {
  const list = { hidden: false };
  const button = {
    label: 'Collapse routes', expanded: 'true',
    getAttribute(name) { return name === 'aria-expanded' ? this.expanded : null; },
    setAttribute(name, value) { if (name === 'aria-expanded') this.expanded = value; },
    get textContent() { return this.label; },
    set textContent(value) { this.label = value; },
  };
  const visible = new Set(['route-a', 'route-b']);
  const originalVisibility = new Set(visible);

  assert.equal(toggleRouteList(list, button), false);
  assert.equal(list.hidden, true);
  assert.equal(button.textContent, 'Expand routes');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(visible, originalVisibility);

  assert.equal(toggleRouteList(list, button), true);
  assert.equal(list.hidden, false);
  assert.equal(button.textContent, 'Collapse routes');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(visible, originalVisibility);
});

test('public route toolbar removes Fit Routes and retains map visibility controls', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="fit-btn"|Fit routes/i);
  assert.match(html, /id="route-list-toggle-btn"[^>]*aria-controls="route-list"[^>]*aria-expanded="true"[^>]*>Collapse routes/);
  assert.match(source, /\$\('show-all-btn'\)\.onclick = \(\) => \{ state\.visible = new Set\(routesWithGeometry\(\)\.map/);
  assert.match(source, /\$\('hide-all-btn'\)\.onclick = \(\) => \{ state\.visible = new Set\(\);/);
  assert.match(source, /const id = e\.target\.dataset\?\.routeToggle;[\s\S]*?state\.visible\.add\(id\); else state\.visible\.delete\(id\);/);
  assert.match(source, /fitToRoutes/);
  assert.doesNotMatch(source, /\$\('fit-btn'\)/);
});

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
  assert.match(html, /Needs a route line/);
  assert.match(html, /disabled/);
});

test('ready-to-trace route shows its status and vehicle details without a map line', () => {
  const route = real.find((r) => r.id === 'angeles-san-fernando');
  const list = renderRouteItem(route, { hasGeometry: false, visible: false });
  assert.match(list, /Angeles City – San Fernando City/);
  assert.match(list, /Silver jeepney · Ready for tracing/);
  assert.match(list, /disabled/);
  assert.doesNotMatch(list, /checked/);
  const detail = renderRouteDetail(route, { hasGeometry: false });
  assert.match(detail, /Traditional Philippine jeepney/);
  assert.match(detail, /Requested direction.*Angeles City to San Fernando City/);
  assert.match(detail, /Needs confirmation/);
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
  assert.match(none, /We're still adding route details/);
  assert.doesNotMatch(none, /verified direction records/);
  assert.ok(!/Board/.test(none));
  assert.match(renderPlanResult({ status: PLAN_STATUS.ORIGIN_TOO_FAR, message: 'x', details: { nearestStop: { name: 'S', distanceMeters: 900 } } }), /Try a closer starting point/);
  assert.match(renderPlanResult({ status: PLAN_STATUS.DATA_ERROR, message: 'bad', details: { errors: [{ message: 'oops' }] } }), /We couldn't find a route/);
});

test('public route detail shows community testing and a route-specific feedback action', () => {
  const html = renderRouteDetail(real.find((r) => r.id === 'checkpoint-hensonville-holy'), { hasGeometry: false });
  assert.match(html, /Needs confirmation/);
  assert.match(html, /Fare not confirmed/);
  assert.match(html, /data-report-routes="checkpoint-hensonville-holy"/);
  assert.doesNotMatch(html, /Unverified secondary source/);
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

test('public route detail does not expose internal source conflict notes', () => {
  const r = real.find((x) => x.id === 'sapang-bato-angeles');
  const html = renderRouteDetail(r, { hasGeometry: false });
  assert.match(html, /Report a route issue/);
  assert.doesNotMatch(html, /The Pooch of the Philippines/);
});
