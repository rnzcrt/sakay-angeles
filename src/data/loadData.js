import { validateDataset } from './validate.js';

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Loads static data files. `baseUrl` must end with "/" (Vite's BASE_URL does).
 * @returns {Promise<{ok:true,data:object,validation:object}|{ok:false,message:string,errors:Array}>}
 */
export async function loadData(baseUrl = './', fetchImpl = fetch) {
  try {
    const [routesFile, stopsFile, geojson] = await Promise.all([
      getJson(`${baseUrl}data/routes.json`, fetchImpl),
      getJson(`${baseUrl}data/stops.json`, fetchImpl),
      getJson(`${baseUrl}data/routes.geojson`, fetchImpl),
    ]);
    const data = {
      meta: { source: routesFile.source, dataStatus: routesFile.dataStatus },
      routes: routesFile.routes,
      stops: stopsFile.stops,
      transfers: stopsFile.transfers ?? [],
      geojson,
    };
    const validation = validateDataset(data);
    if (!validation.valid) {
      return { ok: false, message: 'Route data failed validation.', errors: validation.errors };
    }
    return { ok: true, data, validation };
  } catch (e) {
    return { ok: false, message: `Could not load route data (${e.message}).`, errors: [] };
  }
}
