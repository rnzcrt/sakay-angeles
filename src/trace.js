import './styles.css';
import { loadData } from './data/loadData.js';
import { createMap, maplibregl } from './map/createMap.js';
import { haversineMeters, pathLengthMeters } from './routing/geo.js';
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
  lengthKm, analyzeLine, validateDraftExport, checkDirectionPair, splitLineAt, isDetour, findDetours, straightenDetours,
} from './trace/geojson.js';

const $ = (id) => document.getElementById(id);
const notify = createNotifier({ statusEl: $('status-live'), alertEl: $('alert-banner') });
const STORE_KEY = 'sakay-angeles-trace-drafts-v2';
const OLD_KEY = 'sakay-angeles-trace-drafts-v1';

const state = { routes: [], lines: new Map(), active: null, dir: 'a', map: null, ready: false, markers: [], choices: [], pending: 0, selected: null };

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
async function makeSegment(a, b, { snap = $('snap-toggle').checked } = {}) {
  if (!snap) return [a, b];
  const res = await snapSegment(a, b);
  if (!res.ok) {
    notify.alert(res.message);
    return [a, b];
  }
  const straightM = haversineMeters(a, b);
  const pathM = pathLengthMeters(res.coords);
  if (isDetour(straightM, pathM)) {
    notify.alert(`Snapping wanted to go ${Math.round(pathM)} m for a ${Math.round(straightM)} m gap (a one-way street or an unconnected road is in the way), so a straight line was drawn instead. Add points along the real street, or hold Option/Alt while clicking for a straight piece.`);
    return [a, b];
  }
  return res.coords;
}

// Edits run one after another in the order they were made. (Road snapping takes a moment;
// clicks made meanwhile are queued, never dropped.)
let queue = Promise.resolve();
function enqueue(fn) {
  state.pending += 1;
  updateBusy();
  const run = async () => {
    try { await fn(); } finally { state.pending -= 1; updateBusy(); }
  };
  queue = queue.then(run, run);
  return queue;
}
function updateBusy() {
  const note = $('busy-note');
  if (!note) return;
  note.hidden = state.pending === 0;
  note.textContent = state.pending ? `Working… ${state.pending} edit${state.pending === 1 ? '' : 's'} in progress (snapping to roads). Keep clicking — nothing is lost.` : '';
}

