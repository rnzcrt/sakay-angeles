import './admin.css';
import { escapeHtml } from './ui/html.js';
import { gatherRouteFormEdits, handleFareClassChange, loadFareClassForm } from './admin/routeFareClass.js';
import { ensureHistoryPreviewContainer, renderSavedDataPreview, toggleSavedDataPreview } from './admin/historyPreview.js';
import { createEditTracker, makeEditSnapshot, protectBeforeUnload, runUnsavedAction } from './admin/unsavedChanges.js';
import { createRouteDraft as makeRouteDraft, removeRouteData } from './admin/routeManagement.js';

const $ = (id) => document.getElementById(id);
let dataset; let selectedId = null;
let originalFareForm = null;
let editorBaseline = null;
let pendingGuardedAction = null;
let saveInProgress = false;
const announce = (message, error = false) => { $('admin-status').textContent = message; $('admin-status').classList.toggle('error', error); };
const auditFieldIds = [];
function auditValues() { return {}; }
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
  const route = currentRoute();
  if (!route) {
    $('route-form').hidden = true;
    $('route-select').disabled = true;
    $('route-summary').textContent = 'No Jeepneys yet. Add one to begin.';
    $('open-tracer').hidden = true;
    for (const id of auditFieldIds) $(id).value = '';
    editorBaseline = null;
    originalFareForm = null;
    editTracker.setBaseline(null);
    return;
  }
  $('route-form').hidden = false;
  $('route-select').disabled = false;
  $('open-tracer').hidden = false;
  $('route-name').value = route.name;
  const displayColor = /^#[0-9a-f]{6}$/i.test(route.displayColor ?? '') ? route.displayColor : '#808080';
  $('route-color').value = displayColor;
  $('route-color-name').value = route.jeepneyColorName ?? '';
  $('route-active').value = String(route.active !== false);
  originalFareForm = loadFareClassForm(route, fareControls());
  $('route-summary').textContent = `${route.active === false ? 'Inactive' : 'Active'} · Geometry: ${route.geometryStatus} · Fare class: ${route.fareClass ?? 'unknown'}`;
  $('open-tracer').href = `/trace.html?route=${encodeURIComponent(route.id)}`;
  const stops = dataset.stops.filter((s) => s.routeId === route.id);
  editorBaseline = { route: structuredClone(route), stops: structuredClone(stops), geoFeatures: structuredClone(dataset.geojson.features.filter((feature) => feature.properties?.routeId === route.id)), audit: auditValues() };
  editTracker.setBaseline(makeEditSnapshot(editorBaseline.route, editorBaseline.stops, editorBaseline.audit));
}
function renderRoutes() {
  $('route-select').innerHTML = dataset.routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name || 'New Jeepney')}</option>`).join('');
  selectedId = selectedId && dataset.routes.some((r) => r.id === selectedId) ? selectedId : dataset.routes[0]?.id;
  $('route-select').value = selectedId; showRoute();
}
function audit(action = 'save') {
  const isNew = selectedId && !(dataset._originalRouteIds ?? []).includes(selectedId);
  const routeName = currentRoute()?.name || 'Jeepney';
  const change = action === 'delete' ? `Deleted Jeepney: ${routeName}` : isNew ? `Created Jeepney: ${routeName}` : `Updated Jeepney details: ${routeName}`;
  const observation = action === 'delete'
    ? 'The Jeepney and its linked stops, geometry, and transfers were removed together in this revision.'
    : isNew
      ? 'Created as a Jeepney record before route tracing. No route geometry or directions were invented.'
      : 'Jeepney metadata was saved. Existing directions, stops, and route geometry were preserved.';
  return { change, reason: 'Administrator saved changes through the private route management page.', source: 'Private route management', observation, date: new Date().toISOString().slice(0, 10) };
}
function fareControls() {
  return {
    name: $('route-name'), colorName: $('route-color-name'), color: $('route-color'), active: $('route-active'), fareClass: $('fare-class'),
  };
}
function collectRouteEdits() {
  const route = structuredClone(editorBaseline.route);
  const gathered = gatherRouteFormEdits({ route, controls: fareControls(), original: originalFareForm, stops: dataset.stops,
    selectedId, originalStops: dataset._originalStops || [], metadataOnly: true });
  return gathered;
}
function refreshDirty() {
  if (!editorBaseline) return false;
  const gathered = collectRouteEdits();
  const routeSnapshot = structuredClone(gathered.route);
  if (!(dataset._originalRouteIds ?? []).includes(selectedId)) routeSnapshot.__newRoute = true;
  const snapshot = makeEditSnapshot(routeSnapshot, gathered.stops.filter((stop) => stop.routeId === selectedId), auditValues());
  return editTracker.update(snapshot);
}
function gatherRouteEdits() {
  const gathered = collectRouteEdits();
  const retainedDirectionIds = new Set(gathered.route.directions.map((direction) => direction.id));
  const removedDirections = (editorBaseline.route.directions ?? []).filter((direction) => !retainedDirectionIds.has(direction.id));
  const removedGeometryIds = new Set(removedDirections.map((direction) => direction.geometryId).filter(Boolean));
  const removedDirectionIds = new Set(removedDirections.map((direction) => direction.id));
  if (removedDirections.length) dataset.geojson.features = dataset.geojson.features.filter((feature) => feature.properties?.routeId !== selectedId || (!removedDirectionIds.has(feature.properties?.directionId) && !removedGeometryIds.has(feature.properties?.geometryId)));
  const index = dataset.routes.findIndex((route) => route.id === selectedId);
  dataset.routes[index] = gathered.route;
  dataset.stops = gathered.stops;
  dataset.routesFile.routes = dataset.routes;
}
function restoreSelectedBaseline() {
  if (!editorBaseline) return;
  if (!(dataset._originalRouteIds ?? []).includes(selectedId)) {
    dataset.routes = dataset.routes.filter((route) => route.id !== selectedId);
    dataset.stops = dataset.stops.filter((stop) => stop.routeId !== selectedId);
    dataset.routesFile.routes = dataset.routes;
    selectedId = dataset.routes[0]?.id ?? null;
    renderRoutes();
    return;
  }
  const index = dataset.routes.findIndex((route) => route.id === selectedId);
  dataset.routes[index] = structuredClone(editorBaseline.route);
  dataset.stops = dataset.stops.filter((stop) => stop.routeId !== selectedId).concat(structuredClone(editorBaseline.stops));
  dataset.geojson.features = dataset.geojson.features.filter((feature) => feature.properties?.routeId !== selectedId).concat(structuredClone(editorBaseline.geoFeatures));
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
    try { await loadAll(); }
    catch (reloadError) {
      announce(`Revision ${result.revision.slice(0, 8)} was saved, but the updated dataset could not be reloaded. Reload before editing or saving again. ${reloadError.message}`, true);
      refreshDirty();
      return false;
    }
    announce(`Saved as revision ${result.revision.slice(0, 8)}; changed geometry and affected stops remain unverified.`);
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
  dataset = await api('/api/admin/dataset'); dataset._originalStops = structuredClone(dataset.stops); dataset._originalRouteIds = dataset.routes.map((route) => route.id);
  renderRoutes(); await Promise.all([loadHistory(), loadFeedback()]);
}

function createRouteDraft() {
  const route = makeRouteDraft(`jeepney-${crypto.randomUUID()}`);
  dataset.routes.push(route);
  dataset.routesFile.routes = dataset.routes;
  selectedId = route.id;
  renderRoutes();
  $('route-name').focus();
  announce('New Jeepney draft created. Complete its details and save before tracing geometry.');
}


async function deleteEmptyRouteDraft(routeId = selectedId) {
  const route = dataset.routes.find((item) => item.id === routeId);
  if (!route) return;

  const removal = removeRouteData(dataset, route.id);

  if (!removal.ok) {
    announce(
      'This Jeepney is no longer available. Reload route data and try again.',
      true
    );
    return;
  }

  const { directions, stops, features, transfers } = removal.impact;

  const impact =
    `${directions} direction${directions === 1 ? '' : 's'}, ` +
    `${stops} stop${stops === 1 ? '' : 's'}, ` +
    `${features} geometry feature${features === 1 ? '' : 's'}, and ` +
    `${transfers} transfer${transfers === 1 ? '' : 's'}`;

  const confirmed = confirm(
    `Permanently delete “${route.name || 'New Jeepney'}” and its ${impact}? ` +
    'Linked transfer records will also be removed; unrelated route records are preserved. ' +
    'All removals are saved together in one revision. ' +
    'This cannot be undone except by restoring a saved revision.'
  );

  if (!confirmed) return;

  const isNew = !(dataset._originalRouteIds ?? []).includes(route.id);

  // A new Jeepney draft has not been saved to the server yet.
  if (isNew) {
    dataset = removal.data;
    dataset._originalStops = structuredClone(dataset.stops);
    dataset._originalRouteIds = dataset.routes.map((item) => item.id);

    selectedId = dataset.routes[0]?.id ?? null;

    renderRoutes();
    announce('Unsaved empty Jeepney draft deleted.');
    return;
  }

  // Existing Jeepneys must be deleted through the authenticated save API.
  const next = removal.data;

  const lockedControls = [
    ...$('route-form').elements,
    $('route-select'),
    $('reload'),
    $('signout'),
    $('add-route'),
    $('delete-route'),
  ];

  if (saveInProgress) return;

  // Remember each control's original state before disabling it.
  const previousDisabled = lockedControls.map(
    (control) => control.disabled
  );

  saveInProgress = true;
  lockedControls.forEach((control) => {
    control.disabled = true;
  });

  try {
    const result = await api('/api/admin/save', {
      method: 'POST',
      body: JSON.stringify({
        data: next,
        editedRouteIds: [route.id],
        expectedCommitSha: dataset.commitSha,
        audit: audit('delete'),
      }),
    });

    announce(
      `Jeepney deleted in revision ${result.revision.slice(0, 8)}.`
    );

    selectedId = null;
    await loadAll();
  } catch (error) {
    announce(error.message, true);
  } finally {
    // Restore the original disabled states instead of enabling everything.
    lockedControls.forEach((control, index) => {
      control.disabled = previousDisabled[index];
    });

    saveInProgress = false;
  }
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
$('reload').addEventListener('click', () => guardAction(() => loadAll().then(() => announce('Route data reloaded.')).catch((e) => announce(e.message, true)), () => {}));
$('signout').addEventListener('click', () => guardAction(async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); }));
$('add-route').addEventListener('click', () => guardAction(createRouteDraft));

$('delete-route').addEventListener('click', () => {
  if (saveInProgress) return;

  deleteEmptyRouteDraft(selectedId);
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
