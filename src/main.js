import './styles.css';
import { SOURCE_ATTRIBUTION, MAP_CONFIG, GEOCODING_CONFIG } from './config.js';
import { loadData } from './data/loadData.js';
import { mergeLocalDrafts, setIgnoreLocal } from './data/localDrafts.js';
import { planTrip, buildGraph, PLAN_STATUS } from './routing/planner.js';
import { createMap } from './map/createMap.js';
import { addRouteLayers, applyVisibility, onRouteClick, fitToRoutes, makeMarker, addTripLayers, setTripGeometry, fitToCoordinates } from './map/routeLayers.js';
import { requestLocation } from './services/geolocation.js';
import { searchPlaces } from './services/geocoding.js';
import { renderRouteItem, renderRouteDetail, routeHasGeometry } from './ui/routeList.js';
import { renderPlanResult, renderGeocodeChoices, renderDraftResult } from './ui/tripResults.js';
import { buildDraftLines, planDraftTrip, DRAFT_STATUS } from './routing/draftPlanner.js';
import { renderReferenceMaps } from './ui/referenceMaps.js';
import { createNotifier } from './ui/notifications.js';
import { escapeHtml } from './ui/html.js';

const $ = (id) => document.getElementById(id);
const notify = createNotifier({ statusEl: $('status-live'), alertEl: $('alert-banner') });

const state = {
  data: null,
  graph: null,
  map: null,
  mapReady: false,
  selectedRouteId: null,
  visible: new Set(),
  points: { origin: null, destination: null }, // { coordinates, label }
  markers: { origin: null, destination: null },
  stopMarkers: [],
  pick: null, // { target, sequence }
  result: null,
  selectedItinerary: 0,
  tripActive: false,
  choices: { origin: [], destination: [] },
  draftLines: [],
  local: { used: [], hasLocal: false, ignored: false },
  storage: null,
  draftResult: null,
  draftIndex: 0,
};

$('source-note').textContent = `${SOURCE_ATTRIBUTION.text} ${SOURCE_ATTRIBUTION.permissionNote}`;
$('attribution-note').textContent = `${MAP_CONFIG.attributionText} · ${GEOCODING_CONFIG.attribution}`;
renderReferenceMaps($('ref-list'));

// ---------- rendering ----------
const routesWithGeometry = () => state.data.routes.filter((r) => routeHasGeometry(r, state.data.geojson));

function renderLegend() {
  const hasLines = routesWithGeometry().length > 0;
  $('map-legend').innerHTML = `<strong>Map guide</strong>
    <div class="legend-row"><span class="legend-solid"></span> Verified route line</div>
    <div class="legend-row"><span class="legend-dash"></span> Illustrative draft (unverified)</div>
    ${hasLines ? '' : '<div class="legend-row">No route lines have been digitized yet.</div>'}`;
}

function renderRouteList() {
  const { routes, geojson } = state.data;
  $('route-list').innerHTML = routes
    .map((r) => renderRouteItem(r, { selected: r.id === state.selectedRouteId, visible: state.visible.has(r.id), hasGeometry: routeHasGeometry(r, geojson) }))
    .join('');
  $('route-count').textContent = `${routes.length} routes`;
}

function localNote() {
  const { used, hasLocal, ignored, replaced } = state.local;
  if (replaced) {
    return `<div class="local-note"><b>Showing only the routes you traced</b> (${used.length} of ${state.data.routes.length}); the old lines are hidden.<button type="button" id="local-toggle">Use the shipped file instead</button></div>`;
  }
  if (used.length) {
    return `<div class="local-note"><b>Using lines you traced in this browser</b> (route tracer) for: ${used.map(escapeHtml).join(', ')}.<button type="button" id="local-toggle">Use the shipped file instead</button></div>`;
  }
  if (hasLocal && ignored) return '<div class="local-note">Your traced lines are being ignored.<button type="button" id="local-toggle">Use my traced lines</button></div>';
  return '';
}

function renderDataBanner() {
  const { routes } = state.data;
  const usable = new Set(state.graph.directions.map((d) => d.routeId)).size;
  $('data-banner').innerHTML = `<b>Prototype data notice.</b> ${routes.length} routes are listed from the source legend; <b>${usable}</b> ${usable === 1 ? 'has' : 'have'} verified stops and geometry that can be used for trip suggestions. ${usable === 0 ? 'Trip suggestions are unavailable until route data is verified — you can still browse routes and the reference maps.' : ''}` + localNote();
}

