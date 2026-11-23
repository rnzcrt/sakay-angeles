import { validateDataset } from './validate.js';

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Loads the public route dataset from the Node server. `baseUrl` must end with "/" (Vite's BASE_URL does).
 * @returns {Promise<{ok:true,data:object,validation:object}|{ok:false,message:string,errors:Array}>}
 */
export async function loadData(baseUrl = './', fetchImpl = fetch) {
  try {
    const data = await getJson(`${baseUrl}api/routes`, fetchImpl);
    const validation = validateDataset(data);
    if (!validation.valid) {
      return { ok: false, message: 'Route data failed validation.', errors: validation.errors };
    }
    return { ok: true, data, validation };
  } catch (e) {
    return { ok: false, message: `Could not load route data (${e.message}).`, errors: [] };
  }
}
