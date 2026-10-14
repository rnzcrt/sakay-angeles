import './styles.css';
import { loadData } from './data/loadData.js';
import { createMap, maplibregl } from './map/createMap.js';
import { searchPlaces } from './services/geocoding.js';
import { snapSegment } from './services/routing.js';
import { setReplaceShipped } from './data/localDrafts.js';
import { renderGeocodeChoices } from './ui/tripResults.js';
import { renderReferenceMaps } from './ui/referenceMaps.js';
import { createNotifier } from './ui/notifications.js';
import { escapeHtml } from './ui/html.js';
import { enrichFeatures } from './map/routeLayers.js';
import {
  DIRECTIONS, directionLabel, lineKey, emptyLine, pathOf, lineFromCoords, geojsonToLines, linesToGeoJson,
  lengthKm, analyzeLine, validateDraftExport,
} from './trace/geojson.js';

const $ = (id) => document.getElementById(id);
const notify = createNotifier({ statusEl: $('status-live'), alertEl: $('alert-banner') });
const STORE_KEY = 'sakay-angeles-trace-drafts-v2';
const OLD_KEY = 'sakay-angeles-trace-drafts-v1';

const state = { routes: [], lines: new Map(), active: null, dir: 'a', map: null, ready: false, markers: [], choices: [], busy: false };

renderReferenceMaps($('ref-list'));

// ---- persistence (best effort) ----
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...state.lines])); } catch { /* storage unavailable */ }
}
function loadLocal() {
  try {
    const v2 = localStorage.getItem(STORE_KEY);
    if (v2) return new Map(JSON.parse(v2));
    const v1 = localStorage.getItem(OLD_KEY); // older single-line drafts → legacy two-way lines
    if (v1) return new Map(JSON.parse(v1).map(([id, coords]) => [lineKey(id, 'a'), lineFromCoords(coords)]));
  } catch { /* ignore */ }
  return null;
}

const activeRoute = () => state.routes.find((r) => r.id === state.active);
const keyNow = () => lineKey(state.active, state.dir);
const getLine = (create = false) => {
  if (!state.active) return null;
  if (!state.lines.has(keyNow()) && create) state.lines.set(keyNow(), emptyLine());
  return state.lines.get(keyNow()) ?? null;
};
const routeLines = (id) => DIRECTIONS.map((d) => state.lines.get(lineKey(id, d))).filter(Boolean);

// ---- segments (straight or road-snapped) ----
async function makeSegment(a, b) {
  if (!$('snap-toggle').checked) return [a, b];
  const res = await snapSegment(a, b);
  if (res.ok) return res.coords;
  notify.alert(res.message);
  return [a, b];
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  $('map').style.opacity = '0.85';
  try { await fn(); } finally { state.busy = false; $('map').style.opacity = ''; }
}

// ---- rendering ----
function renderList() {
  $('trace-list').innerHTML = state.routes.map((r) => {
    const sel = r.id === state.active;
    const parts = DIRECTIONS.map((d) => {
      const l = state.lines.get(lineKey(r.id, d));
      const n = l ? pathOf(l).length : 0;
      return n >= 2 ? `${d.toUpperCase()}: ${lengthKm(pathOf(l)).toFixed(1)} km` : null;
    }).filter(Boolean);
    const warn = routeLines(r.id).some((l) => analyzeLine(pathOf(l)).retraced);
    return `<li class="route-item${sel ? ' is-selected' : ''}"><button type="button" class="route-select" style="padding-left:10px" data-route="${escapeHtml(r.id)}" aria-pressed="${sel}">
      <span class="route-swatch" style="background:${escapeHtml(r.displayColor)}" aria-hidden="true"></span>
      <span class="route-copy"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.jeepneyColorName)} jeepney · ${parts.length ? parts.join(' · ') : 'not traced'}${warn ? ' · ⚠ goes back over itself' : ''}</span></span></button></li>`;
  }).join('');
  const traced = state.routes.filter((r) => routeLines(r.id).some((l) => pathOf(l).length >= 2)).length;
  $('trace-count').textContent = `${traced}/${state.routes.length} traced`;
}

