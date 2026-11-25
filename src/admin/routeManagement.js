export function createRouteDraft(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('A stable route id is required.');
  return {
    id,
    name: '',
    sourceLabel: '',
    jeepneyColorName: '',
    displayColor: '#808080',
    geometryStatus: 'unverified',
    tracingStatus: 'ready-for-tracing',
    description: '',
    directions: [],
    active: true,
  };
}

export function removeRouteData(dataset, routeId) {
  const route = dataset.routes.find((item) => item.id === routeId);
  if (!route) return { ok: false, reason: 'not-found' };
  const stops = dataset.stops.filter((stop) => stop.routeId === routeId);
  const stopIds = new Set(stops.map((stop) => stop.id));
  const transfers = dataset.transfers.filter((transfer) => stopIds.has(transfer.fromStopId) || stopIds.has(transfer.toStopId));
  const features = dataset.geojson.features.filter((feature) => feature.properties?.routeId === routeId);
  const next = structuredClone(dataset);
  next.routes = next.routes.filter((item) => item.id !== routeId);
  next.stops = next.stops.filter((stop) => stop.routeId !== routeId);
  next.geojson.features = next.geojson.features.filter((feature) => feature.properties?.routeId !== routeId);
  next.transfers = next.transfers.filter((transfer) => !stopIds.has(transfer.fromStopId) && !stopIds.has(transfer.toStopId));
  if (next.routesFile) next.routesFile.routes = next.routes;
  return { ok: true, data: next, impact: { directions: route.directions?.length ?? 0, stops: stops.length, features: features.length, transfers: transfers.length } };
}
