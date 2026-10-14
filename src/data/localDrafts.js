// Bridge between the route tracer and the main app.
//
// The tracer autosaves lines in this browser's localStorage. Without this
// bridge, the main app only sees the exported file in public/data, so freshly
// traced lines would look "ignored" until the file is replaced. Routes that
// have lines saved by the tracer replace the shipped lines for those routes.

import { linesToGeoJson } from '../trace/geojson.js';
import { validateDataset } from './validate.js';

export const LOCAL_KEY = 'sakay-angeles-trace-drafts-v2';
export const IGNORE_KEY = 'sakay-angeles-ignore-local-drafts';
// Set by the tracer's "Start over": only lines traced since then are shown; the old shipped lines are hidden.
export const REPLACE_KEY = 'sakay-angeles-replace-shipped-lines';

export function readLocalLines(storage) {
  try {
    const raw = storage?.getItem(LOCAL_KEY);
    return raw ? new Map(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** @returns {{data:object, used:string[], hasLocal:boolean, ignored:boolean, error?:string}} */
export function mergeLocalDrafts(data, storage) {
  const none = { data, used: [], hasLocal: false, ignored: false, replaced: false };
  let replace = false;
  try { replace = storage?.getItem(REPLACE_KEY) === '1'; } catch { /* ignore */ }
  const lines = readLocalLines(storage) ?? (replace ? new Map() : null);
  if (!lines) return none;
  const localGeo = linesToGeoJson(lines, data.routes);
  if (!localGeo.features.length && !replace) return none;
  const hasLocal = true;
  let ignored = false;
  try { ignored = storage.getItem(IGNORE_KEY) === '1'; } catch { /* ignore */ }
  if (ignored) return { data, used: [], hasLocal, ignored, replaced: false };

  const localRoutes = new Set(localGeo.features.map((f) => f.properties.routeId));
  const kept = replace ? [] : (data.geojson?.features ?? []).filter((f) => !localRoutes.has(f.properties?.routeId));
  const geojson = { ...data.geojson, features: [...kept, ...localGeo.features] };
  const check = validateDataset({ routes: data.routes, stops: data.stops, transfers: data.transfers, geojson });
  if (!check.valid) return { data, used: [], hasLocal, ignored, replaced: false, error: check.errors[0].message };
  return { data: { ...data, geojson }, used: data.routes.filter((r) => localRoutes.has(r.id)).map((r) => r.name), hasLocal, ignored, replaced: replace };
}

export function setIgnoreLocal(storage, ignore) {
  try {
    if (ignore) storage.setItem(IGNORE_KEY, '1'); else storage.removeItem(IGNORE_KEY);
  } catch { /* ignore */ }
}

export function setReplaceShipped(storage, on) {
  try {
    if (on) storage.setItem(REPLACE_KEY, '1'); else storage.removeItem(REPLACE_KEY);
  } catch { /* ignore */ }
}
