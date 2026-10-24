import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_CONFIG } from '../config.js';

maplibregl.setWorkerUrl(workerUrl);
/**
 * Creates the map. Returns { map } or { error } (e.g. WebGL unavailable).
 * `onProblem(message)` is called when the style/tiles fail to load.
 */
export function createMap(container, onProblem, { offline = false } = {}) {
  let map;
  const panelToggle = document.getElementById('mobile-panel-toggle');
  const layout = panelToggle?.closest('.layout');
  if (panelToggle && layout) {
    const setPanelCollapsed = (collapsed) => {
      layout.classList.toggle('panel-collapsed', collapsed);
      panelToggle.setAttribute('aria-expanded', String(!collapsed));
      panelToggle.textContent = collapsed
        ? (document.body.classList.contains('tracer-page') ? 'Show tracing tools' : 'Plan a trip')
        : (document.body.classList.contains('tracer-page') ? 'Hide tracing tools' : 'Hide trip panel');
      requestAnimationFrame(() => map?.resize());
    };
    panelToggle.addEventListener('click', () => {
      setPanelCollapsed(!layout.classList.contains('panel-collapsed'));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !layout.classList.contains('panel-collapsed') && matchMedia('(max-width: 850px)').matches) {
        setPanelCollapsed(true);
        panelToggle.focus();
      }
    });
  }
  try {
    map = new maplibregl.Map({
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
    // Keep MapLibre's canvas aligned when responsive panels resize the map.
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) map.resize();
      });
      resizeObserver.observe(container);
      map.once('remove', () => resizeObserver.disconnect());
    } else {
      const resize = () => map.resize();
      window.addEventListener('resize', resize, { passive: true });
      map.once('remove', () => window.removeEventListener('resize', resize));
    }
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
