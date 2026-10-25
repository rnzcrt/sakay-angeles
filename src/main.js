import './styles.css';
import { MAP_CONFIG, DRAFT_TIME } from './config.js';
import { loadData } from './data/loadData.js';
import { mergeLocalDrafts } from './data/localDrafts.js';
import { planTrip, buildGraph, PLAN_STATUS } from './routing/planner.js';
import { createMap } from './map/createMap.js';
import { addRouteLayers, setRouteData, applyVisibility, onRouteClick, fitToRoutes, makeMarker, addTripLayers, setTripGeometry, fitToCoordinates } from './map/routeLayers.js';
import { requestLocation } from './services/geolocation.js';
import { searchPlaces } from './services/geocoding.js';
import { routeWalking } from './services/walking.js';
import { estimateItineraryFares } from './services/fares.js';
import { findNearbyPedestrianFacilities } from './services/pedestrianFacilities.js';
import { renderRouteItem, renderRouteDetail, routeHasGeometry } from './ui/routeList.js';
import { renderPlanResult, renderGeocodeChoices, renderDraftResult } from './ui/tripResults.js';
import { buildDraftLines, planDraftTrip, DRAFT_STATUS } from './routing/draftPlanner.js';
import { createNotifier } from './ui/notifications.js';
import { escapeHtml } from './ui/html.js';
import { haversineMeters } from './routing/geo.js';
import { buildFeedbackIssueUrl } from './services/feedback.js';

const $ = (id) => document.getElementById(id);
const notify = createNotifier({ statusEl: $('status-live'), alertEl: $('alert-banner') });
const phoneLayout = matchMedia('(max-width: 640px), (max-width: 1000px) and (max-height: 500px)');

const state = {
  data: null,
  graph: null,
  map: null,
  mapReady: false,
  uiMode: phoneLayout.matches ? 'sheet-collapsed' : 'explore',
  inputReturnMode: 'sheet-half',
  pickReturnMode: 'sheet-half',
  previewSource: 'traced',
  shippedData: null,
  tracedData: null,
  sheetDrag: null,
  suppressSheetClickUntil: 0,
  selectedRouteId: null,
  visible: new Set(),
  points: { origin: null, destination: null }, // { coordinates, label }
  markers: { origin: null, destination: null },
  stopMarkers: [],
  terminalMarkers: [],
  pick: null, // { target, sequence }
  result: null,
  selectedItinerary: 0,
  tripActive: false,
  choices: { origin: [], destination: [] },
  draftLines: [],
  local: { used: [], hasLocal: false, ignored: false, replaced: false, available: false, error: null },
  storage: null,
  draftResult: null,
  draftIndex: 0,
  draftRenderToken: 0,
  passengerType: 'regular',
};

$('attribution-note').textContent = `Map data © OpenStreetMap contributors · ${MAP_CONFIG.attributionText}`;

// ---------- rendering ----------
const routesWithGeometry = () => state.data.routes.filter((r) => routeHasGeometry(r, state.data.geojson));

function renderLegend() {
  const hasLines = routesWithGeometry().length > 0;
  $('map-legend').innerHTML = `<strong>Map guide</strong>
    <div class="legend-row"><span class="legend-terminal"></span> Terminal based on observation</div>
    <div class="legend-row"><span class="legend-dash"></span> Route based on observation</div>
    <div class="legend-row"><span class="legend-walk"></span> Walking path</div>
    ${hasLines ? '' : '<div class="legend-row">Route details are still being added.</div>'}`;
}

function renderRouteList() {
  const { routes, geojson } = state.data;
  $('route-list').innerHTML = routes
    .map((r) => renderRouteItem(r, { selected: r.id === state.selectedRouteId, visible: state.visible.has(r.id), hasGeometry: routeHasGeometry(r, geojson) }))
    .join('');
  $('route-count').textContent = `${routes.length} routes`;
}