function syncMap() {
  if (!state.mapReady) return;
  applyVisibility(state.map, [...state.visible], state.selectedRouteId);
}

function selectRoute(id) {
  state.selectedRouteId = state.selectedRouteId === id ? null : id;
  const route = state.data.routes.find((r) => r.id === state.selectedRouteId);
  const has = route ? routeHasGeometry(route, state.data.geojson) : false;
  $('route-detail').innerHTML = route ? renderRouteDetail(route, { hasGeometry: has }) : '';
  if (route && has) {
    state.visible.add(route.id);
    if (state.mapReady) fitToRoutes(state.map, state.data.geojson, [route.id]);
  } else if (route) notify.status(`${route.name}: no digitized line yet. See the details below and the reference maps.`);
  renderRouteList();
  syncMap();
}

// ---------- points & markers ----------
function setPoint(which, coordinates, label) {
  state.points[which] = { coordinates, label };
  state.markers[which]?.remove();
  state.markers[which] = state.mapReady
    ? makeMarker(state.map, which, coordinates, `${which === 'origin' ? 'Starting point' : 'Destination'}: ${label}`)
    : null;
  $(which === 'origin' ? 'origin' : 'destination').value = label;
  $(`${which}-choices`).innerHTML = '';
  if (state.mapReady) state.map.easeTo({ center: coordinates, zoom: Math.max(state.map.getZoom(), 14) });
}

function clearPoint(which) {
  state.points[which] = null;
  state.markers[which]?.remove();
  state.markers[which] = null;
}

function clearTrip() {
  for (const w of ['origin', 'destination']) { clearPoint(w); $(w).value = ''; $(`${w}-choices`).innerHTML = ''; }
  clearStopMarkers();
  clearTripGeometry();
  state.result = null;
  state.tripActive = false;
  $('results').innerHTML = '';
  cancelPick();
  state.visible = new Set(routesWithGeometry().map((r) => r.id));
  renderRouteList();
  syncMap();
  notify.status('Trip cleared.');
}

function swapTrip() {
  const o = state.points.origin;
  const d = state.points.destination;
  const ov = $('origin').value;
  const dv = $('destination').value;
  clearPoint('origin');
  clearPoint('destination');
  $('origin').value = dv;
  $('destination').value = ov;
  $('origin-choices').innerHTML = '';
  $('destination-choices').innerHTML = '';
  if (d) setPoint('origin', d.coordinates, d.label);
  if (o) setPoint('destination', o.coordinates, o.label);
  notify.status('Start and destination switched.');
  if (state.points.origin && state.points.destination) findRoute();
}

function clearStopMarkers() {
  state.stopMarkers.forEach((m) => m.remove());
  state.stopMarkers = [];
}

// ---------- map picking ----------
function startPick(target, sequence = false) {
  if (!state.mapReady) { notify.alert('The map is not available, so picking on the map is not possible. Use search instead.'); return; }
  state.pick = { target, sequence };
  state.map.getContainer().classList.add('picking');
  $('pick-banner').hidden = false;
  $('pick-text').textContent = target === 'origin' ? 'Tap the map to set your starting point' : 'Tap the map to set your destination';
  notify.status($('pick-text').textContent);
}

function cancelPick() {
  state.pick = null;
  state.map?.getContainer().classList.remove('picking');
  $('pick-banner').hidden = true;
}

function handleMapClick(e) {
  if (!state.pick) return;
  const { target, sequence } = state.pick;
  const c = [e.lngLat.lng, e.lngLat.lat];
  setPoint(target, c, `Pinned location (${c[1].toFixed(5)}, ${c[0].toFixed(5)})`);
  if (sequence && target === 'origin') startPick('destination', false);
  else cancelPick();
}

// ---------- search ----------
async function runSearch(which) {
  const input = $(which);
  const out = $(`${which}-choices`);
  out.innerHTML = '<p class="muted">Searching…</p>';
  const res = await searchPlaces(input.value);
  if (!res.ok) { out.innerHTML = `<p class="muted" role="alert">${escapeHtml(res.message)}</p>`; return false; }
  if (res.results.length === 0) {
    out.innerHTML = '<p class="muted">No matching place found. Try a nearby landmark, or pick the point on the map.</p>';
    return false;
  }
  state.choices[which] = res.results;
  if (res.results.length === 1 && res.results[0].inServiceArea) {
    setPoint(which, res.results[0].coordinates, res.results[0].label);
    return true;
  }
  out.innerHTML = renderGeocodeChoices(which, res.results);
  return false;
}

