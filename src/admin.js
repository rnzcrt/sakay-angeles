import './admin.css';
import { escapeHtml } from './ui/html.js';
import { gatherRouteFormEdits, handleFareClassChange, loadFareClassForm } from './admin/routeFareClass.js';
import { ensureHistoryPreviewContainer, renderSavedDataPreview, toggleSavedDataPreview } from './admin/historyPreview.js';
import { createEditTracker, makeEditSnapshot, protectBeforeUnload, runUnsavedAction } from './admin/unsavedChanges.js';

const $ = (id) => document.getElementById(id);
let dataset; let selectedId = null;
let originalFareForm = null;
let editorBaseline = null;
let pendingGuardedAction = null;
let saveInProgress = false;
const announce = (message, error = false) => { $('admin-status').textContent = message; $('admin-status').classList.toggle('error', error); };
const auditFieldIds = ['audit-change', 'audit-reason', 'audit-source', 'audit-observation'];
function auditValues() { return Object.fromEntries(auditFieldIds.map((id) => [id, $(id).value.trim()])); }
function setUnsavedIndicator(dirty, { dataDirty, auditDirty }) {
  const indicator = $('unsaved-indicator');
  indicator.hidden = !dirty;
  indicator.textContent = !dirty ? '' : auditDirty && !dataDirty
    ? 'Unsaved audit details. They can only be saved with a route or stop change.'
    : 'Unsaved changes. Save or discard before leaving this route.';
}
function updateUnsavedDialog() {
  const auditOnly = editTracker.auditDirty && !editTracker.dataDirty;
  $('unsaved-title').textContent = auditOnly ? 'Unsaved audit details' : 'Unsaved route changes';
  $('unsaved-description').textContent = auditOnly
    ? 'Audit details can only be saved together with an actual route or stop change. Discard these audit details or cancel and keep editing.'
    : 'This route has unsaved edits. Save them before continuing, discard them, or cancel and keep editing.';
  $('unsaved-save').hidden = auditOnly;
  $('unsaved-discard').textContent = auditOnly ? 'Discard audit details and continue' : 'Discard and continue';
}
const editTracker = createEditTracker(setUnsavedIndicator);
window.addEventListener('beforeunload', (event) => protectBeforeUnload(event, editTracker));
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
  originalFareForm = loadFareClassForm(route, fareControls());
  $('route-summary').textContent = `${route.jeepneyColorName} jeepney · Geometry: ${route.geometryStatus} · Fare class: ${route.fareClass ?? 'unknown'}`;
  $('open-tracer').href = `/trace.html?route=${encodeURIComponent(route.id)}`;
  const stops = dataset.stops.filter((s) => s.routeId === route.id);
  $('stops-list').innerHTML = stops.map(renderStopRow).join('') || '<p class="admin-muted">No recorded stops for this route.</p>';
  editorBaseline = { route: structuredClone(route), stops: structuredClone(stops), audit: auditValues() };
  editTracker.setBaseline(makeEditSnapshot(editorBaseline.route, editorBaseline.stops, editorBaseline.audit));
}
function renderStopRow(stop) {
  return `<div class="stop-row" data-stop="${escapeHtml(stop.id)}"><label>Name<input data-field="name" value="${escapeHtml(stop.name)}" maxlength="160" required></label><label>Kind<select data-field="kind"><option value="terminal" ${stop.kind === 'terminal' ? 'selected' : ''}>Terminal</option><option value="boarding" ${stop.kind === 'boarding' ? 'selected' : ''}>Boarding / drop-off</option><option value="stop" ${stop.kind === 'stop' ? 'selected' : ''}>Intermediate stop</option></select></label><label>Longitude<input data-field="lng" type="number" step="any" value="${stop.coordinates[0] ?? ''}" required></label><label>Latitude<input data-field="lat" type="number" step="any" value="${stop.coordinates[1] ?? ''}" required></label><button class="admin-button secondary stop-delete" type="button" data-delete="${escapeHtml(stop.id)}">Remove stop</button></div>`;
}
function renderRoutes() {
  $('route-select').innerHTML = dataset.routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} · ${escapeHtml(r.jeepneyColorName)}</option>`).join('');
  selectedId = selectedId && dataset.routes.some((r) => r.id === selectedId) ? selectedId : dataset.routes[0]?.id;
  $('route-select').value = selectedId; showRoute();
}
function audit() { return { change: $('audit-change').value.trim(), reason: $('audit-reason').value.trim(), source: $('audit-source').value.trim(), observation: $('audit-observation').value.trim(), date: new Date().toISOString().slice(0, 10) }; }
function fareControls() {
  return {
    name: $('route-name'), description: $('route-description'), fareClass: $('fare-class'),
    evidenceSource: $('fare-evidence-source'), evidenceMethod: $('fare-evidence-method'), evidenceDate: $('fare-evidence-date'),
  };
}
function collectRouteEdits() {
  const route = structuredClone(editorBaseline.route);
  const gathered = gatherRouteFormEdits({ route, controls: fareControls(), original: originalFareForm, stops: dataset.stops,
    selectedId, stopRows: $('stops-list').querySelectorAll('.stop-row'), originalStops: dataset._originalStops || [] });
  return gathered;
}
function refreshDirty() {
  if (!editorBaseline) return false;
  const gathered = collectRouteEdits();
  const snapshot = makeEditSnapshot(gathered.route, gathered.stops.filter((stop) => stop.routeId === selectedId), auditValues());
  return editTracker.update(snapshot);
}
function gatherRouteEdits() {
  const gathered = collectRouteEdits();
  const index = dataset.routes.findIndex((route) => route.id === selectedId);
  dataset.routes[index] = gathered.route;
  dataset.stops = gathered.stops;
  dataset.routesFile.routes = dataset.routes;
}
function restoreSelectedBaseline() {
  if (!editorBaseline) return;
  const index = dataset.routes.findIndex((route) => route.id === selectedId);
  dataset.routes[index] = structuredClone(editorBaseline.route);
  dataset.stops = dataset.stops.filter((stop) => stop.routeId !== selectedId).concat(structuredClone(editorBaseline.stops));
  dataset.routesFile.routes = dataset.routes;
  for (const id of auditFieldIds) $(id).value = editorBaseline.audit[id];
  showRoute();
}
async function saveCurrentRoute() {
  if (saveInProgress) return false;
  refreshDirty();
  if (!editTracker.dataDirty) {
    announce(editTracker.auditDirty
      ? 'Audit details can only be saved together with an actual route or stop change.'
      : 'Make a route or stop change before saving.', true);
    return false;
  }
  if (!$('route-form').reportValidity()) return false;
  saveInProgress = true;
  const lockedControls = [...$('route-form').elements, $('route-select'), $('reload'), $('signout')];
  const previousDisabled = lockedControls.map((control) => control.disabled);
  lockedControls.forEach((control) => { control.disabled = true; });
  try {
    gatherRouteEdits();
    const result = await api('/api/admin/save', { method: 'POST', body: JSON.stringify({ data: dataset, editedRouteIds: [selectedId], expectedCommitSha: dataset.commitSha, audit: audit() }) });
    announce(`Saved as revision ${result.revision.slice(0, 8)}; changed route details remain unverified.`);
    await loadAll();
    return true;
  } catch (err) {
    announce(err.message, true);
    refreshDirty();
    return false;
  } finally {
    lockedControls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
    saveInProgress = false;
  }
}
async function guardAction(run, afterSave = run) {
  if (saveInProgress) return;
  try {
    const result = await runUnsavedAction({ dirty: editTracker.dirty, proceed: run });
    if (result === 'confirmation-required') {
      pendingGuardedAction = { run, afterSave };
      updateUnsavedDialog();
      $('unsaved-dialog').showModal();
      $('unsaved-cancel').focus();
    }
  } catch (error) { announce(error.message, true); }
}
async function resolveGuard(choice) {
  const pending = pendingGuardedAction;
  if (!pending) return;
  pendingGuardedAction = null;
  if (choice === 'save' && !$('route-form').checkValidity()) {
    $('unsaved-dialog').close();
    $('route-form').reportValidity();
    return;
  }
  try {
    const outcome = await runUnsavedAction({
      dirty: editTracker.dirty,
      canSave: editTracker.dataDirty,
      choice,
      save: saveCurrentRoute,
      discard: restoreSelectedBaseline,
      proceed: choice === 'save' ? pending.afterSave : pending.run,
    });
    if (outcome === 'save-failed') return;
  } catch (error) {
    announce(error.message, true);
  } finally {
    $('unsaved-dialog').close();
  }
}
async function restoreRevision(id) {
  try { const item = await api(`/api/admin/history/item?id=${encodeURIComponent(id)}`); const ok = confirm(`Revision ${new Date(item.createdAt).toLocaleString()}\n\n${item.audit?.change}\nReason: ${item.audit?.reason}\nSource: ${item.audit?.source}\n\nRestore this complete route dataset?`); if (!ok) return; const result = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify({ id, expectedCommitSha: dataset.commitSha }) }); announce(`Restored previous data in revision ${result.revision.slice(0, 8)}; route geometry and directions remain unverified.`); await loadAll(); } catch (err) { announce(err.message, true); }
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

$('route-select').addEventListener('change', (e) => {
  const nextId = e.target.value;
  if (saveInProgress) { $('route-select').value = selectedId; return; }
  if (nextId === selectedId) return;
  $('route-select').value = selectedId;
  guardAction(() => { selectedId = nextId; $('route-select').value = selectedId; showRoute(); });
});
$('fare-class').addEventListener('change', () => {
  handleFareClassChange(fareControls(), originalFareForm);
  refreshDirty();
});
$('route-form').addEventListener('input', refreshDirty);
$('route-form').addEventListener('change', refreshDirty);
$('stops-list').addEventListener('input', refreshDirty);
$('stops-list').addEventListener('change', refreshDirty);
$('reload').addEventListener('click', () => guardAction(() => loadAll().then(() => announce('Route data reloaded.')).catch((e) => announce(e.message, true)), () => {}));
$('signout').addEventListener('click', () => guardAction(async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); }));
$('add-stop').addEventListener('click', () => {
  const id = `${selectedId}-stop-${crypto.randomUUID()}`;
  if (!$('stops-list').querySelector('.stop-row')) $('stops-list').innerHTML = '';
  $('stops-list').insertAdjacentHTML('beforeend', renderStopRow({ id, name: 'New stop', kind: 'boarding', coordinates: [null, null] }));
  refreshDirty();
});
$('stops-list').addEventListener('click', (e) => {
  const removeButton = e.target.closest('[data-delete]'); if (!removeButton) return;
  removeButton.closest('.stop-row')?.remove();
  if (!$('stops-list').querySelector('.stop-row')) $('stops-list').innerHTML = '<p class="admin-muted">No recorded stops for this route.</p>';
  refreshDirty();
});
$('route-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveCurrentRoute();
});
$('unsaved-save').addEventListener('click', () => resolveGuard('save'));
$('unsaved-discard').addEventListener('click', () => resolveGuard('discard'));
$('unsaved-cancel').addEventListener('click', () => resolveGuard('cancel'));
$('unsaved-dialog').addEventListener('cancel', (e) => { e.preventDefault(); resolveGuard('cancel'); });
function historyPreviewFor(revisionId) {
  const list = $('history-list');
  const button = [...list.querySelectorAll('[data-inspect]')].find((candidate) => candidate.dataset.inspect === revisionId);
  const entry = button?.closest('.admin-list-item');
  return entry ? ensureHistoryPreviewContainer(entry, revisionId) : null;
}
$('history-list').addEventListener('click', async (e) => {
  const inspectId = e.target.closest('[data-inspect]')?.dataset.inspect;
  if (inspectId) {
    const initialPreview = historyPreviewFor(inspectId);
    if (!initialPreview) { announce('This history entry is no longer available. Reload route history and try again.', true); return; }
    if (initialPreview.querySelector('details')) { toggleSavedDataPreview(initialPreview, ''); return; }
    const previewRouteId = selectedId;
    initialPreview.textContent = 'Loading saved data…';
    try {
      const item = await api(`/api/admin/history/item?id=${encodeURIComponent(inspectId)}`);
      const preview = historyPreviewFor(inspectId);
      if (!preview) { announce('This history entry is no longer available. Reload route history and try again.', true); return; }
      preview.innerHTML = renderSavedDataPreview(item, previewRouteId);
    } catch (err) {
      const preview = historyPreviewFor(inspectId);
      if (preview) preview.textContent = err.message;
      announce(err.message, true);
    }
    return;
  }
  const id = e.target.closest('[data-history]')?.dataset.history; if (!id) return;
  guardAction(() => restoreRevision(id));
});
$('feedback-list').addEventListener('click', async (e) => {
  const number = e.target.closest('[data-review]')?.dataset.review; if (!number) return;
  const status = $(`[data-feedback-status="${number}"]`).value; const note = $(`[data-feedback-note="${number}"]`).value;
  if (!status) { announce('Choose a report status first.', true); return; }
  try { await api('/api/admin/feedback/status', { method: 'POST', body: JSON.stringify({ number: Number(number), status, note }) }); announce(`Report #${number} updated. No route data was changed.`); await loadFeedback(); } catch (err) { announce(err.message, true); }
});
init().catch((e) => { $('login-panel').hidden = false; $('login-message').textContent = e.message; });