function localNote() {
  if (!import.meta.env.DEV) return '';
  const { used, available, error } = state.local;
  if (!available) {
    const issue = error
      ? `The saved traced geometry could not be loaded: ${escapeHtml(error)}`
      : 'No valid locally saved traced geometry was found. Showing the shipped route geometry instead.';
    return `<div class="local-note"><strong class="source-state">Preview source: Shipped file</strong><p>${issue}</p><button type="button" id="local-toggle" data-preview-source="traced" disabled>My traced lines unavailable</button></div>`;
  }
  if (state.previewSource === 'traced') {
    const detail = `Showing ${used.length} traced routes. Other shipped geometry is hidden in this preview.`;
    return `<div class="local-note"><strong class="source-state">Preview source: My traced lines</strong><p>${detail}</p><button type="button" id="local-toggle" data-preview-source="shipped">Use the shipped file instead</button></div>`;
  }
  return `<div class="local-note"><strong class="source-state">Preview source: Shipped file</strong><p>Showing the route geometry included in the app’s shipped data.</p><button type="button" id="local-toggle" data-preview-source="traced">Use my traced lines</button></div>`;
}

function renderDataBanner() {
  $('data-banner').innerHTML = `<b>Help improve Sakay Angeles!</b> We're building a community-powered jeepney guide. Some routes, fares, and directions may need corrections. Send feedback from a route suggestion so we can improve this guide.` + localNote();
}

function setPreviewSource(source) {
  if (source === state.previewSource) return;
  if (source === 'traced' && !state.local.available) return;
  state.previewSource = source;
  state.data = source === 'traced' ? state.tracedData : state.shippedData;
  state.graph = buildGraph(state.data);
  state.draftLines = buildDraftLines(state.data.geojson, state.data.routes);
  state.visible = new Set(routesWithGeometry().map((r) => r.id));
  state.selectedRouteId = null;
  state.result = null;
  state.draftResult = null;
  state.tripActive = false;
  clearStopMarkers();
  clearTripGeometry();
  $('results').replaceChildren();
  $('route-detail').replaceChildren();
  renderDataBanner();
  renderLegend();
  renderRouteList();
  if (state.mapReady) {
    setRouteData(state.map, state.data.geojson, state.data.routes);
    syncMap();
    fitToRoutes(state.map, state.data.geojson, [...state.visible]);
  }
  notify.status(source === 'traced' ? 'Previewing your locally saved traced lines.' : 'Previewing the shipped route geometry.');
}

function resizeMapAfterLayout() {
  requestAnimationFrame(() => requestAnimationFrame(() => state.map?.resize()));
}

function setUiMode(mode) {
  const phone = phoneLayout.matches;
  if (phone && mode === 'explore') mode = 'sheet-collapsed';
  else if (phone && mode === 'planner') mode = 'sheet-half';
  else if (!phone && mode === 'sheet-collapsed') mode = 'explore';
  else if (!phone && (mode === 'sheet-half' || mode === 'sheet-expanded')) mode = 'planner';
  state.uiMode = mode;
  const body = document.body;
  const collapsed = mode === 'explore' || mode === 'sheet-collapsed';
  const plannerVisible = !collapsed && !(mode === 'pick' && phone);
  body.classList.toggle('planner-closed', collapsed);
  body.classList.toggle('planner-open', plannerVisible);
  body.classList.toggle('sheet-collapsed', mode === 'sheet-collapsed');
  body.classList.toggle('sheet-half', mode === 'sheet-half');
  body.classList.toggle('sheet-expanded', mode === 'sheet-expanded');
  body.classList.toggle('input-takeover', mode === 'input');
  body.classList.toggle('map-picking', mode === 'pick');
  $('mobile-panel-toggle').setAttribute('aria-expanded', String(plannerVisible));
  $('planner-close').textContent = phone
    ? mode === 'input' ? 'Back' : mode === 'sheet-collapsed' ? 'Open' : 'Collapse'
    : '×';
  $('planner-close').setAttribute('aria-label', phone
    ? mode === 'input' ? 'Back to trip planner' : mode === 'sheet-collapsed' ? 'Expand trip planner' : 'Collapse trip planner'
    : 'Close trip planner');
  $('sheet-handle').setAttribute('aria-expanded', String(mode !== 'sheet-collapsed' && !(mode === 'pick' && phone)));
  $('sheet-handle').setAttribute('aria-label', mode === 'sheet-collapsed' ? 'Expand trip planner' : 'Adjust trip planner sheet');

  const takeover = mode === 'input' && phone;
  $('map-wrap').inert = takeover;
  $('topbar').inert = takeover;
  $('skip-link').inert = takeover;
  if (takeover) {
    $('sidebar').setAttribute('role', 'dialog');
    $('sidebar').setAttribute('aria-modal', 'true');
    $('sidebar').setAttribute('aria-labelledby', 'planner-title');
  } else {
    $('sidebar').removeAttribute('role');
    $('sidebar').removeAttribute('aria-modal');
    $('sidebar').removeAttribute('aria-labelledby');
  }
  resizeMapAfterLayout();
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  document.documentElement.style.setProperty('--visual-height', `${viewport.height}px`);
  document.documentElement.style.setProperty('--visual-offset-top', `${viewport.offsetTop}px`);
}
syncVisualViewport();
window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
phoneLayout.addEventListener('change', ({ matches }) => {
  if (matches && state.uiMode === 'explore') setUiMode('sheet-collapsed');
  else if (!matches && state.uiMode === 'sheet-collapsed') setUiMode('explore');
  else setUiMode(state.uiMode);
});

