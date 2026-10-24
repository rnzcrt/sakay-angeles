import './admin.css';
import { escapeHtml } from './ui/html.js';

const $ = (id) => document.getElementById(id);
let dataset; let selectedId = null;
const announce = (message, error = false) => { $('admin-status').textContent = message; $('admin-status').classList.toggle('error', error); };
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
  return result;
}
const currentRoute = () => dataset?.routes.find((r) => r.id === selectedId);

function showRoute() {
  const route = currentRoute(); if (!route) return;
  $('route-name').value = route.name;
  $('route-description').value = route.description ?? '';
  $('fare-class').value = route.fareClass ?? '';
  $('route-summary').textContent = `${route.jeepneyColorName} jeepney · Geometry: ${route.geometryStatus} · Fare class: ${route.fareClass ?? 'unknown'}`;
  $('open-tracer').href = `/trace.html?route=${encodeURIComponent(route.id)}`;
  const stops = dataset.stops.filter((s) => s.routeId === route.id);
  $('stops-list').innerHTML = stops.map((stop) => `<div class="stop-row" data-stop="${escapeHtml(stop.id)}"><label>Name<input data-field="name" value="${escapeHtml(stop.name)}" maxlength="160" required></label><label>Kind<select data-field="kind"><option value="terminal" ${stop.kind === 'terminal' ? 'selected' : ''}>Terminal</option><option value="boarding" ${stop.kind === 'boarding' ? 'selected' : ''}>Boarding / drop-off</option><option value="stop" ${stop.kind === 'stop' ? 'selected' : ''}>Intermediate stop</option></select></label><label>Longitude<input data-field="lng" type="number" step="any" value="${stop.coordinates[0] ?? ''}" required></label><label>Latitude<input data-field="lat" type="number" step="any" value="${stop.coordinates[1] ?? ''}" required></label><button class="admin-button secondary stop-delete" type="button" data-delete="${escapeHtml(stop.id)}">Remove stop</button></div>`).join('') || '<p class="admin-muted">No recorded stops for this route.</p>';
}
function renderRoutes() {
  $('route-select').innerHTML = dataset.routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} · ${escapeHtml(r.jeepneyColorName)}</option>`).join('');
  selectedId = selectedId && dataset.routes.some((r) => r.id === selectedId) ? selectedId : dataset.routes[0]?.id;
  $('route-select').value = selectedId; showRoute();
}
function audit() { return { change: $('audit-change').value.trim(), reason: $('audit-reason').value.trim(), source: $('audit-source').value.trim(), observation: $('audit-observation').value.trim(), date: new Date().toISOString().slice(0, 10) }; }
function gatherRouteEdits() {
  const route = currentRoute(); route.name = $('route-name').value.trim(); route.description = $('route-description').value.trim();
  if ($('fare-class').value) {
    route.fareClass = $('fare-class').value;
    const record = audit();
    route.fareClassEvidence = { source: record.source, method: `${record.change}. ${record.observation}`.slice(0, 1000), checkedAt: record.date };
  } else { route.fareClass = null; delete route.fareClassEvidence; }
  dataset.stops = dataset.stops.filter((s) => s.routeId !== selectedId);
  for (const row of $('stops-list').querySelectorAll('.stop-row')) {
    const id = row.dataset.stop;
    const old = (dataset._originalStops || []).find((s) => s.id === id);
    const value = (field) => row.querySelector(`[data-field="${field}"]`).value;
    const stop = old ? structuredClone(old) : { id, routeId: selectedId, verificationStatus: 'unverified' };
    stop.name = value('name').trim(); stop.kind = value('kind');
    stop.coordinates = [value('lng').trim() === '' ? null : Number(value('lng')), value('lat').trim() === '' ? null : Number(value('lat'))];
    if (stop.kind !== 'terminal') { stop.verificationStatus = 'unverified'; delete stop.source; }
    dataset.stops.push(stop);
  }
  dataset.routesFile.routes = dataset.routes;
}
async function loadAll() {
  dataset = await api('/api/admin/dataset'); dataset._originalStops = structuredClone(dataset.stops);
  renderRoutes(); await Promise.all([loadHistory(), loadFeedback()]);
}
async function loadHistory() {
  try {
    const history = await api('/api/admin/history');
    $('history-list').innerHTML = history.length ? history.map((h) => `<div class="admin-list-item"><strong>${escapeHtml(new Date(h.createdAt).toLocaleString())} · ${escapeHtml(h.author)}</strong><p>${escapeHtml(h.audit?.change || 'Saved route data')} — ${escapeHtml(h.audit?.reason || '')}</p><button class="admin-button secondary" type="button" data-inspect="${escapeHtml(h.id)}">Inspect saved data</button> <button class="admin-button secondary" type="button" data-history="${escapeHtml(h.id)}">Restore this revision</button><div data-preview="${escapeHtml(h.id)}"></div></div>`).join('') : '<p class="admin-muted">No saved changes yet.</p>';
  } catch (e) { $('history-list').textContent = e.message; }
}
async function loadFeedback() {
  try {
    const issues = await api('/api/admin/feedback');
    $('feedback-list').innerHTML = issues.length ? issues.map((i) => {
      const routeText = (i.body || '').match(/### Route \/ jeepney color\s*\n([^\n]+)/i)?.[1] || '';
      const route = dataset.routes.find((r) => routeText.toLowerCase().includes(r.name.toLowerCase()) || routeText.toLowerCase().includes(r.jeepneyColorName.toLowerCase()));
      const existingStatus = i.labels.find((label) => label.startsWith('feedback-'))?.slice('feedback-'.length);
      const options = [['accepted', 'Accepted'], ['rejected', 'Rejected'], ['resolved', 'Resolved / applied'], ['needs-information', 'Needs more information']];
      return `<div class="admin-list-item"><strong>#${i.number} ${escapeHtml(i.title)}</strong><p>Submitted ${escapeHtml(new Date(i.createdAt).toLocaleDateString())} · ${escapeHtml(i.labels.join(', ') || 'pending review')}</p><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">Open report on GitHub</a>${route ? ` · <a href="/trace.html?route=${encodeURIComponent(route.id)}">Open ${escapeHtml(route.name)} in the tracer</a>` : ''}<p>${escapeHtml((i.body || '').slice(0, 1200))}</p><label>Review status<select data-feedback-status="${i.number}" required><option value="" ${existingStatus ? '' : 'selected'} disabled>Choose a status</option>${options.map(([value, label]) => `<option value="${value}" ${existingStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><input data-feedback-note="${i.number}" placeholder="Optional note for the report" maxlength="2000"><button class="admin-button secondary" type="button" data-review="${i.number}">Update report status</button></div>`;
    }).join('') : '<p class="admin-muted">No open community reports found.</p>';
  } catch (e) { $('feedback-list').innerHTML = `<p class="admin-muted">${escapeHtml(e.message)}. Reports can still be reviewed on <a href="https://github.com/rnzcrt/sakay-angeles/issues" target="_blank" rel="noopener">GitHub Issues</a>.</p>`; }
}

