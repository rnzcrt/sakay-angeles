// Route line layers. Colors and names come from route metadata (joined into
// feature properties), never from literals in this file.
import { boundsOf, geometryPositions } from '../routing/geo.js';
import { maplibregl } from './createMap.js';

const SRC = 'routes';
const LAYERS = ['routes-casing', 'routes-highlight', 'routes-line-verified', 'routes-line-draft'];

// Pale colors need a dark casing to stay visible on a light basemap.
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const casingFor = (hex) => (luminance(hex) > 0.6 ? '#3b4650' : '#ffffff');

export function enrichFeatures(geojson, routes) {
  const byId = new Map(routes.map((r) => [r.id, r]));
  return {
    type: 'FeatureCollection',
    features: (geojson.features ?? []).map((f) => {
      const r = byId.get(f.properties.routeId);
      return {
        ...f,
        properties: {
          ...f.properties,
          displayColor: r.displayColor,
          casingColor: casingFor(r.displayColor),
          routeName: r.name,
          geometryStatus: r.geometryStatus,
        },
      };
    }),
  };
}

export function addRouteLayers(map, geojson, routes) {
  map.addSource(SRC, { type: 'geojson', data: enrichFeatures(geojson, routes) });
  const layout = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'routes-casing', type: 'line', source: SRC, layout, paint: { 'line-color': ['get', 'casingColor'], 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'routes-highlight', type: 'line', source: SRC, layout, filter: ['==', ['get', 'routeId'], ''], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 13, 'line-opacity': 0.35 } });
  map.addLayer({ id: 'routes-line-verified', type: 'line', source: SRC, layout, filter: ['==', ['get', 'geometryStatus'], 'verified'], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 4 } });
  map.addLayer({ id: 'routes-line-draft', type: 'line', source: SRC, layout: { 'line-join': 'round' }, filter: ['!=', ['get', 'geometryStatus'], 'verified'], paint: { 'line-color': ['get', 'displayColor'], 'line-width': 4, 'line-dasharray': [2, 1.5] } });
}

export function applyVisibility(map, visibleIds, selectedId) {
  if (!map.getLayer('routes-casing')) return;
  const vis = ['in', ['get', 'routeId'], ['literal', visibleIds]];
  map.setFilter('routes-casing', vis);
  map.setFilter('routes-line-verified', ['all', vis, ['==', ['get', 'geometryStatus'], 'verified']]);
  map.setFilter('routes-line-draft', ['all', vis, ['!=', ['get', 'geometryStatus'], 'verified']]);
  map.setFilter('routes-highlight', ['all', vis, ['==', ['get', 'routeId'], selectedId ?? '']]);
}

export function onRouteClick(map, handler) {
  map.on('click', 'routes-casing', (e) => {
    const id = e.features?.[0]?.properties?.routeId;
    if (id) handler(id);
  });
  map.on('mouseenter', 'routes-casing', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'routes-casing', () => { map.getCanvas().style.cursor = ''; });
}

export function fitToRoutes(map, geojson, routeIds, padding = 50) {
  const ids = routeIds ? new Set(routeIds) : null;
  const coords = (geojson.features ?? [])
    .filter((f) => !ids || ids.has(f.properties.routeId))
    .flatMap((f) => geometryPositions(f.geometry));
  const b = boundsOf(coords);
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: 16, duration: 400 });
  return Boolean(b);
}

export function makeMarker(map, kind, coordinates, label) {
  const el = document.createElement('div');
  el.className = `marker marker-${kind}`;
  el.textContent = kind === 'origin' ? 'A' : kind === 'destination' ? 'B' : '•';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  return new maplibregl.Marker({ element: el })
    .setLngLat(coordinates)
    .setPopup(new maplibregl.Popup({ offset: 18, closeButton: false }).setText(label))
    .addTo(map);
}

// ---- trip overlay: only the part of each route that is actually ridden ----
const TRIP_SRC = 'trip';
const casingFor2 = casingFor;

export function addTripLayers(map) {
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource(TRIP_SRC, { type: 'geojson', data: empty });
  map.addLayer({ id: 'trip-walk', type: 'line', source: TRIP_SRC, filter: ['==', ['get', 'kind'], 'walk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#3b4650', 'line-width': 3, 'line-dasharray': [0.2, 2] } });
  map.addLayer({ id: 'trip-casing', type: 'line', source: TRIP_SRC, filter: ['==', ['get', 'kind'], 'ride'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'casingColor'], 'line-width': 9, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'trip-ride', type: 'line', source: TRIP_SRC, filter: ['==', ['get', 'kind'], 'ride'], layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'displayColor'], 'line-width': 5, 'line-dasharray': [2, 1.5] } });
}

/** legs: [{segment: coords[], displayColor}], walkLines: [[a,b], ...] — pass nothing to clear. */
export function setTripGeometry(map, legs = [], walkLines = []) {
  const src = map.getSource(TRIP_SRC);
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: [
      ...legs.map((l) => ({ type: 'Feature', properties: { kind: 'ride', displayColor: l.displayColor, casingColor: casingFor2(l.displayColor) }, geometry: { type: 'LineString', coordinates: l.segment } })),
      ...walkLines.map((w) => ({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: w } })),
    ],
  });
}

export function fitToCoordinates(map, coords, padding = 60) {
  const b = boundsOf(coords);
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: 17, duration: 400 });
}
