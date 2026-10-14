import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_CONFIG } from '../config.js';

/**
 * Creates the map. Returns { map } or { error } (e.g. WebGL unavailable).
 * `onProblem(message)` is called when the style/tiles fail to load.
 */
export function createMap(container, onProblem, { offline = false } = {}) {
  try {
    const map = new maplibregl.Map({
      container,
      // `offline` uses a blank style (no network) — handy for testing and tile outages.
      style: offline
        ? { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8ece6' } }] }
        : MAP_CONFIG.styleUrl,
      center: MAP_CONFIG.initialCenter,
      zoom: MAP_CONFIG.initialZoom,
      maxZoom: MAP_CONFIG.maxZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    let warned = false;
    map.on('error', (e) => {
      if (warned) return;
      const status = e?.error?.status;
      // Tile / style fetch problems: tell the user once, keep the app usable.
      if (status || /fetch|network|Failed/i.test(String(e?.error?.message))) {
        warned = true;
        onProblem?.('The base map could not be loaded fully. Route list, search and planning still work; check your connection and reload to retry.');
      }
    });
    return { map };
  } catch (error) {
    return { error };
  }
}

export { maplibregl };
