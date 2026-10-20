import { PEDESTRIAN_FACILITIES_CONFIG } from '../config.js';
import { haversineMeters, isValidLngLat } from '../routing/geo.js';

function facilityKind(tags = {}) {
  if (tags.bridge && !['no', 'false', '0'].includes(tags.bridge)) return 'Pedestrian footbridge';
  if (tags.tunnel && !['no', 'false', '0'].includes(tags.tunnel)) return 'Pedestrian underpass';
  if (tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes') return 'Signal-controlled crossing';
  if (tags['crossing:markings'] || tags.crossing === 'marked') return 'Marked pedestrian crossing';
  return 'Mapped pedestrian crossing';
}

function queryFor([lon, lat], radius) {
  return `[out:json][timeout:8];\n(\n` +
    `node(around:${radius},${lat},${lon})[highway=crossing];\n` +
    `node(around:${radius},${lat},${lon})[crossing];\n` +
    `way(around:${radius},${lat},${lon})[footway=crossing];\n` +
    `way(around:${radius},${lat},${lon})[highway~"^(footway|path|pedestrian|steps)$"][bridge~"^(yes|viaduct)$"];\n` +
    `way(around:${radius},${lat},${lon})[highway~"^(footway|path|pedestrian|steps)$"][tunnel~"^(yes|building_passage)$"];\n` +
    `);out center tags;`;
}

/** Find mapped crossings, footbridges and underpasses near a coordinate. */
export async function findNearbyPedestrianFacilities(point, {
  fetchImpl = globalThis.fetch,
  config = PEDESTRIAN_FACILITIES_CONFIG,
} = {}) {
  if (!isValidLngLat(point) || typeof fetchImpl !== 'function') return [];
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: queryFor(point, config.radiusMeters) }),
      signal: controller?.signal,
    });
    if (!response.ok) return [];
    const data = await response.json();
    const facilities = (data.elements ?? []).flatMap((element) => {
      const tags = element.tags ?? {};
      if (tags.foot === 'no' || tags.access === 'no' || tags.access === 'private') return [];
      const coordinates = Number.isFinite(element.lon) && Number.isFinite(element.lat)
        ? [element.lon, element.lat]
        : Number.isFinite(element.center?.lon) && Number.isFinite(element.center?.lat)
          ? [element.center.lon, element.center.lat]
          : null;
      if (!coordinates) return [];
      const kind = facilityKind(tags);
      return [{
        id: `${element.type}-${element.id}`,
        name: tags.name || kind,
        kind,
        coordinates,
        distanceMeters: Math.round(haversineMeters(point, coordinates)),
        osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      }];
    });
    const unique = [...new Map(facilities.map((facility) => [facility.id, facility])).values()];
    return unique.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 8);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