// ---- rendering ----
function renderList() {
  $('trace-list').innerHTML = state.routes.map((r) => {
    const sel = r.id === state.active;
    const km = (d) => { const l = state.lines.get(lineKey(r.id, d)); const p = l ? pathOf(l) : []; return p.length >= 2 ? lengthKm(p).toFixed(1) : null; };
    const k1 = km('a');
    const k2 = km('b');
    const status = !k1 && !k2 ? 'not traced'
      : [k1 ? `Route 1: ${k1} km` : 'Route 1 not traced', k2 ? `Route 2: ${k2} km` : 'Route 2 not traced yet'].join(' · ');
    return `<li class="route-item${sel ? ' is-selected' : ''}"><button type="button" class="route-select" style="padding-left:10px" data-route="${escapeHtml(r.id)}" aria-pressed="${sel}">
      <span class="route-swatch" style="background:${escapeHtml(r.displayColor)}" aria-hidden="true"></span>
      <span class="route-copy"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.jeepneyColorName)} jeepney · ${status}</span></span></button></li>`;
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
  const one = state.lines.get(lineKey(r.id, 'a'));
  const two = state.lines.get(lineKey(r.id, 'b'));
  const has1 = Boolean(one && one.waypoints.length >= 2);
  $('active-title').innerHTML = `<span class="route-swatch" style="background:${escapeHtml(r.displayColor)};height:20px" aria-hidden="true"></span> ${escapeHtml(r.name)} — ${state.dir === 'b' ? 'Route 2 (coming back)' : 'Route 1 (going)'}`;
  for (const d of DIRECTIONS) $(`dir-${d}`).setAttribute('aria-pressed', String(d === state.dir));
  const n = line?.waypoints.length ?? 0;
  $('active-stats').textContent = `${n} point${n === 1 ? '' : 's'} · about ${lengthKm(path).toFixed(2)} km.`;
  if (state.dir === 'a') {
    $('active-hint').textContent = n === 0
      ? 'Click the map where Route 1 STARTS (the first terminal). That first click is the start.'
      : 'Click along the road to the END of Route 1. Your last click is the new terminal — Route 2 starts there.';
  } else if (!has1) {
    $('active-hint').textContent = 'Trace Route 1 first (press “Route 1 — going”). Route 2 starts where Route 1 ends.';
  } else if (n === 0) {
    $('active-hint').textContent = 'Press “Start Route 2 where Route 1 ends”, then click along the road back.';
  } else {
    $('active-hint').textContent = 'Keep clicking along the way back (it can be a different road). When you reach the start terminal, press “Finish Route 2 at the start of Route 1”.';
  }
  $('twoway-toggle').checked = line ? !line.oneWay : false;
  $('start-name').value = line?.startName ?? '';
  $('end-name').value = line?.endName ?? '';
  // buttons that only make sense on Route 2 / Route 1
  const onTwo = state.dir === 'b';
  $('start-r2-btn').hidden = !(onTwo && has1 && n === 0);
  $('close-loop-btn').hidden = !(onTwo && has1 && n >= 1);
  $('copy-return-btn').hidden = !(onTwo && has1);
  // warnings
  const a = path.length >= 2 ? analyzeLine(path) : null;
  const warn = $('active-warning');
  if (state.dir === 'a' && a?.sameStartEnd && n >= 3) {
    warn.hidden = false;
    warn.textContent = '⚠ This line comes back to where it started, so it holds the WHOLE round trip. Route 1 should stop at the far terminal. Click the point where the jeepney turns around (the far end), then press “Split here” — the way back becomes Route 2.';
  } else if (state.dir === 'b' && a && has1 && a.retraced && !checkDirectionPair(one, line)?.ok) {
    warn.hidden = false;
    warn.textContent = '⚠ Part of Route 2 goes back over the same road. That is fine only if the jeepney really returns by the same road.';
  } else warn.hidden = true;
  const detours = line ? findDetours(line) : [];
  const dn = $('detour-note');
  dn.hidden = detours.length === 0;
  if (detours.length) {
    const first = detours[0];
    dn.textContent = `⚠ ${detours.length} part${detours.length === 1 ? '' : 's'} of this route take${detours.length === 1 ? 's' : ''} a long detour (for example from point ${first.from} to point ${first.to}: ${first.pathM} m along roads for a ${first.straightM} m gap). Press “Straighten the detours”, then add points along the real street.`;
  }
  $('straighten-btn').hidden = detours.length === 0;
  // Route 2 must start where Route 1 ends and end where Route 1 starts
  const pairEl = $('pair-check');
  const pair = one && two ? checkDirectionPair(one, two) : null;
  pairEl.hidden = !pair;
  if (pair) {
    pairEl.innerHTML = [
      pair.bStartsAtAEnd ? '<li class="pair-ok">✔ Route 2 starts where Route 1 ends.</li>' : `<li class="pair-bad">✖ Route 2 starts ${pair.startGapM} m away from where Route 1 ends. Its first click should be at Route 1’s last point.</li>`,
      pair.bEndsAtAStart ? '<li class="pair-ok">✔ Route 2 ends where Route 1 starts.</li>' : `<li class="pair-bad">✖ Route 2 ends ${pair.endGapM} m away from where Route 1 starts. Its last click should be at Route 1’s first point.</li>`,
    ].join('');
  }
  $('active-landmarks').textContent = `Legend landmarks (unordered guidance): ${(r.sourceLandmarks ?? []).join(' · ')}`;
  renderCut();
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
    m.on('dragend', () => { const ll = m.getLngLat(); enqueue(() => moveWaypoint(i, [ll.lng, ll.lat])); });
    // Keep clicks on a vertex from reaching the map (which would add a new point).
    if (state.selected === i) el.classList.add('vertex-selected');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected = state.selected === i ? null : i;
      renderMarkers();
      renderCut();
    });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); enqueue(() => deleteWaypoint(i)); });
    state.markers.push(m);
  });
}

function renderCut() {
  const line = getLine();
  const btn = $('cut-btn');
  const split = $('split-btn');
  const i = state.selected;
  const last = line ? line.waypoints.length - 1 : -1;
  const ok = line && i !== null && i < last;
  btn.hidden = !ok;
  if (ok) btn.textContent = `✂ Cut after point ${i + 1} (remove ${last - i} point${last - i === 1 ? '' : 's'})`;
  const canSplit = ok && state.dir === 'a' && i > 0;
  split.hidden = !canSplit;
  if (canSplit) split.textContent = `Split here: Route 1 ends at point ${i + 1}, the rest becomes Route 2`;
}

