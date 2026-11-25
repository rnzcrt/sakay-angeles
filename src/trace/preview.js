import { escapeHtml } from '../ui/html.js';

const text = (value) => typeof value === 'string' && value.trim() ? escapeHtml(value.trim()) : 'Not provided';

export function renderRoutePreview({ route, directions, unassignedStops = [] }) {
  if (!route || !Array.isArray(directions)) return '<p class="muted">This route preview is unavailable.</p>';
  const directionRows = directions.map((direction) => {
    const stops = direction.stops.length
      ? `<ol>${direction.stops.map((stop) => `<li>${escapeHtml(stop.name)} <small>${escapeHtml(stop.kind || 'stop')} · ${escapeHtml(stop.geometryPosition ?? 'no map coordinate')}</small></li>`).join('')}</ol>`
      : '<p class="muted">No stops assigned to this direction.</p>';
    const unlistedStops = direction.unlistedStops?.length
      ? `<p class="route-preview-warning">Associated stops missing from the direction order: ${direction.unlistedStops.map((stop) => escapeHtml(stop.name)).join(', ')}</p>`
      : '';
    return `<article class="route-preview-direction"><h4>${text(direction.label)}</h4><dl><dt>From</dt><dd>${text(direction.startPoint)}</dd><dt>To</dt><dd>${text(direction.destination)}</dd><dt>Via</dt><dd>${text(direction.via)}</dd><dt>Status</dt><dd>${direction.active ? 'Active' : 'Inactive'}</dd><dt>Geometry</dt><dd>${direction.geometryPointCount ? `${direction.geometryPointCount} traced points · ${direction.geometryLengthKm.toFixed(2)} km (draft)` : 'No geometry drawn'}</dd></dl><h5>Stops in direction order</h5>${stops}${unlistedStops}</article>`;
  }).join('') || '<p class="muted">No directions have been added.</p>';
  const unassigned = unassignedStops.length
    ? `<div><h4>Stops not assigned to a direction</h4><ul>${unassignedStops.map((stop) => `<li>${escapeHtml(stop.name)} · ${escapeHtml(stop.kind || 'stop')}</li>`).join('')}</ul></div>`
    : '';
  return `<p class="route-preview-draft"><strong>Unsaved draft preview.</strong> Changes are local to this editor until saved.</p><div class="route-preview-heading"><span class="route-swatch" style="background:${escapeHtml(route.displayColor)}" aria-hidden="true"></span><div><h3>${text(route.name)}</h3><p>${text(route.jeepneyColorName)} · ${route.active === false ? 'Inactive' : 'Active'}</p></div></div><dl><dt>Description</dt><dd>${text(route.description)}</dd><dt>Route start</dt><dd>${text(route.startPoint)}</dd><dt>Route destination</dt><dd>${text(route.destination)}</dd><dt>Via</dt><dd>${text(route.via)}</dd></dl><h4>Directions</h4>${directionRows}${unassigned}`;
}