async function init() {
  const session = await api('/api/admin/session');
  if (!session.configured) { $('login-panel').hidden = false; $('login-button').hidden = true; $('login-message').textContent = 'Admin sign-in is disabled until the server owner configures GitHub OAuth and the authorized account allowlist.'; return; }
  if (!session.authenticated) { $('login-panel').hidden = false; $('login-button').hidden = false; return; }
  $('workspace').hidden = false; $('signout').hidden = false; $('admin-user').textContent = `Signed in as ${session.user}`;
  await loadAll();
}

$('route-select').addEventListener('change', (e) => { selectedId = e.target.value; showRoute(); });
$('reload').addEventListener('click', () => loadAll().then(() => announce('Route data reloaded.')).catch((e) => announce(e.message, true)));
$('signout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); });
$('add-stop').addEventListener('click', () => {
  const id = `${selectedId}-stop-${crypto.randomUUID()}`;
  dataset.stops.push({ id, routeId: selectedId, name: 'New stop', kind: 'boarding', coordinates: [null, null], verificationStatus: 'unverified' });
  dataset._originalStops.push(structuredClone(dataset.stops.at(-1))); showRoute();
});
$('stops-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-delete]')?.dataset.delete; if (!id) return;
  dataset.stops = dataset.stops.filter((s) => s.id !== id); dataset._originalStops = dataset._originalStops.filter((s) => s.id !== id); showRoute();
});
$('route-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { gatherRouteEdits(); const result = await api('/api/admin/save', { method: 'POST', body: JSON.stringify({ data: dataset, editedRouteIds: [selectedId], audit: audit() }) }); announce(`Saved. Revision ${result.revision} created; changed route details remain unverified.`); await loadAll(); }
  catch (err) { announce(err.message, true); }
});
$('history-list').addEventListener('click', async (e) => {
  const inspectId = e.target.closest('[data-inspect]')?.dataset.inspect;
  if (inspectId) {
    try {
      const item = await api(`/api/admin/history/item?id=${encodeURIComponent(inspectId)}`);
      const route = item.data.routes.find((r) => r.id === selectedId);
      const snapshot = { route, stops: item.data.stops.filter((s) => s.routeId === selectedId), geometry: item.data.geojson.features.filter((f) => f.properties?.routeId === selectedId) };
      $(`[data-preview="${CSS.escape(inspectId)}"]`).innerHTML = `<details open><summary>Saved ${escapeHtml(route?.name || selectedId)} data</summary><pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre></details>`;
    } catch (err) { announce(err.message, true); }
    return;
  }
  const id = e.target.closest('[data-history]')?.dataset.history; if (!id) return;
  try { const item = await api(`/api/admin/history/item?id=${encodeURIComponent(id)}`); const ok = confirm(`Revision ${new Date(item.createdAt).toLocaleString()}\n\n${item.audit?.change}\nReason: ${item.audit?.reason}\nSource: ${item.audit?.source}\n\nRestore this complete route dataset?`); if (!ok) return; const result = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify({ id }) }); announce(`Restored previous data. Recovery revision ${result.revision} created; route geometry and directions remain unverified.`); await loadAll(); } catch (err) { announce(err.message, true); }
});
$('feedback-list').addEventListener('click', async (e) => {
  const number = e.target.closest('[data-review]')?.dataset.review; if (!number) return;
  const status = $(`[data-feedback-status="${number}"]`).value; const note = $(`[data-feedback-note="${number}"]`).value;
  if (!status) { announce('Choose a report status first.', true); return; }
  try { await api('/api/admin/feedback/status', { method: 'POST', body: JSON.stringify({ number: Number(number), status, note }) }); announce(`Report #${number} updated. No route data was changed.`); await loadFeedback(); } catch (err) { announce(err.message, true); }
});
init().catch((e) => { $('login-panel').hidden = false; $('login-message').textContent = e.message; });