function bindSheetDrag() {
  const handle = $('sheet-handle');
  const sidebar = $('sidebar');
  const begin = (event) => {
    if (!phoneLayout.matches || state.uiMode === 'pick' || event.isPrimary === false) return;
    if (state.uiMode === 'input' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const rect = sidebar.getBoundingClientRect();
    state.sheetDrag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: performance.now(), height: rect.height, velocity: 0, moved: false };
    sidebar.classList.add('sheet-dragging');
    handle.setPointerCapture(event.pointerId);
  };
  const move = (event) => {
    const drag = state.sheetDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const now = performance.now();
    const deltaTime = Math.max(1, now - drag.lastTime);
    drag.velocity = (event.clientY - drag.lastY) / deltaTime;
    drag.lastY = event.clientY;
    drag.lastTime = now;
    const dy = event.clientY - drag.startY;
    drag.moved ||= Math.abs(dy) > 7;
    const maxHeight = Math.max(116, sidebar.parentElement.clientHeight - 8);
    sidebar.style.height = `${Math.max(108, Math.min(maxHeight, drag.height - dy))}px`;
  };
  const finish = (event) => {
    const drag = state.sheetDrag;
    if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return;
    const currentHeight = sidebar.getBoundingClientRect().height;
    const maxHeight = Math.max(116, sidebar.parentElement.clientHeight - 8);
    const collapsed = 112;
    const half = Math.max(collapsed + 42, Math.min(maxHeight, sidebar.parentElement.clientHeight * 0.56));
    const points = [collapsed, half, maxHeight];
    let target;
    if (drag.velocity < -0.55) target = points.find((point) => point > currentHeight + 4) ?? maxHeight;
    else if (drag.velocity > 0.55) target = [...points].reverse().find((point) => point < currentHeight - 4) ?? collapsed;
    else target = points.reduce((best, point) => Math.abs(point - currentHeight) < Math.abs(best - currentHeight) ? point : best, points[0]);
    if (drag.moved) state.suppressSheetClickUntil = performance.now() + 350;
    state.sheetDrag = null;
    sidebar.classList.remove('sheet-dragging');
    sidebar.style.height = '';
    setUiMode(target === collapsed ? 'sheet-collapsed' : target === maxHeight ? 'sheet-expanded' : 'sheet-half');
  };
  handle.addEventListener('pointerdown', begin);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
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
  } else if (route) notify.status(`${route.name}: route details are still being added.`);
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
  if (state.uiMode !== 'pick') {
    state.pickReturnMode = state.uiMode === 'input' ? state.inputReturnMode : state.uiMode;
    if (state.pickReturnMode === 'explore' || state.pickReturnMode === 'sheet-collapsed') state.pickReturnMode = 'sheet-half';
  }
  state.pick = { target, sequence };
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  state.map.getContainer().classList.add('picking');
  $('pick-banner').hidden = false;
  $('pick-title').textContent = target === 'origin' ? 'Choose your starting point' : 'Choose your destination';
  $('pick-help').textContent = 'Tap the map to choose this location.';
  setUiMode('pick');
  notify.status(`${$('pick-title').textContent}. ${$('pick-help').textContent}`);
}