function renderActive() {
  const r = activeRoute();
  $('active-panel').hidden = !r;
  if (!r) return;
  const line = getLine();
  const path = line ? pathOf(line) : [];
  $('active-title').innerHTML = `<span class="route-swatch" style="background:${escapeHtml(r.displayColor)};height:20px" aria-hidden="true"></span> ${escapeHtml(r.name)} — ${directionLabel(state.dir)}`;
  for (const d of DIRECTIONS) $(`dir-${d}`).setAttribute('aria-pressed', String(d === state.dir));
  const n = line?.waypoints.length ?? 0;
  $('active-stats').textContent = `${n} point${n === 1 ? '' : 's'} · about ${lengthKm(path).toFixed(2)} km.`;
  $('active-hint').textContent = n === 0
    ? 'Click the map where this route STARTS (the terminal). That first point is the start.'
    : n === 1
      ? 'Start placed (S). Now click along the road in the order the jeepney travels.'
      : 'Keep clicking along the road. Your last point (E) is the END of the route.';
  $('twoway-toggle').checked = line ? !line.oneWay : false;
  $('start-name').value = line?.startName ?? '';
  $('end-name').value = line?.endName ?? '';
  const a = path.length >= 2 ? analyzeLine(path) : null;
  const warn = $('active-warning');
  if (a?.retraced && a.sameStartEnd) {
    warn.hidden = false;
    warn.textContent = '⚠ This is a ROUND TRIP in one line: it starts and ends at the same place and goes back over the same road. A direction should go from the START terminal to the END terminal. Split it: trace only the way out as Direction A, then press “Copy A reversed to B” and edit B where the way back uses different roads.';
  } else if (a?.retraced) {
    warn.hidden = false;
    warn.textContent = `⚠ About ${Math.round(a.retraceRatio * 100)}% of this line goes back over the same road. If the trip back uses a different road, trace it as the other direction (use “Copy A reversed to B”, then fix the differences).`;
  } else if (a?.closesLoop && line.oneWay) {
    warn.hidden = false;
    warn.textContent = 'This line closes into a loop (start and end at the same place by different roads) and is treated as a one-way circuit.';
  } else warn.hidden = true;
  $('active-landmarks').textContent = `Legend landmarks (unordered guidance): ${(r.sourceLandmarks ?? []).join(' · ')}`;
}

function syncMap() {
  if (!state.ready) return;
  const geo = linesToGeoJson(state.lines, state.routes);
  state.map.getSource('drafts').setData(enrichFeatures(geo, state.routes));
  const activeId = state.active ?? '';
  state.map.setFilter('draft-highlight', ['all', ['==', ['get', 'routeId'], activeId], ['==', ['get', 'direction'], state.dir]]);
  renderMarkers();
}

function renderMarkers() {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  const r = activeRoute();
  const line = getLine();
  if (!r || !line) return;
  const n = line.waypoints.length;
  line.waypoints.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'vertex';
    if (i === 0) { el.classList.add('vertex-start'); el.textContent = 'S'; }
    if (i === n - 1 && i > 0) { el.classList.add('vertex-end'); el.textContent = 'E'; }
    el.title = `${i === 0 ? 'START' : i === n - 1 ? 'END' : `Point ${i + 1}`} — drag to move, double-click to delete`;
    el.style.setProperty('--vc', r.displayColor);
    const overlapsStart = i === n - 1 && n > 1 && analyzeLine(pathOf(line)).sameStartEnd && i > 0;
    const m = new maplibregl.Marker({ element: el, draggable: true, offset: overlapsStart ? [20, -20] : [0, 0] }).setLngLat(c).addTo(state.map);
    m.on('dragend', () => { const ll = m.getLngLat(); withBusy(() => moveWaypoint(i, [ll.lng, ll.lat])); });
    // Keep clicks on a vertex from reaching the map (which would add a new point).
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); withBusy(() => deleteWaypoint(i)); });
    state.markers.push(m);
  });
}

function commit() {
  saveLocal();
  renderList();
  renderActive();
  syncMap();
}

