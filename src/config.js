// Central configuration. Nothing in here is route data.

export const MAP_CONFIG = {
  // OpenFreeMap public style. The public service is provided as-is and may
  // change or be discontinued; see README before any high-traffic launch.
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  // Attribution is added automatically by MapLibre from the style. This text
  // is repeated in the page footer so it stays visible even if tiles fail.
  attributionText: 'Map: OpenFreeMap © OpenMapTiles · Data from OpenStreetMap',
  // Initial view only (Angeles City / Clark area). Not route geometry.
  initialCenter: [120.58, 15.15],
  initialZoom: 12,
  maxZoom: 18,
};

// Approximate service area [west, south, east, north]. Used only to warn the
// user when a search result lies outside the Angeles–Clark area.
export const SERVICE_AREA_BBOX = [120.47, 15.07, 120.68, 15.25];

export const PLANNER_DEFAULTS = {
  // Maximum straight-line walk from the user's point to a boarding/alighting stop.
  maxWalkMeters: 500,
  // Upper bound; the planner also stops when every distinct route has been used.
  // This allows long useful chains instead of assuming two transfers is enough.
  maxTransfers: 10,
  // Nearest candidate stops considered at each end.
  maxStopCandidates: 5,
  // Alternatives shown to the user.
  maxAlternatives: 3,
};

export const GEOCODING_CONFIG = {
  provider: 'nominatim',
  baseUrl: 'https://nominatim.openstreetmap.org/search',
  attribution: 'Search: © OpenStreetMap contributors via Nominatim',
  countryCodes: 'ph',
  limit: 5,
  // Nominatim's public usage policy allows at most one request per second.
  minIntervalMs: 1100,
  timeoutMs: 8000,
};

export const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
};

export const SOURCE_ATTRIBUTION = {
  text: 'Route names and colors transcribed from the “HERE Angeles + Clark — Angeles City Jeepneys” maps (© 2021 Ray Haffenden / WayGo Maps).',
  permissionNote: 'Permission to reuse these source maps has not been confirmed. Confirm it before any public release.',
};

export const VERIFICATION_STATUSES = ['unverified', 'partially-verified', 'verified'];

export const VERIFICATION_LABELS = {
  unverified: 'Unverified',
  'partially-verified': 'Partially verified',
  verified: 'Verified',
};

// Rough assumptions for the draft planner's "estimated time". These are NOT
// schedules or measurements; they only let "fastest" be ranked sensibly.
export const DRAFT_TIME = {
  walkKmh: 4.5,
  jeepneyKmh: 12, // average city speed including stops and traffic
  waitPerBoardingMin: 4,
};

// Optional "snap to roads" for the route tracer. The public OSRM demo server is
// for light, occasional use only — self-host or switch provider for heavy use.
// It routes for cars and honours one-way streets from OpenStreetMap.
export const ROUTING_CONFIG = {
  baseUrl: 'https://router.project-osrm.org/route/v1',
  profile: 'driving',
  timeoutMs: 8000,
  minIntervalMs: 350,
  attribution: 'Road snapping: OSRM demo server, data © OpenStreetMap contributors',
};

// Public OSRM pedestrian router for itinerary walking legs. It is a light-use
// demo service, so production deployments should self-host or use a contracted provider.
export const WALKING_ROUTING_CONFIG = {
  baseUrl: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  timeoutMs: 10000,
  attribution: 'Walking routes: OSRM · © OpenStreetMap contributors',
};

// Nearby crossings and grade-separated pedestrian routes from OpenStreetMap.
export const PEDESTRIAN_FACILITIES_CONFIG = {
  endpoint: 'https://overpass-api.de/api/interpreter',
  radiusMeters: 1200,
  timeoutMs: 8000,
  attribution: 'Pedestrian facilities: © OpenStreetMap contributors',
};