function cancelPick({ restoreFocus = true } = {}) {
  const target = state.pick?.target;
  const wasPicking = Boolean(state.pick);
  state.pick = null;
  state.map?.getContainer().classList.remove('picking');
  $('pick-banner').hidden = true;
  if (wasPicking && state.uiMode === 'pick') {
    const returnMode = state.pickReturnMode === 'input' ? state.inputReturnMode : state.pickReturnMode;
    setUiMode(returnMode || (phoneLayout.matches ? 'sheet-half' : 'planner'));
    if (restoreFocus && target) requestAnimationFrame(() => document.querySelector(`[data-pick="${target}"]`)?.focus());
  }
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
  $('results').innerHTML = renderPlanResult(state.result, index, { passengerType: state.passengerType }) +
    '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
  renderRouteList();
  syncMap();
}

function clearTripGeometry() {
  if (state.mapReady) setTripGeometry(state.map);
}

function paintDraftItinerary(result, selected) {
  const selectedIndex = Math.max(0, result.itineraries.indexOf(selected));
  selected = result.itineraries[selectedIndex];
  state.draftIndex = selectedIndex;
  state.visible = new Set();
  clearStopMarkers();
  if (state.mapReady) {
    const routedWalkLines = selected.walkRoutes?.flatMap((walk) => walk?.coordinates ? [walk.coordinates] : []) ?? [];
    const mapUpdated = setTripGeometry(state.map, selected.legs, routedWalkLines);
    if (import.meta.env.DEV) console.debug('[walking-map]', { status: mapUpdated ? 'updated' : 'source_unavailable', routedSegments: routedWalkLines.length });
    selected.legs.forEach((l) => {
      state.stopMarkers.push(makeMarker(state.map, 'stop', l.boardPoint, `Approximate boarding point for ${l.routeName}`));
      state.stopMarkers.push(makeMarker(state.map, 'stop', l.alightPoint, `Approximate drop-off point for ${l.routeName}`));
    });
    for (const facility of result.crossingFacilities ?? []) {
      const kind = facility.kind.toLowerCase().includes('bridge') ? 'bridge'
        : facility.kind.toLowerCase().includes('underpass') ? 'underpass' : 'crossing';
      state.stopMarkers.push(makeMarker(state.map, kind, facility.coordinates, `${facility.kind}${facility.name !== facility.kind ? ` · ${facility.name}` : ''} · mapped in OpenStreetMap`));
    }
    fitToCoordinates(state.map, [...selected.legs.flatMap((l) => l.segment), ...routedWalkLines.flat(), ...(result.crossingFacilities ?? []).map((f) => f.coordinates)]);
  }
  $('results').innerHTML = renderDraftResult(result, selectedIndex, { passengerType: state.passengerType }) +
    '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
  renderRouteList();
  syncMap();
}

function rankDraftChoices(result, candidates, selected = null) {
  candidates.sort((a, b) => a.estimatedMinutes - b.estimatedMinutes ||
    (a.routedWalkMeters ?? a.totalWalkMeters) - (b.routedWalkMeters ?? b.totalWalkMeters) ||
    a.transfers - b.transfers || a.id.localeCompare(b.id));
  candidates.forEach((option, i) => { option.isFastest = i === 0; });
  const leastWalking = [...candidates].sort((a, b) =>
    (a.routedWalkMeters ?? a.totalWalkMeters) - (b.routedWalkMeters ?? b.totalWalkMeters) || a.estimatedMinutes - b.estimatedMinutes)[0];
  const fareOptions = candidates.map((option) => ({ option, fares: estimateItineraryFares(option.legs, state.passengerType) }))
    .filter(({ fares }) => fares.available)
    .sort((a, b) => ((a.fares.totalFare ?? (a.fares.fareRange.min + a.fares.fareRange.max) / 2) - (b.fares.totalFare ?? (b.fares.fareRange.min + b.fares.fareRange.max) / 2)) || a.option.estimatedMinutes - b.option.estimatedMinutes);
  const lowestFare = fareOptions[0]?.option ?? null;
  candidates.forEach((option) => {
    option.isLeastWalking = option === leastWalking;
    option.isLowestFare = option === lowestFare;
  });
  const displayLimit = result.displayLimit ?? 3;
  const chosen = [...new Set([selected, candidates[0], leastWalking, lowestFare, ...candidates].filter(Boolean))].slice(0, displayLimit);
  result.candidates = candidates;
  result.itineraries = chosen;
  return chosen;
}