function commit() {
  state.selected = null;
  renderCut();
  saveLocal();
  renderList();
  renderActive();
  syncMap();
}

// ---- editing ----
async function addPoint(lngLat, opts = {}) {
  if (!state.active) { notify.alert('Pick a route from the list first, then click the map.'); return; }
  notify.clearAlert();
  const line = getLine(true);
  const p = [lngLat.lng, lngLat.lat];
  if (line.waypoints.length) line.segments.push(await makeSegment(line.waypoints.at(-1), p, opts));
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
  notify.status(`Tracing ${r.name}, ${directionLabel(state.dir)}.`);
  commit();
}

function bind() {
  $('trace-list').addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (b) selectRoute(b.dataset.route); });
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => { state.dir = b.dataset.dir; state.selected = null; selectRoute(state.active); }));
  $('start-r2-btn').onclick = () => enqueue(async () => {
    const one = state.lines.get(lineKey(state.active, 'a'));
    if (!one || one.waypoints.length < 2) { notify.alert('Trace Route 1 first.'); return; }
    const line = getLine(true);
    const end = one.waypoints.at(-1);
    line.waypoints = [[end[0], end[1]]];
    line.segments = [];
    line.oneWay = true;
    notify.status('Route 2 starts where Route 1 ends. Now click along the road back.');
    commit();
  });
  $('close-loop-btn').onclick = () => enqueue(async () => {
    const one = state.lines.get(lineKey(state.active, 'a'));
    const line = getLine();
    if (!one || one.waypoints.length < 2 || !line || line.waypoints.length < 1) { notify.alert('Trace Route 1, then start Route 2, before finishing it.'); return; }
    const first = one.waypoints[0];
    if (haversineMeters(line.waypoints.at(-1), first) < 20) { notify.status('Route 2 already ends at the start of Route 1.'); return; }
    line.segments.push(await makeSegment(line.waypoints.at(-1), first));
    line.waypoints.push([first[0], first[1]]);
    notify.status('Route 2 now ends at the start of Route 1.');
    commit();
  });
  $('copy-return-btn').onclick = () => {
    const r = activeRoute();
    const a = r && state.lines.get(lineKey(r.id, 'a'));
    if (!a || a.waypoints.length < 2) { notify.alert('Trace Route 1 first.'); return; }
    if (state.lines.get(lineKey(r.id, 'b'))?.waypoints.length && !confirm('Route 2 already has points. Replace them with Route 1 backwards?')) return;
    const b = JSON.parse(JSON.stringify(a));
    reverseLine(b);
    a.oneWay = true;
    b.oneWay = true;
    b.startName = a.endName;
    b.endName = a.startName;
    state.lines.set(lineKey(r.id, 'b'), b);
    state.dir = 'b';
    notify.status('Route 2 is now Route 1 backwards (same road back). Where the way back uses a different road: click that point, press “Cut after the selected point”, then click along the real road to the start.');
    commit();
  };
  $('split-btn').onclick = () => {
    const r = activeRoute();
    const line = getLine();
    const i = state.selected;
    if (!r || !line || i === null || i < 1 || i >= line.waypoints.length - 1) return;
    if (state.lines.get(lineKey(r.id, 'b'))?.waypoints.length && !confirm('Route 2 already has points. Replace them with the second part of this line?')) return;
    const [first, second] = splitLineAt(line, i);
    state.lines.set(lineKey(r.id, 'a'), first);
    state.lines.set(lineKey(r.id, 'b'), second);
    state.dir = 'a';
    notify.status('Split. Route 1 now ends at that point and Route 2 starts there.');
    commit();
  };
  $('straighten-btn').onclick = () => {
    const line = getLine();
    if (!line) return;
    const n = straightenDetours(line);
    notify.status(`${n} detour${n === 1 ? '' : 's'} replaced by straight lines. Add points along the real street to follow it.`);
    commit();
  };
  $('cut-btn').onclick = () => {
    const line = getLine();
    const i = state.selected;
    if (!line || i === null) return;
    line.waypoints.length = i + 1;
    line.segments.length = i;
    notify.status('Cut. Now click along the new road from the selected point.');
    commit();
  };
  $('undo-btn').onclick = () => enqueue(async () => { const l = getLine(); if (l?.waypoints.length) await deleteWaypoint(l.waypoints.length - 1); });
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
  $('save-geometry').onclick = async () => {
    const audit = Object.fromEntries(['change', 'reason', 'source', 'observation'].map((key) => [key, $(`audit-${key}`).value.trim()]));
    if (Object.values(audit).some((v) => !v)) { notify.alert('Complete the change, reason, information source, and observation fields before saving.'); return; }
    const geojson = exportGeoJson(); if (!geojson) return;
    const current = await fetch('/api/admin/dataset').then((r) => r.json());
    const nextGeo = JSON.parse(geojson);
    const routeIds = new Set([...current.geojson.features, ...nextGeo.features].map((f) => f.properties?.routeId).filter(Boolean));
    const changed = [...routeIds].filter((id) => {
      const a = current.geojson.features.filter((f) => f.properties?.routeId === id).map((f) => ({ direction: f.properties?.direction, oneWay: f.properties?.oneWay, geometry: f.geometry }));
      const b = nextGeo.features.filter((f) => f.properties?.routeId === id).map((f) => ({ direction: f.properties?.direction, oneWay: f.properties?.oneWay, geometry: f.geometry }));
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    if (!changed.length) { notify.status('No route geometry changes to save.'); return; }
    nextGeo.features = nextGeo.features.map((feature) => {
      const old = current.geojson.features.find((f) => f.properties?.routeId === feature.properties?.routeId && (f.properties?.direction || 'a') === (feature.properties?.direction || 'a'));
      return old ? { ...feature, properties: { ...old.properties, ...feature.properties } } : feature;
    });
    const response = await fetch('/api/admin/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { ...current, geojson: nextGeo }, editedRouteIds: changed, audit: { ...audit, date: new Date().toISOString().slice(0, 10) } }) });
    const result = await response.json();
    if (!response.ok) { notify.alert(result.details?.[0]?.message || result.error || 'Route geometry could not be saved.'); return; }
    notify.status(`Saved ${changed.length} changed route${changed.length === 1 ? '' : 's'} as revision ${result.revision}. Route status remains unverified.`);
    const saved = await loadData(import.meta.env.BASE_URL);
    if (saved.ok) { state.routes = saved.data.routes; state.lines = geojsonToLines(saved.data.geojson); saveLocal(); renderList(); renderActive(); syncMap(); }
  };
  $('preview-route').onclick = () => {
    const route = activeRoute(); const lines = route && routeLines(route.id).flatMap(pathOf);
    if (!lines?.length) { notify.alert('Choose a route and trace at least one direction before previewing.'); return; }
    const bounds = new maplibregl.LngLatBounds(lines[0], lines[0]); lines.forEach((point) => bounds.extend(point));
    state.map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: 500 });
    notify.status(`Previewing ${route.name} on the map. Review the dashed route before publishing.`);
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
  // The server is the canonical source in the private editor. Browser drafts
  // cannot silently override the current shared route dataset.
  state.lines = geojsonToLines(loaded.data.geojson);
  bind(); renderList(); renderActive();
  $('trace-legend').innerHTML = '<strong>Tracing tips</strong><div class="legend-row">Click = add point</div><div class="legend-row">Drag = move point</div><div class="legend-row">Double-click point = delete</div><div class="legend-row">Option/Alt + click = straight piece</div><div class="legend-row">S = start, E = end</div>';

  const offline = new URLSearchParams(location.search).has('offline');
  const { map, error } = createMap($('map'), (m) => notify.alert(m), { offline });
  if (error) { notify.alert('The interactive map could not start (WebGL may be unavailable).'); return; }
  state.map = map;
  if (offline) window.__trace = state; // test hook (offline mode only)
  const routeParam = new URLSearchParams(location.search).get('route');
  if (routeParam && state.routes.some((r) => r.id === routeParam)) selectRoute(routeParam);
  map.on('click', (e) => { const straight = Boolean(e.originalEvent?.altKey); enqueue(() => addPoint(e.lngLat, straight ? { snap: false } : {})); });
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