// ---------- trip ----------
function visibleForItinerary(it) {
  return new Set(it.legs.filter((l) => l.type === 'ride').map((l) => l.routeId));
}

function showItinerary(index) {
  const it = state.result.itineraries[index];
  state.selectedItinerary = index;
  state.tripActive = true;
  state.visible = visibleForItinerary(it);
  clearStopMarkers();
  if (state.mapReady) {
    for (const leg of it.legs.filter((l) => l.type === 'ride')) {
      state.stopMarkers.push(makeMarker(state.map, 'stop', leg.boardStop.coordinates, `Board at ${leg.boardStop.name}`));
      state.stopMarkers.push(makeMarker(state.map, 'stop', leg.alightStop.coordinates, `Get off at ${leg.alightStop.name}`));
    }
    fitToRoutes(state.map, state.data.geojson, [...state.visible]);
  }
  $('results').innerHTML = renderPlanResult(state.result, index) +
    '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
  renderRouteList();
  syncMap();
}

function clearTripGeometry() {
  if (state.mapReady) setTripGeometry(state.map);
}

function showDraftItinerary(index) {
  const it = state.draftResult.itineraries[index];
  state.draftIndex = index;
  // Cut the map down to what matters: hide whole routes, draw only the ridden stretches.
  state.visible = new Set();
  clearStopMarkers();
  if (state.mapReady) {
    setTripGeometry(state.map, it.legs, it.walkLines);
    it.legs.forEach((l) => {
      state.stopMarkers.push(makeMarker(state.map, 'stop', l.boardPoint, `Approximate boarding point on ${l.routeName}`));
      state.stopMarkers.push(makeMarker(state.map, 'stop', l.alightPoint, `Approximate drop-off point on ${l.routeName}`));
    });
    fitToCoordinates(state.map, [...it.legs.flatMap((l) => l.segment), ...it.walkLines.flat()]);
  }
  $('results').innerHTML = renderDraftResult(state.draftResult, index) +
    '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
  renderRouteList();
  syncMap();
}