function showDraftItinerary(index) {
  const result = state.draftResult;
  const candidates = result.candidates ?? result.itineraries;
  let selected = result.itineraries[index] ?? candidates[0];
  const token = ++state.draftRenderToken;
  const displayLimit = result.displayLimit ?? 3;
  rankDraftChoices(result, candidates, selected);
  if (!result.itineraries.includes(selected)) selected = result.itineraries[0];
  // Show the route immediately. Pedestrian routing is an enhancement and must
  // never leave the user staring at an empty result while public APIs respond.
  paintDraftItinerary(result, selected);

  if (!result.crossingFacilitiesPromise && result.destination) {
    result.crossingFacilitiesPromise = findNearbyPedestrianFacilities(result.destination).then((facilities) => {
      result.crossingFacilities = facilities;
      if (state.draftResult === result) {
        paintDraftItinerary(result, result.itineraries[state.draftIndex]);
      }
    });
  }

  let nextCandidate = 0;
  void Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (nextCandidate < candidates.length) {
      const option = candidates[nextCandidate++];
      if (option.walkPromise) { await option.walkPromise; continue; }
      const straightLines = option.walkLines;
      option.walkPromise = Promise.all(straightLines.map((line) => routeWalking(line[0], line.at(-1), {
        onDiagnostic: (event) => { if (import.meta.env.DEV) console.debug('[walking-router]', event); },
      }))).then((walkRoutes) => {
        option.walkRoutes = walkRoutes;
        option.walkRoutingComplete = walkRoutes.every(Boolean);
        option.routedWalkMeters = Math.round(walkRoutes.reduce((sum, route, i) => sum + (route?.distanceMeters ?? haversineMeters(straightLines[i][0], straightLines[i].at(-1))), 0));
        // Keep candidate connectors separate from display geometry. Only
        // successful foot-network routes are drawn on the map.
        const walkMinutes = walkRoutes.reduce((sum, route, i) => sum + (route?.durationSeconds ? route.durationSeconds / 60 : (haversineMeters(straightLines[i][0], straightLines[i].at(-1)) / 1000 / DRAFT_TIME.walkKmh) * 60), 0);
        option.estimatedMinutes = Math.max(1, Math.round(option.walkingOnly
          ? walkMinutes
          : walkMinutes + (option.approxRideMeters / 1000 / DRAFT_TIME.jeepneyKmh) * 60 + DRAFT_TIME.waitPerBoardingMin * option.legs.length));
      });
      await option.walkPromise;
    }
  })).then(() => {
    if (state.draftResult !== result || state.draftRenderToken !== token) return;
    rankDraftChoices(result, candidates, selected);
    if (!result.itineraries.includes(selected)) selected = result.itineraries[0];
    paintDraftItinerary(result, selected);
    const anyPedestrianPath = candidates.some((option) => option.walkRoutes?.some(Boolean));
    const anyMissingPedestrianPath = candidates.some((option) => option.walkRoutingComplete === false);
    notify.status(anyMissingPedestrianPath
      ? `${anyPedestrianPath ? 'Some walking directions loaded.' : 'Walking directions could not be loaded.'} Other walking distances are approximate.`
      : 'Walking directions and estimated times were updated.');
  });
}