// ---- editing ----
async function addPoint(lngLat) {
  if (!state.active) { notify.alert('Pick a route from the list first, then click the map.'); return; }
  notify.clearAlert();
  const line = getLine(true);
  const p = [lngLat.lng, lngLat.lat];
  if (line.waypoints.length) line.segments.push(await makeSegment(line.waypoints.at(-1), p));
  line.waypoints.push(p);
  commit();
}

async function moveWaypoint(k, p) {
  const line = getLine();
  line.waypoints[k] = p;
  if (k > 0) line.segments[k - 1] = await makeSegment(line.waypoints[k - 1], p);
  if (k < line.waypoints.length - 1) line.segments[k] = await makeSegment(p, line.waypoints[k + 1]);
  commit();
}

async function deleteWaypoint(k) {
  const line = getLine();
  if (!line || k < 0 || k >= line.waypoints.length) return;
  const n = line.waypoints.length;
  line.waypoints.splice(k, 1);
  if (n === 1) line.segments = [];
  else if (k === 0) line.segments.shift();
  else if (k === n - 1) line.segments.pop();
  else line.segments.splice(k - 1, 2, await makeSegment(line.waypoints[k - 1], line.waypoints[k]));
  commit();
}

function reverseLine(line) {
  line.waypoints.reverse();
  line.segments = line.segments.reverse().map((s) => [...s].reverse());
}

// ---- export / import ----
function exportGeoJson() {
  const geo = linesToGeoJson(state.lines, state.routes);
  const check = validateDraftExport(geo, state.routes);
  if (!check.valid) { notify.alert(`Export has problems: ${check.errors[0].message}`); return null; }
  if (geo.features.length === 0) { notify.alert('Nothing to export yet — trace at least one direction with 2+ points.'); return null; }
  return JSON.stringify(geo, null, 2);
}

function selectRoute(id) {
  state.active = id;
  const r = activeRoute();
  const line = getLine();
  const path = line ? pathOf(line) : [];
  if (state.ready && path.length >= 2) {
    const b = new maplibregl.LngLatBounds(path[0], path[0]);
    path.forEach((p) => b.extend(p));
    state.map.fitBounds(b, { padding: 60, maxZoom: 16 });
  }
  notify.status(`Tracing ${r.name}, ${directionLabel(state.dir)}. Click the map where it starts.`);
  commit();
}

