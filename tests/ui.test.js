import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderRouteItem, renderRouteDetail, routeHasGeometry, ROUTE_LIST_PREFERENCE_KEY, initializeRouteList, toggleRouteList } from '../src/ui/routeList.js';
import { renderPlanResult, renderGeocodeChoices } from '../src/ui/tripResults.js';
import { planTrip, PLAN_STATUS } from '../src/routing/planner.js';
import { makeData, near, stopOf } from './fixtures.js';

const real = JSON.parse(readFileSync(new URL('../public/data/routes.json', import.meta.url), 'utf8')).routes;

function routeListControls() {
  const list = { hidden: false };
  const button = {
    label: 'Collapse routes', expanded: 'true',
    getAttribute(name) { return name === 'aria-expanded' ? this.expanded : null; },
    setAttribute(name, value) { if (name === 'aria-expanded') this.expanded = value; },
    get textContent() { return this.label; },
    set textContent(value) { this.label = value; },
  };
  return { list, button };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    dump(key) { return values.get(key); },
  };
}

test('route list preference defaults to expanded for first-time visitors', () => {
  const { list, button } = routeListControls();
  const visible = new Set(['route-a']);
  const originalVisibility = new Set(visible);

  assert.equal(initializeRouteList(list, button, memoryStorage()), true);
  assert.equal(list.hidden, false);
  assert.equal(button.textContent, 'Collapse routes');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(visible, originalVisibility);
});

test('route list preference restores collapsed and expanded states', () => {
  const visible = new Set(['route-a', 'route-b']);
  const originalVisibility = new Set(visible);
  const collapsed = routeListControls();
  assert.equal(initializeRouteList(collapsed.list, collapsed.button, memoryStorage({ [ROUTE_LIST_PREFERENCE_KEY]: 'collapsed' })), false);
  assert.equal(collapsed.list.hidden, true);
  assert.equal(collapsed.button.textContent, 'Expand routes');
  assert.equal(collapsed.button.getAttribute('aria-expanded'), 'false');

  const expanded = routeListControls();
  assert.equal(initializeRouteList(expanded.list, expanded.button, memoryStorage({ [ROUTE_LIST_PREFERENCE_KEY]: 'expanded' })), true);
  assert.equal(expanded.list.hidden, false);
  assert.equal(expanded.button.textContent, 'Collapse routes');
  assert.equal(expanded.button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(visible, originalVisibility);
});

test('invalid route-list preference defaults to expanded', () => {
  const { list, button } = routeListControls();
  assert.equal(initializeRouteList(list, button, memoryStorage({ [ROUTE_LIST_PREFERENCE_KEY]: 'sometimes' })), true);
  assert.equal(list.hidden, false);
  assert.equal(button.textContent, 'Collapse routes');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
});

test('unavailable and throwing storage reads do not break route-list initialization', () => {
  const unavailable = routeListControls();
  assert.equal(initializeRouteList(unavailable.list, unavailable.button, null), true);
  assert.equal(unavailable.list.hidden, false);

  const throwing = routeListControls();
  assert.equal(initializeRouteList(throwing.list, throwing.button, { getItem() { throw new Error('blocked'); } }), true);
  assert.equal(throwing.button.textContent, 'Collapse routes');
  assert.equal(throwing.button.getAttribute('aria-expanded'), 'true');
});

test('route-list toggles update labels and preference without changing route visibility', () => {
  const { list, button } = routeListControls();
  const visible = new Set(['route-a', 'route-b']);
  const originalVisibility = new Set(visible);
  const storage = memoryStorage();

  assert.equal(toggleRouteList(list, button, storage), false);
  assert.equal(list.hidden, true);
  assert.equal(button.textContent, 'Expand routes');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(storage.dump(ROUTE_LIST_PREFERENCE_KEY), 'collapsed');
  assert.deepEqual(visible, originalVisibility);

  assert.equal(toggleRouteList(list, button, storage), true);
  assert.equal(list.hidden, false);
  assert.equal(button.textContent, 'Collapse routes');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(storage.dump(ROUTE_LIST_PREFERENCE_KEY), 'expanded');
  assert.deepEqual(visible, originalVisibility);
});

test('throwing storage writes do not prevent the current-page route-list toggle', () => {
  const { list, button } = routeListControls();
  initializeRouteList(list, button, null);
  const storage = { setItem() { throw new Error('blocked'); } };
  assert.equal(toggleRouteList(list, button, storage), false);
  assert.equal(list.hidden, true);
  assert.equal(button.textContent, 'Expand routes');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('public route toolbar removes Fit Routes and retains map visibility controls', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="fit-btn"|Fit routes/i);
  assert.match(html, /id="route-list-toggle-btn"[^>]*aria-controls="route-list"[^>]*aria-expanded="true"[^>]*>Collapse routes/);
  assert.match(source, /\$\('show-all-btn'\)\.onclick = \(\) => \{ state\.visible = new Set\(routesWithGeometry\(\)\.map/);
  assert.match(source, /\$\('hide-all-btn'\)\.onclick = \(\) => \{ state\.visible = new Set\(\);/);
  assert.match(source, /const id = e\.target\.dataset\?\.routeToggle;[\s\S]*?state\.visible\.add\(id\); else state\.visible\.delete\(id\);/);
  const storageInitialization = source.indexOf('try { state.storage = window.localStorage;');
  const preferenceInitialization = source.indexOf('initializeRouteList($(\'route-list\'), $(\'route-list-toggle-btn\'), state.storage);');
  const firstRouteRender = source.indexOf('renderDataBanner(); renderLegend(); renderRouteList(); bindEvents();');
  assert.ok(storageInitialization >= 0 && storageInitialization < preferenceInitialization && preferenceInitialization < firstRouteRender,
    'saved preference is applied after storage setup and before the first route render');
  assert.match(source, /toggleRouteList\(\$\('route-list'\), \$\('route-list-toggle-btn'\), state\.storage\)/);
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
