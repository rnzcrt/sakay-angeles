import { escapeHtml } from '../ui/html.js';

export function ensureHistoryPreviewContainer(entry, revisionId, createElement = (tag) => document.createElement(tag)) {
  if (!entry || typeof entry.querySelector !== 'function' || typeof entry.appendChild !== 'function') return null;
  let preview = entry.querySelector('[data-preview]');
  if (!preview) {
    preview = createElement('div');
    if (!preview) return null;
    if (preview.dataset) preview.dataset.preview = revisionId;
    else preview.setAttribute('data-preview', revisionId);
    entry.appendChild(preview);
  }
  return preview;
}

export function renderSavedDataPreview(item, selectedId) {
  const data = item?.data;
  if (!data || !Array.isArray(data.routes) || !Array.isArray(data.stops) || !Array.isArray(data.geojson?.features)) {
    return '<p class="admin-muted">Saved revision data is unavailable or malformed.</p>';
  }

  const route = data.routes.find((candidate) => candidate && typeof candidate === 'object' && candidate.id === selectedId) || null;
  const stops = data.stops.filter((stop) => stop && typeof stop === 'object' && stop.routeId === selectedId);
  const geometry = data.geojson.features.filter((feature) => feature && typeof feature === 'object' && feature.properties?.routeId === selectedId);
  const snapshot = { route, stops, geometry };
  let serialized;
  try { serialized = JSON.stringify(snapshot, null, 2); }
  catch { return '<p class="admin-muted">Saved revision data could not be displayed.</p>'; }
  if (typeof serialized !== 'string') return '<p class="admin-muted">Saved revision data could not be displayed.</p>';

  return `<details open><summary>Saved ${escapeHtml(route?.name || selectedId || 'route')} data</summary><pre>${escapeHtml(serialized)}</pre></details>`;
}

export function toggleSavedDataPreview(preview, markup) {
  if (!preview || typeof preview.querySelector !== 'function') return false;
  if (preview.querySelector('details')) {
    preview.replaceChildren();
    return false;
  }
  preview.innerHTML = markup;
  return true;
}