async function findRoute() {
  notify.clearAlert();
  for (const w of ['origin', 'destination']) {
    if (!state.points[w] && $(w).value.trim()) {
      const ok = await runSearch(w);
      if (!ok) { notify.alert(`Choose your ${w === 'origin' ? 'starting point' : 'destination'} from the search results first.`); return; }
    }
  }
  notify.status('Searching the full jeepney network and connected transfers…');
  await new Promise((resolve) => requestAnimationFrame(resolve));
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
    const draft = planDraftTrip({ origin: state.points.origin.coordinates, destination: state.points.destination.coordinates, lines: state.draftLines, options: { candidateLimit: 8 } });
    draft.destination = state.points.destination.coordinates;
    state.draftResult = draft;
    if (draft.status === DRAFT_STATUS.SUCCESS) {
      showDraftItinerary(0);
      notify.status(`${Math.min(draft.displayLimit ?? 3, draft.itineraries.length)} route options shown. Walking directions are updating.`);
    } else {
      clearStopMarkers();
      clearTripGeometry();
      $('results').innerHTML = renderDraftResult(draft);
      notify.status(draft.message);
    }
  } else {
    clearStopMarkers();
    clearTripGeometry();
    $('results').innerHTML = renderPlanResult(result, 0, { passengerType: state.passengerType });
    notify.status(result.message);
  }
  $('results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- events ----------
function bindEvents() {
  setUiMode(state.uiMode);
  bindSheetDrag();
  $('skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    if (state.pick) cancelPick({ restoreFocus: false });
    setUiMode(phoneLayout.matches ? 'sheet-half' : 'planner');
    requestAnimationFrame(() => $('planner-title').focus());
  });
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-report-routes]');
    if (!trigger) return;
    const form = $('feedback-form');
    const routeNames = trigger.dataset.reportRouteNames ?? '';
    form.elements.route.value = routeNames;
    form.elements.origin.value = state.points.origin?.label ?? '';
    form.elements.destination.value = state.points.destination?.label ?? '';
    $('feedback-status').replaceChildren();
    $('feedback-dialog').showModal();
  });
  $('feedback-close').onclick = () => $('feedback-dialog').close();
  $('feedback-cancel').onclick = () => $('feedback-dialog').close();
  $('feedback-dialog').addEventListener('click', (event) => {
    if (event.target === $('feedback-dialog')) $('feedback-dialog').close();
  });
  $('feedback-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    try {
      const issueUrl = buildFeedbackIssueUrl(Object.fromEntries(new FormData(form).entries()));
      const message = document.createElement('span');
      message.textContent = 'Your report is ready. Review it and submit on GitHub. Reports are public, and GitHub sign-in is required.';
      const link = document.createElement('a');
      link.href = issueUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'feedback-submit-link';
      link.textContent = 'Open GitHub report';
      $('feedback-status').replaceChildren(message, document.createElement('br'), link);
    } catch (error) {
      $('feedback-status').textContent = error.message;
    }
  });

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
      setPreviewSource(e.target.dataset.previewSource);
    }
  });
  $('find-btn').onclick = findRoute;
  $('origin-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch('origin'); });
  $('dest-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch('destination'); });
  $('origin').addEventListener('input', () => clearPoint('origin'));
  $('destination').addEventListener('input', () => clearPoint('destination'));
  for (const which of ['origin', 'destination']) {
    $(which).addEventListener('focus', () => {
      if (phoneLayout.matches && !state.pick && state.uiMode !== 'input') {
        state.inputReturnMode = ['sheet-half', 'sheet-expanded'].includes(state.uiMode) ? state.uiMode : 'sheet-half';
        setUiMode('input');
      }
    });
  }
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => startPick(b.dataset.pick)));
  $('pick-cancel').onclick = () => { cancelPick(); notify.status('Map selection cancelled.'); };
  $('mobile-panel-toggle').addEventListener('click', () => {
    if (state.pick) cancelPick({ restoreFocus: false });
    setUiMode(state.uiMode === 'explore' ? 'planner' : 'explore');
  });
  $('planner-close').addEventListener('click', () => {
    if (state.pick) { cancelPick({ restoreFocus: false }); setUiMode(phoneLayout.matches ? 'sheet-collapsed' : 'explore'); }
    else if (phoneLayout.matches && state.uiMode === 'input') {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setUiMode(state.inputReturnMode);
      $('planner-close').focus();
    } else if (phoneLayout.matches) setUiMode(state.uiMode === 'sheet-collapsed' ? 'sheet-half' : 'sheet-collapsed');
    else {
      setUiMode('explore');
      $('mobile-panel-toggle').focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (state.pick) { cancelPick(); e.preventDefault(); return; }
    if (state.uiMode === 'input') {
      const choices = $('origin-choices').childElementCount || $('destination-choices').childElementCount;
      if (choices) {
        $('origin-choices').replaceChildren();
        $('destination-choices').replaceChildren();
        e.preventDefault();
        return;
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setUiMode(state.inputReturnMode);
      $('planner-close').focus();
      e.preventDefault();
    } else if (['sheet-half', 'sheet-expanded'].includes(state.uiMode) && phoneLayout.matches) {
      setUiMode('sheet-collapsed');
      $('planner-close').focus();
      e.preventDefault();
    } else if (state.uiMode === 'planner') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches('input,textarea,select')) return;
      setUiMode('explore');
      $('mobile-panel-toggle').focus();
      e.preventDefault();
    }
  });
  $('sheet-handle').addEventListener('click', (event) => {
    if (performance.now() < state.suppressSheetClickUntil) { event.preventDefault(); return; }
    if (state.uiMode === 'sheet-collapsed') setUiMode('sheet-half');
    else if (state.uiMode === 'sheet-half') setUiMode('sheet-expanded');
    else if (state.uiMode === 'sheet-expanded') setUiMode('sheet-half');
  });

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
  $('passenger-type').addEventListener('change', (e) => {
    state.passengerType = e.target.value;
    if (state.result?.status === PLAN_STATUS.SUCCESS) {
      $('results').innerHTML = renderPlanResult(state.result, state.selectedItinerary, { passengerType: state.passengerType }) +
        '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
    }
    const result = state.draftResult;
    if (result?.status === DRAFT_STATUS.SUCCESS) {
      const selected = result.itineraries[state.draftIndex];
      const visible = rankDraftChoices(result, result.candidates ?? result.itineraries, selected);
      state.draftIndex = Math.max(0, visible.indexOf(selected));
      $('results').innerHTML = renderDraftResult(result, state.draftIndex, { passengerType: state.passengerType }) +
        '<button type="button" class="btn btn-ghost" id="show-network-btn">Show the whole network</button>';
    }
  });
}