function bind() {
  $('trace-list').addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (b) selectRoute(b.dataset.route); });
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => { state.dir = b.dataset.dir; selectRoute(state.active); }));
  $('undo-btn').onclick = () => withBusy(async () => { const l = getLine(); if (l?.waypoints.length) await deleteWaypoint(l.waypoints.length - 1); });
  $('clear-btn').onclick = () => {
    const r = activeRoute();
    if (r && getLine()?.waypoints.length && confirm(`Clear ${directionLabel(state.dir)} of ${r.name}?`)) { state.lines.delete(keyNow()); commit(); }
  };
  $('start-over-btn').onclick = () => {
    if (!confirm('Clear every traced line and start again? The app will then show only routes you trace from now on (you can undo this with “Use the shipped file instead” in the main app).')) return;
    state.lines = new Map();
    setReplaceShipped(localStorage, true);
    state.active = null;
    notify.status('Cleared. Pick a route and click its start terminal.');
    commit();
  };
  $('reverse-btn').onclick = () => { const l = getLine(); if (l) { reverseLine(l); commit(); } };
  $('copy-return-btn').onclick = () => {
    const r = activeRoute();
    const a = r && state.lines.get(lineKey(r.id, 'a'));
    if (!a || a.waypoints.length < 2) { notify.alert('Trace Direction A first, then copy it reversed to B.'); return; }
    if (state.lines.get(lineKey(r.id, 'b'))?.waypoints.length && !confirm('Direction B already has points. Replace them?')) return;
    const b = JSON.parse(JSON.stringify(a));
    reverseLine(b);
    // Two separate directions means each one is ridden one way only.
    a.oneWay = true;
    b.oneWay = true;
    b.startName = a.endName;
    b.endName = a.startName;
    state.lines.set(lineKey(r.id, 'b'), b);
    state.dir = 'b';
    notify.status('Copied A reversed into B. Now edit B wherever the way back uses a different road.');
    commit();
  };
  $('twoway-toggle').onchange = (e) => { const l = getLine(true); l.oneWay = !e.target.checked; commit(); };
  $('start-name').oninput = (e) => { const l = getLine(true); l.startName = e.target.value; saveLocal(); };
  $('end-name').oninput = (e) => { const l = getLine(true); l.endName = e.target.value; saveLocal(); };
  $('export-btn').onclick = () => {
    const text = exportGeoJson();
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/geo+json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'routes.geojson' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify.status('Exported routes.geojson. Replace public/data/routes.geojson with it.');
  };
  $('copy-btn').onclick = async () => {
    const text = exportGeoJson();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); notify.status('GeoJSON copied to clipboard.'); }
    catch { notify.alert('Could not copy automatically. Use Export instead.'); }
  };
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = geojsonToLines(JSON.parse(await file.text()));
      const known = new Set(state.routes.map((r) => r.id));
      let n = 0;
      for (const [key, line] of imported) if (known.has(key.slice(0, key.lastIndexOf('|')))) { state.lines.set(key, line); n += 1; }
      commit();
      notify.status(`Imported ${n} line${n === 1 ? '' : 's'}.`);
    } catch { notify.alert('That file is not valid GeoJSON.'); }
    e.target.value = '';
  });
  $('goto-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('goto-choices');
    out.innerHTML = '<p class="muted">Searching…</p>';
    const res = await searchPlaces($('goto').value);
    if (!res.ok) { out.innerHTML = `<p class="muted">${escapeHtml(res.message)}</p>`; return; }
    if (!res.results.length) { out.innerHTML = '<p class="muted">No match. Try another name.</p>'; return; }
    state.choices = res.results;
    out.innerHTML = renderGeocodeChoices('goto', res.results);
  });
  $('goto-choices').addEventListener('click', (e) => {
    const b = e.target.closest('[data-choice]');
    if (!b) return;
    const c = state.choices[Number(b.dataset.choice.split(':')[1])];
    state.map?.flyTo({ center: c.coordinates, zoom: 16 });
    $('goto-choices').innerHTML = '';
  });
}

async function start() {
  const loaded = await loadData(import.meta.env.BASE_URL);
  if (!loaded.ok) { notify.alert(loaded.message); return; }
  state.routes = loaded.data.routes;
  state.lines = loadLocal() ?? geojsonToLines(loaded.data.geojson);
  bind(); renderList(); renderActive();
  $('trace-legend').innerHTML = '<strong>Tracing tips</strong><div class="legend-row">Click = add point</div><div class="legend-row">Drag = move point</div><div class="legend-row">Double-click point = delete</div><div class="legend-row">S = start, E = end</div>';

  const offline = new URLSearchParams(location.search).has('offline');
  const { map, error } = createMap($('map'), (m) => notify.alert(m), { offline });
  if (error) { notify.alert('The interactive map could not start (WebGL may be unavailable).'); return; }
  state.map = map;
  if (offline) window.__trace = state; // test hook (offline mode only)
  map.on('click', (e) => withBusy(() => addPoint(e.lngLat)));
  map.on('load', () => {
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    map.addSource('drafts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'draft-casing', type: 'line', source: 'drafts', layout, paint: { 'line-color': ['get', 'casingColor'], 'line-width': 7, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'draft-highlight', type: 'line', source: 'drafts', layout, filter: ['==', ['get', 'routeId'], ''], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 13, 'line-opacity': 0.35 } });
    map.addLayer({ id: 'draft-line-a', type: 'line', source: 'drafts', layout: { 'line-join': 'round' }, filter: ['!=', ['get', 'direction'], 'b'], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 4, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'draft-line-b', type: 'line', source: 'drafts', layout: { 'line-join': 'round' }, filter: ['==', ['get', 'direction'], 'b'], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 4, 'line-dasharray': [0.6, 1.6] } });
    state.ready = true;
    syncMap();
    const all = [...state.lines.values()].flatMap((l) => pathOf(l));
    if (all.length) {
      const b = new maplibregl.LngLatBounds(all[0], all[0]);
      all.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: 60, duration: 0 });
    }
  });
}

start();
