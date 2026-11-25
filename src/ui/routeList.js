// Pure string renderers (testable in Node) for the route list and route detail.
// All names/colors come from route metadata passed in; nothing is hard-coded here.

import { escapeHtml } from './html.js';

export const ROUTE_LIST_PREFERENCE_KEY = 'sakay-angeles-public-route-list-preference-v1';

export function routeHasGeometry(route, geojson) {
  return (geojson?.features ?? []).some((f) => f.properties?.routeId === route.id);
}

function setRouteListExpanded(list, button, expanded) {
  if (list.classList) {
    list.hidden = false;
    list.classList.toggle('is-collapsed', !expanded);
    list.inert = !expanded;
  } else {
    list.hidden = !expanded;
  }
  button.textContent = expanded ? 'Collapse routes' : 'Expand routes';
  button.setAttribute('aria-expanded', String(expanded));
}

export function initializeRouteList(list, button, storage) {
  let preference = 'expanded';
  try {
    const saved = storage?.getItem(ROUTE_LIST_PREFERENCE_KEY);
    if (saved === 'collapsed' || saved === 'expanded') preference = saved;
  } catch { /* the route list remains usable when browser storage is blocked */ }
  const expanded = preference === 'expanded';
  setRouteListExpanded(list, button, expanded);
  return expanded;
}

export function toggleRouteList(list, button, storage) {
  const expanded = button.getAttribute('aria-expanded') === 'true';
  const nextExpanded = !expanded;
  setRouteListExpanded(list, button, nextExpanded);
  try { storage?.setItem(ROUTE_LIST_PREFERENCE_KEY, nextExpanded ? 'expanded' : 'collapsed'); }
  catch { /* the current-page toggle works even when browser storage is blocked */ }
  return nextExpanded;
}

const swatch = (route) =>
  `<span class="route-swatch" style="background:${escapeHtml(route.displayColor)}" aria-hidden="true"></span>`;

export function renderRouteItem(route, { selected = false, visible = true, hasGeometry = false } = {}) {
  const status = hasGeometry ? 'Community testing · based on observation'
    : route.tracingStatus === 'ready-for-tracing' ? 'Ready for tracing' : 'Needs a route line';
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

export function renderRouteDetail(route, { hasGeometry = false, stops = [] } = {}) {
  const landmarks = (route.sourceLandmarks ?? []).map(escapeHtml).join(' · ');
  const directions = (route.directions ?? []).filter((direction) => direction.active !== false).map((direction) => {
    const endpoints = [direction.startPoint, direction.destination].filter(Boolean).map(escapeHtml).join(' → ');
    const via = direction.via ? ` · via ${escapeHtml(direction.via)}` : '';
    const description = direction.description ? `<small>${escapeHtml(direction.description)}</small>` : '';
    const directionStops = (direction.orderedStopIds ?? []).map((id) => stops.find((stop) => stop.id === id && (!stop.directionId || stop.directionId === direction.id))).filter(Boolean);
    const stopList = directionStops.length ? `<ol>${directionStops.map((stop) => `<li>${escapeHtml(stop.name)} <small>(${escapeHtml(stop.verificationStatus || 'unverified')})</small></li>`).join('')}</ol>` : '';
    return `<li><strong>${escapeHtml(direction.label || direction.id)}</strong>${endpoints ? ` · ${endpoints}` : ''}${via}${description}${stopList}</li>`;
  }).join('');
  const routeIds = escapeHtml(route.id);
  const routeNames = escapeHtml(`${route.jeepneyColorName} · ${route.name}`);
  const terminals = (route.verifiedTerminals ?? []).map((stop) => `<li>${escapeHtml(stop.terminalLabel)}: ${escapeHtml(stop.name)} <small>(based on observation)</small></li>`).join('');
  const vehicle = route.vehicleType ? `<dt>Vehicle</dt><dd>${escapeHtml(route.vehicleType)}</dd>` : '';
  const direction = route.requestedDirection ? `<dt>Requested direction</dt><dd>${escapeHtml(route.requestedDirection)}</dd>` : '';
  return `<article class="card" aria-labelledby="route-detail-title">
  <h3 id="route-detail-title" class="detail-title">${swatch(route)} ${escapeHtml(route.name)}</h3>
  <dl class="detail-grid">
    <dt>Jeepney color</dt><dd>${escapeHtml(route.jeepneyColorName)}</dd>
    ${vehicle}
    ${direction}
    <dt>Places on the map</dt><dd>${landmarks || 'Route details are still being added'} <small>These places do not confirm every stop or direction.</small></dd>
    ${directions ? `<dt>Directions and recorded stops</dt><dd><ul class="detail-notes">${directions}</ul></dd>` : ''}
    <dt>Terminals</dt><dd>${terminals ? `<ul class="detail-notes">${terminals}</ul>` : 'Still being checked'}</dd>
    <dt>Route details</dt><dd>${hasGeometry ? 'Based on observation · needs community confirmation' : 'Needs confirmation'}</dd>
    <dt>Fare</dt><dd>${route.fareClass ? 'Estimated fare; see trip details' : 'Fare not confirmed'}</dd>
  </dl>
  <button type="button" class="btn btn-secondary" data-report-routes="${routeIds}" data-report-route-names="${routeNames}">Report a route issue</button>
</article>`;
}
