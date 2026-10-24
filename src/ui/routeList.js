// Pure string renderers (testable in Node) for the route list and route detail.
// All names/colors come from route metadata passed in; nothing is hard-coded here.

import { escapeHtml } from './html.js';

export function routeHasGeometry(route, geojson) {
  return (geojson?.features ?? []).some((f) => f.properties?.routeId === route.id);
}

const swatch = (route) =>
  `<span class="route-swatch" style="background:${escapeHtml(route.displayColor)}" aria-hidden="true"></span>`;

export function renderRouteItem(route, { selected = false, visible = true, hasGeometry = false } = {}) {
  const status = hasGeometry ? 'Community testing · based on observation' : 'Needs a route line';
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
  const landmarks = (route.sourceLandmarks ?? []).map(escapeHtml).join(' · ');
  const routeIds = escapeHtml(route.id);
  const routeNames = escapeHtml(`${route.jeepneyColorName} · ${route.name}`);
  const terminals = (route.verifiedTerminals ?? []).map((stop) => `<li>${escapeHtml(stop.terminalLabel)}: ${escapeHtml(stop.name)} <small>(based on observation)</small></li>`).join('');
  return `<article class="card" aria-labelledby="route-detail-title">
  <h3 id="route-detail-title" class="detail-title">${swatch(route)} ${escapeHtml(route.name)}</h3>
  <dl class="detail-grid">
    <dt>Jeepney color</dt><dd>${escapeHtml(route.jeepneyColorName)}</dd>
    <dt>Places on the map</dt><dd>${landmarks || 'Route details are still being added'} <small>These places do not confirm every stop or direction.</small></dd>
    <dt>Terminals</dt><dd>${terminals ? `<ul class="detail-notes">${terminals}</ul>` : 'Still being checked'}</dd>
    <dt>Route details</dt><dd>${hasGeometry ? 'Based on observation · needs community confirmation' : 'Needs confirmation'}</dd>
    <dt>Fare</dt><dd>${route.fareClass ? 'Estimated fare; see trip details' : 'Fare not confirmed'}</dd>
  </dl>
  <button type="button" class="btn btn-secondary" data-report-routes="${routeIds}" data-report-route-names="${routeNames}">Report a route issue</button>
</article>`;
}