// ---------- start ----------
async function start() {
  const loaded = await loadData(import.meta.env.BASE_URL);
  if (!loaded.ok) {
    if (import.meta.env.DEV) {
      $('data-banner').innerHTML = `<b>Route data problem.</b> ${escapeHtml(loaded.message)}` + loaded.errors.slice(0, 5).map((e) => `<br>• ${escapeHtml(e.message)}`).join('');
      notify.alert(loaded.message);
    } else {
      $('data-banner').textContent = 'Route information could not be loaded. Please refresh and try again.';
      notify.alert('Route information could not be loaded. Please refresh and try again.');
    }
    return;
  }
  try { state.storage = window.localStorage; } catch { state.storage = null; }
  state.shippedData = loaded.data;
  const merged = mergeLocalDrafts(loaded.data, state.storage, { ignoreLocal: false });
  if (merged.error && import.meta.env.DEV) notify.alert(`Your traced lines were not used: ${merged.error}`);
  state.tracedData = merged.data;
  state.local = {
    used: merged.used,
    hasLocal: merged.hasLocal,
    ignored: merged.ignored,
    replaced: merged.replaced,
    error: merged.error ?? null,
    available: !merged.error && merged.used.length > 0,
  };
  state.previewSource = state.local.available ? 'traced' : 'shipped';
  state.data = state.previewSource === 'traced' ? state.tracedData : state.shippedData;
  state.graph = buildGraph(state.data);
  state.draftLines = buildDraftLines(state.data.geojson, state.data.routes);
  state.visible = new Set(routesWithGeometry().map((r) => r.id));
  renderDataBanner(); renderLegend(); renderRouteList(); bindEvents();

  const offline = new URLSearchParams(location.search).has('offline');
  const { map, error } = createMap($('map'), (msg) => notify.alert(msg), { offline });
  if (error) {
    $('map-fallback').hidden = false;
    $('map-fallback').innerHTML = '<p><b>The map could not load.</b><br>You can still browse routes and plan a trip.</p>';
    return;
  }
  state.map = map;
  if (import.meta.env.DEV && offline) window.__sakay = state; // development-only test hook
  map.on('click', handleMapClick);
  map.on('load', () => {
    addRouteLayers(map, state.data.geojson, state.data.routes);
    addTripLayers(map);
    onRouteClick(map, (id) => { if (!state.pick) selectRoute(id); });
    state.mapReady = true;
    for (const terminal of state.data.stops.filter((stop) => stop.kind === 'terminal' && stop.verificationStatus === 'verified')) {
      state.terminalMarkers.push(makeMarker(map, 'terminal', terminal.coordinates, `${terminal.name} · based on observation`));
    }
    syncMap();
    fitToRoutes(map, state.data.geojson, null);
  });
}

start();
