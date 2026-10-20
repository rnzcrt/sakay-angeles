// Pure string renderers (testable in Node) for the route list and route detail.
// All names/colors come from route metadata passed in; nothing is hard-coded here.

import { VERIFICATION_LABELS } from '../config.js';
import { escapeHtml } from './html.js';

export function routeHasGeometry(route, geojson) {
  return (geojson?.features ?? []).some((f) => f.properties?.routeId === route.id);
}

const swatch = (route) =>
  `<span class="route-swatch" style="background:${escapeHtml(route.displayColor)}" aria-hidden="true"></span>`;

export function renderRouteItem(route, { selected = false, visible = true, hasGeometry = false } = {}) {
  const status = hasGeometry
    ? `${route.verifiedTerminals?.length ?? 0} verified terminals · path ${escapeHtml(VERIFICATION_LABELS[route.geometryStatus] ?? route.geometryStatus)}`
    : 'No digitized line yet';
  return `<li class="route-item${selected ? ' is-selected' : ''}">
  <label class="route-toggle"><input type="checkbox" data-route-toggle="${escapeHtml(route.id)}" ${visible ? 'checked' : ''} ${hasGeometry ? '' : 'disabled'}>
    <span class="visually-hidden">Show ${escapeHtml(route.name)} on the map${hasGeometry ? '' : ' (no line available yet)'}</span></label>
  <button type="button" class="route-select" data-route-select="${escapeHtml(route.id)}" aria-pressed="${selected}">
    ${swatch(route)}
    <span class="route-copy"><strong>${escapeHtml(route.name)}</strong>
    <span>${escapeHtml(route.jeepneyColorName)} jeepney · ${status}</span></span>
  </button>
</li>`;
}

export function renderRouteDetail(route, { hasGeometry = false } = {}) {
  const notes = (route.labelNotes ?? []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const landmarks = (route.sourceLandmarks ?? []).map(escapeHtml).join(' · ');
  const secondary = (route.secondarySources ?? []).map((s) => `<div class="secondary">
    <p class="detail-flag"><strong>Unverified secondary source (blog):</strong> ${escapeHtml(s.matchToLegend)}</p>
    <dl class="detail-grid"><dt>Start</dt><dd>${escapeHtml(s.startPoint)}</dd><dt>End</dt><dd>${escapeHtml(s.endPoint)}</dd>
    <dt>Roads</dt><dd>${(s.roads ?? []).map(escapeHtml).join(' · ')}</dd><dt>Landmarks</dt><dd>${(s.landmarks ?? []).map(escapeHtml).join(' · ')}</dd></dl>
    <ul class="detail-notes">${(s.conflictsWithLegend ?? []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    <p class="muted">Not used for trip suggestions.</p></div>`).join('');
  const stopsVerified = (route.directions ?? []).some((d) => d.verificationStatus === 'verified');
  const terminals = (route.verifiedTerminals ?? []).map((stop) => `<li>${escapeHtml(stop.terminalLabel)}: ${escapeHtml(stop.name)} <small>(${stop.coordinates.map((n) => Number(n).toFixed(6)).join(', ')})</small></li>`).join('');
  return `<article class="card" aria-labelledby="route-detail-title">
  <h3 id="route-detail-title" class="detail-title">${swatch(route)} ${escapeHtml(route.name)}</h3>
  <dl class="detail-grid">
    <dt>Jeepney color</dt><dd>${escapeHtml(route.jeepneyColorName)} <small>(map line color is a display choice, not an official paint spec)</small></dd>
    <dt>Source label</dt><dd>${escapeHtml(route.sourceLabel)}${route.sourceSubLabel ? ` <small>(${escapeHtml(route.sourceSubLabel)})</small>` : ''}</dd>
    ${route.description ? `<dt>Description</dt><dd>${escapeHtml(route.description)}</dd>` : ''}
    <dt>Landmarks on legend</dt><dd>${landmarks || '—'}<br><small>Listed as on the source legend. Exact stops and order are not verified.</small></dd>
    <dt>Verified terminals</dt><dd>${terminals ? `<ul class="detail-notes">${terminals}</ul>` : 'No verified terminal locations recorded'}</dd>
    <dt>Line geometry</dt><dd>${escapeHtml(VERIFICATION_LABELS[route.geometryStatus] ?? route.geometryStatus)}${hasGeometry ? '' : ' — not digitized yet, so no line is drawn'}</dd>
    <dt>Intermediate stops</dt><dd>${stopsVerified ? 'Verified for at least one direction' : 'Not mapped; trip suggestions estimate boarding and drop-off points along the traced path'}</dd>
    <dt>Source</dt><dd>${escapeHtml(route.source)}</dd>
  </dl>
  ${notes ? `<p class="detail-flag"><strong>To verify:</strong></p><ul class="detail-notes">${notes}</ul>` : ''}
  ${secondary}
</article>`;
}