async function findRoute() {
  notify.clearAlert();
  for (const w of ['origin', 'destination']) {
    if (!state.points[w] && $(w).value.trim()) {
      const ok = await runSearch(w);
      if (!ok) { notify.alert(`Choose your ${w === 'origin' ? 'starting point' : 'destination'} from the search results first.`); return; }
    }
  }
  const result = planTrip({
    origin: state.points.origin?.coordinates,
    destination: state.points.destination?.coordinates,
    data: state.data,
    options: { graph: state.graph, skipValidation: true },
  });
  state.result = result;
  if (result.status === PLAN_STATUS.SUCCESS) {
    showItinerary(0);
    notify.status(`${result.itineraries.length} journey option${result.itineraries.length === 1 ? '' : 's'} found.`);
  } else if (result.status === PLAN_STATUS.NO_VERIFIED_ROUTE && state.draftLines.length) {
    const draft = planDraftTrip({ origin: state.points.origin.coordinates, destination: state.points.destination.coordinates, lines: state.draftLines });
    state.draftResult = draft;
    if (draft.status === DRAFT_STATUS.SUCCESS) {
      showDraftItinerary(0);
      notify.status(`${draft.itineraries.length} draft suggestion${draft.itineraries.length === 1 ? '' : 's'} found. These are unverified.`);
    } else {
      clearStopMarkers();
      clearTripGeometry();
      $('results').innerHTML = renderDraftResult(draft);
      notify.status(draft.message);
    }
  } else {
    clearStopMarkers();
    clearTripGeometry();
    $('results').innerHTML = renderPlanResult(result);
    notify.status(result.message);
  }
  $('results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- events ----------
function bindEvents() {
  $('route-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-route-select]');
    if (btn) selectRoute(btn.dataset.routeSelect);
  });
  $('route-list').addEventListener('change', (e) => {
    const id = e.target.dataset?.routeToggle;
    if (!id) return;
    if (e.target.checked) state.visible.add(id); else state.visible.delete(id);
    syncMap();
  });
  $('show-all-btn').onclick = () => { state.visible = new Set(routesWithGeometry().map((r) => r.id)); renderRouteList(); syncMap(); notify.status('All available route lines shown.'); };
  $('hide-all-btn').onclick = () => { state.visible = new Set(); renderRouteList(); syncMap(); notify.status('All route lines hidden.'); };
  $('fit-btn').onclick = () => {
    if (!state.mapReady || !fitToRoutes(state.map, state.data.geojson, [...state.visible])) notify.status('There are no route lines to fit yet.');
  };
  $('clear-trip-btn').onclick = clearTrip;
  $('swap-btn').onclick = swapTrip;
  $('data-banner').addEventListener('click', (e) => {
    if (e.target.id === 'local-toggle') {
      setIgnoreLocal(state.storage, !state.local.ignored && (state.local.used.length > 0 || state.local.replaced));
      location.reload();
    }
  });
  $('find-btn').onclick = findRoute;
  $('origin-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch('origin'); });
  $('dest-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch('destination'); });
  $('origin').addEventListener('input', () => clearPoint('origin'));
  $('destination').addEventListener('input', () => clearPoint('destination'));
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => startPick(b.dataset.pick)));
  $('pick-cancel').onclick = () => { cancelPick(); notify.status('Map selection cancelled.'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pick) { cancelPick(); } });

  $('locate-btn').onclick = async () => {
    notify.status('Requesting your location…');
    const res = await requestLocation();
    if (!res.ok) { notify.alert(res.message); return; }
    setPoint('origin', res.coordinates, 'My current location');
    notify.status('Starting point set to your location.');
  };

  for (const w of ['origin', 'destination']) {
    $(`${w}-choices`).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn) return;
      const choice = state.choices[w][Number(btn.dataset.choice.split(':')[1])];
      if (choice) setPoint(w, choice.coordinates, choice.label);
    });
  }
  $('results').addEventListener('click', (e) => {
    const dit = e.target.closest('[data-draft-itinerary]');
    if (dit) showDraftItinerary(Number(dit.dataset.draftItinerary));
    const it = e.target.closest('[data-itinerary]');
    if (it) showItinerary(Number(it.dataset.itinerary));
    if (e.target.id === 'show-network-btn') {
      state.visible = new Set(routesWithGeometry().map((r) => r.id));
      clearStopMarkers(); clearTripGeometry(); renderRouteList(); syncMap();
      if (state.mapReady) fitToRoutes(state.map, state.data.geojson, [...state.visible]);
    }
  });
}

// ---------- start ----------
async function start() {
  const loaded = await loadData(import.meta.env.BASE_URL);
  if (!loaded.ok) {
    $('data-banner').innerHTML = `<b>Route data problem.</b> ${escapeHtml(loaded.message)}` + loaded.errors.slice(0, 5).map((e) => `<br>• ${escapeHtml(e.message)}`).join('');
    notify.alert(loaded.message);
    return;
  }
  try { state.storage = window.localStorage; } catch { state.storage = null; }
  const merged = mergeLocalDrafts(loaded.data, state.storage);
  if (merged.error) notify.alert(`Your traced lines were not used: ${merged.error}`);
  state.local = { used: merged.used, hasLocal: merged.hasLocal, ignored: merged.ignored, replaced: merged.replaced };
  state.data = merged.data;
  state.graph = buildGraph(state.data);
  state.draftLines = buildDraftLines(state.data.geojson, state.data.routes);
  state.visible = new Set(routesWithGeometry().map((r) => r.id));
  renderDataBanner(); renderLegend(); renderRouteList(); bindEvents();

  const offline = new URLSearchParams(location.search).has('offline');
  const { map, error } = createMap($('map'), (msg) => notify.alert(msg), { offline });
  if (error) {
    $('map-fallback').hidden = false;
    $('map-fallback').innerHTML = '<p><b>The interactive map could not start</b> (WebGL may be unavailable).<br>You can still browse routes, open the reference maps, and read trip results.</p>';
    return;
  }
  state.map = map;
  if (offline) window.__sakay = state; // test hook (offline mode only)
  map.on('click', handleMapClick);
  map.on('load', () => {
    addRouteLayers(map, state.data.geojson, state.data.routes);
    addTripLayers(map);
    onRouteClick(map, (id) => { if (!state.pick) selectRoute(id); });
    state.mapReady = true;
    syncMap();
    fitToRoutes(map, state.data.geojson, null);
  });
}

start();
