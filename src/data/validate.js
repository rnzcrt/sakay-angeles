// Dataset validation. Returns structured errors instead of throwing so the UI
// can show something useful and the planner can answer with `data_error`.
//
// Dataset shape:
//   routes:   Route[]            (see docs/ROUTE_DATA_GUIDE.md)
//   stops:    Stop[]
//   transfers Transfer[]         (optional)
//   geojson:  FeatureCollection  (optional; when omitted geometry checks are skipped)

import { VERIFICATION_STATUSES } from '../config.js';
import { isValidLngLat } from '../routing/geo.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function err(code, message, path) {
  return { code, message, path };
}

function validateEvidence(evidence, path, errors) {
  const parsedDate = typeof evidence?.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(evidence.checkedAt)
    ? new Date(`${evidence.checkedAt}T00:00:00Z`)
    : null;
  const dateIsValid = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === evidence.checkedAt;
  if (!isObject(evidence) || !isNonEmptyString(evidence.source) || !isNonEmptyString(evidence.method) ||
      !dateIsValid) {
    errors.push(err('missing_verification_evidence', 'Verified data needs evidence with source, method, and checkedAt (YYYY-MM-DD).', path));
  }
}

function validatePositions(positions, path, errors, minLength = 2) {
  if (!Array.isArray(positions) || positions.length < minLength) {
    errors.push(err('malformed_geometry', `Expected at least ${minLength} positions.`, path));
    return;
  }
  positions.forEach((p, i) => {
    if (!isValidLngLat(p)) {
      errors.push(
        err('invalid_coordinates', `Position ${i} is not a valid [longitude, latitude] pair.`, `${path}[${i}]`),
      );
    }
  });
}

export function validateGeoJson(geojson, errors = []) {
  const ids = new Set();
  if (!isObject(geojson) || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    errors.push(err('malformed_geojson', 'GeoJSON must be a FeatureCollection with a features array.', 'geojson'));
    return errors;
  }
  geojson.features.forEach((f, i) => {
    const path = `geojson.features[${i}]`;
    if (!isObject(f) || f.type !== 'Feature' || !isObject(f.geometry)) {
      errors.push(err('malformed_geojson', 'Each feature must be a GeoJSON Feature with a geometry.', path));
      return;
    }
    const { type, coordinates } = f.geometry;
    if (type === 'LineString') validatePositions(coordinates, `${path}.geometry.coordinates`, errors);
    else if (type === 'MultiLineString') {
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        errors.push(err('malformed_geometry', 'MultiLineString needs at least one line.', `${path}.geometry`));
      } else coordinates.forEach((line, j) => validatePositions(line, `${path}.geometry.coordinates[${j}]`, errors));
    } else {
      errors.push(err('malformed_geometry', `Unsupported geometry type "${type}". Use LineString or MultiLineString.`, path));
    }
    const props = f.properties;
    if (!isObject(props) || !isNonEmptyString(props.routeId)) {
      errors.push(err('malformed_geojson', 'Feature needs properties.routeId.', `${path}.properties`));
    }
    const gid = isObject(props) ? props.geometryId : undefined;
    if (gid !== undefined) {
      if (!isNonEmptyString(gid)) errors.push(err('malformed_geojson', 'geometryId must be a non-empty string.', `${path}.properties.geometryId`));
      else if (ids.has(gid)) errors.push(err('duplicate_id', `Duplicate geometryId "${gid}".`, `${path}.properties.geometryId`));
      else ids.add(gid);
    }
  });
  if (geojson.features.length > 5000) errors.push(err('malformed_geojson', 'GeoJSON exceeds the 5,000-feature limit.', 'geojson.features'));
  let positions = 0;
  for (const feature of geojson.features) {
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.geometry?.type === 'LineString' && Array.isArray(coordinates)) positions += coordinates.length;
    if (feature?.geometry?.type === 'MultiLineString' && Array.isArray(coordinates)) positions += coordinates.reduce((sum, line) => sum + (Array.isArray(line) ? line.length : 0), 0);
    if (positions > 100_000) break;
  }
  if (positions > 100_000) errors.push(err('malformed_geojson', 'GeoJSON exceeds the 100,000-position limit.', 'geojson.features'));
  return errors;
}

function optionalText(record, fields, path, errors) {
  for (const [field, max] of Object.entries(fields)) {
    if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field].length > max)) {
      errors.push(err('malformed_record', `${field} must be text no longer than ${max} characters.`, `${path}.${field}`));
    }
  }
}

/**
 * @returns {{valid: boolean, errors: Array<{code,message,path}>}}
 */
export function validateDataset(dataset) {
  const errors = [];
  if (!isObject(dataset)) {
    return { valid: false, errors: [err('malformed_dataset', 'Dataset must be an object.', '')] };
  }
  const { routes, stops, transfers = [], geojson } = dataset;

  if (!Array.isArray(routes)) errors.push(err('malformed_dataset', 'routes must be an array.', 'routes'));
  if (!Array.isArray(stops)) errors.push(err('malformed_dataset', 'stops must be an array.', 'stops'));
  if (!Array.isArray(transfers)) errors.push(err('malformed_dataset', 'transfers must be an array.', 'transfers'));
  if (errors.length) return { valid: false, errors };

  // --- stops ---
  const stopsById = new Map();
  stops.forEach((s, i) => {
    const path = `stops[${i}]`;
    if (!isObject(s) || !isNonEmptyString(s.id)) {
      errors.push(err('malformed_stop', 'Stop needs a non-empty string id.', path));
      return;
    }
    if (stopsById.has(s.id)) errors.push(err('duplicate_id', `Duplicate stop id "${s.id}".`, `${path}.id`));
    stopsById.set(s.id, s);
    if (!isNonEmptyString(s.name)) errors.push(err('malformed_stop', `Stop "${s.id}" needs a name.`, `${path}.name`));
    if (!isValidLngLat(s.coordinates)) {
      errors.push(err('invalid_coordinates', `Stop "${s.id}" has invalid coordinates; expected [longitude, latitude].`, `${path}.coordinates`));
    }
    if (!VERIFICATION_STATUSES.includes(s.verificationStatus)) {
      errors.push(err('invalid_status', `Stop "${s.id}" has invalid verificationStatus.`, `${path}.verificationStatus`));
    }
    if (s.verificationStatus === 'verified' && !isNonEmptyString(s.source)) {
      errors.push(err('missing_verification_evidence', `Verified stop "${s.id}" needs a source.`, `${path}.source`));
    }
  });

  // --- geometry ---
  const geometryIds = new Set();
  const geometryRouteIds = new Map();
  if (geojson !== undefined && geojson !== null) {
    validateGeoJson(geojson, errors);
    if (Array.isArray(geojson.features)) {
      geojson.features.forEach((f) => {
        const p = f?.properties;
        if (isObject(p)) {
          if (isNonEmptyString(p.geometryId)) {
            geometryIds.add(p.geometryId);
            geometryRouteIds.set(p.geometryId, p.routeId);
          }
        }
      });
    }
  }
  const geometryChecked = geojson !== undefined && geojson !== null;

  // --- routes & directions ---
  const routeIds = new Set();
  const directionIds = new Set();
  const directionOwners = new Map();
  routes.forEach((r, i) => {
    const path = `routes[${i}]`;
    if (!isObject(r) || !isNonEmptyString(r.id)) {
      errors.push(err('malformed_route', 'Route needs a non-empty string id.', path));
      return;
    }
    if (routeIds.has(r.id)) errors.push(err('duplicate_id', `Duplicate route id "${r.id}".`, `${path}.id`));
    routeIds.add(r.id);
    for (const field of ['name', 'sourceLabel', 'jeepneyColorName']) {
      if (!isNonEmptyString(r[field])) errors.push(err('malformed_route', `Route "${r.id}" needs ${field}.`, `${path}.${field}`));
    }
    if (!HEX_COLOR.test(r.displayColor ?? '')) {
      errors.push(err('malformed_route', `Route "${r.id}" displayColor must be a #RRGGBB hex string.`, `${path}.displayColor`));
    }
    if (!VERIFICATION_STATUSES.includes(r.geometryStatus)) {
      errors.push(err('invalid_status', `Route "${r.id}" has invalid geometryStatus.`, `${path}.geometryStatus`));
    }
    if (r.active !== undefined && typeof r.active !== 'boolean') {
      errors.push(err('malformed_route', `Route "${r.id}" active must be a boolean when present.`, `${path}.active`));
    }
    optionalText(r, { name: 180, sourceLabel: 180, sourceSubLabel: 180, jeepneyColorName: 80, description: 1200, startPoint: 180, destination: 180, via: 500 }, path, errors);
    if (r.fareClass !== undefined && r.fareClass !== null && !['traditional', 'modern'].includes(r.fareClass)) {
      errors.push(err('invalid_fare_class', `Route "${r.id}" fareClass must be traditional, modern, or null when unknown.`, `${path}.fareClass`));
    }
    if (r.fareClassEvidence !== undefined) {
      validateEvidence(r.fareClassEvidence, `${path}.fareClassEvidence`, errors);
    }
    if (r.geometryStatus === 'verified') {
      validateEvidence(r.geometryEvidence, `${path}.geometryEvidence`, errors);
    }
    if (r.directions !== undefined && !Array.isArray(r.directions)) {
      errors.push(err('malformed_route', `Route "${r.id}" directions must be an array.`, `${path}.directions`));
      return;
    }
    (r.directions ?? []).forEach((d, j) => {
      const dpath = `${path}.directions[${j}]`;
      if (!isObject(d) || !isNonEmptyString(d.id)) {
        errors.push(err('malformed_direction', 'Direction needs a non-empty string id.', dpath));
        return;
      }
      if (directionIds.has(d.id)) errors.push(err('duplicate_id', `Duplicate direction id "${d.id}".`, `${dpath}.id`));
      directionIds.add(d.id);
      directionOwners.set(d.id, r.id);
      optionalText(d, { label: 180, startPoint: 180, destination: 180, via: 500, description: 1200 }, dpath, errors);
      if (!VERIFICATION_STATUSES.includes(d.verificationStatus)) {
        errors.push(err('invalid_status', `Direction "${d.id}" has invalid verificationStatus.`, `${dpath}.verificationStatus`));
      }
      if (d.active !== undefined && typeof d.active !== 'boolean') {
        errors.push(err('malformed_direction', `Direction "${d.id}" active must be a boolean when present.`, `${dpath}.active`));
      }
      if (d.verificationStatus === 'verified') validateEvidence(d.evidence, `${dpath}.evidence`, errors);
      if (!Array.isArray(d.orderedStopIds)) {
        errors.push(err('malformed_direction', `Direction "${d.id}" needs orderedStopIds.`, `${dpath}.orderedStopIds`));
        return;
      }
      const orderedStopSet = new Set();
      d.orderedStopIds.forEach((sid, k) => {
        if (!stopsById.has(sid)) {
          errors.push(err('broken_reference', `Direction "${d.id}" references unknown stop "${sid}".`, `${dpath}.orderedStopIds[${k}]`));
        } else if (stopsById.get(sid).routeId !== undefined && stopsById.get(sid).routeId !== r.id) {
          errors.push(err('broken_reference', `Direction "${d.id}" references a stop belonging to another Jeepney.`, `${dpath}.orderedStopIds[${k}]`));
        }
        if (orderedStopSet.has(sid)) {
          errors.push(err('malformed_direction', `Direction "${d.id}" lists stop "${sid}" more than once.`, `${dpath}.orderedStopIds[${k}]`));
        }
        orderedStopSet.add(sid);
        const stop = stopsById.get(sid);
        if (stop?.directionId && stop.directionId !== d.id) {
          errors.push(err('broken_reference', `Direction "${d.id}" includes stop "${sid}" assigned to another direction.`, `${dpath}.orderedStopIds[${k}]`));
        }
      });
      if (d.geometryId !== undefined && geometryChecked) {
        if (!geometryIds.has(d.geometryId)) {
          errors.push(err('broken_reference', `Direction "${d.id}" references unknown geometryId "${d.geometryId}".`, `${dpath}.geometryId`));
        } else if (geometryRouteIds.get(d.geometryId) !== r.id) {
          errors.push(err('broken_reference', `Geometry "${d.geometryId}" belongs to a different route than direction "${d.id}".`, `${dpath}.geometryId`));
        }
      }
      if (d.verificationStatus === 'verified') {
        if (d.orderedStopIds.length < 2) {
          errors.push(err('incomplete_verified', `Verified direction "${d.id}" needs at least 2 stops.`, `${dpath}.orderedStopIds`));
        }
        for (const sid of d.orderedStopIds) {
          const s = stopsById.get(sid);
          if (s && s.verificationStatus !== 'verified') {
            errors.push(err('incomplete_verified', `Verified direction "${d.id}" uses stop "${sid}" which is not verified.`, `${dpath}.orderedStopIds`));
          }
        }
        if (!isNonEmptyString(d.geometryId)) {
          errors.push(err('incomplete_verified', `Verified direction "${d.id}" needs a geometryId.`, `${dpath}.geometryId`));
        }
        if (r.geometryStatus !== 'verified') {
          errors.push(err('incomplete_verified', `Direction "${d.id}" is verified but route "${r.id}" geometryStatus is not verified.`, `${dpath}.verificationStatus`));
        }
      }
    });
  });

  stops.forEach((stop, i) => {
    if (stop?.directionId === undefined) return;
    const directionPath = `stops[${i}].directionId`;
    if (!isNonEmptyString(stop.directionId) || !directionOwners.has(stop.directionId)) {
      errors.push(err('broken_reference', `Stop "${stop.id}" references an unknown direction.`, directionPath));
    } else if (stop.routeId !== undefined && directionOwners.get(stop.directionId) !== stop.routeId) {
      errors.push(err('broken_reference', `Stop "${stop.id}" references a direction from another Jeepney.`, directionPath));
    } else {
      const direction = routes.flatMap((route) => Array.isArray(route?.directions) ? route.directions : []).find((item) => item?.id === stop.directionId);
      if (!Array.isArray(direction?.orderedStopIds) || !direction.orderedStopIds.includes(stop.id)) {
        errors.push(err('broken_reference', `Stop "${stop.id}" is not listed in its assigned direction's ordered stops.`, directionPath));
      }
    }
  });

  // geometry features must point at known routes
  if (geometryChecked && Array.isArray(geojson.features)) {
    geojson.features.forEach((f, i) => {
      const rid = f?.properties?.routeId;
      if (isNonEmptyString(rid) && !routeIds.has(rid)) {
        errors.push(err('broken_reference', `Geometry references unknown route "${rid}".`, `geojson.features[${i}].properties.routeId`));
        return;
      }
      const props = f?.properties;
      if (!isObject(props)) return;
      const route = routes.find((item) => item?.id === rid);
      const directions = route?.directions ?? [];
      if (!directions.length) {
        if (props.directionId === undefined) return; // legacy geometry without explicit direction metadata
        const legacyDirection = ['a', 'b'].includes(props.direction) && props.directionId === `${rid}-${props.direction}`;
        if (!legacyDirection) {
          errors.push(err('broken_reference', `Legacy geometry references unknown direction "${props.directionId}".`, `geojson.features[${i}].properties.directionId`));
        }
        return;
      }
      const idMatch = props.directionId === undefined
        ? undefined
        : directions.find((direction) => direction.id === props.directionId);
      const geometryMatch = props.geometryId === undefined
        ? undefined
        : directions.find((direction) => direction.geometryId === props.geometryId);
      const legacyDirection = ['a', 'b'].includes(props.direction) && props.directionId === `${rid}-${props.direction}`;
      const legacyWithoutRefs = props.directionId === undefined && props.geometryId === undefined;
      const allowLegacy = !idMatch && !geometryMatch && (legacyDirection || legacyWithoutRefs);
      const invalidDirectionId = props.directionId !== undefined && !idMatch && !legacyDirection;
      const conflictingReferences = idMatch && geometryMatch && idMatch.id !== geometryMatch.id;
      const mismatchedStoredGeometry = idMatch?.geometryId && props.geometryId !== idMatch.geometryId;
      const unresolvedGeometry = !idMatch && !geometryMatch && !allowLegacy;
      if (invalidDirectionId || conflictingReferences || mismatchedStoredGeometry || unresolvedGeometry) {
        errors.push(err(
          'broken_reference',
          `Geometry references a missing or conflicting direction/geometry association for route "${rid}".`,
          `geojson.features[${i}].properties.directionId`,
        ));
      }
    });
  }

  // --- transfers ---
  const transferIds = new Set();
  transfers.forEach((t, i) => {
    const path = `transfers[${i}]`;
    if (!isObject(t) || !isNonEmptyString(t.id)) {
      errors.push(err('malformed_transfer', 'Transfer needs a non-empty string id.', path));
      return;
    }
    if (transferIds.has(t.id)) errors.push(err('duplicate_id', `Duplicate transfer id "${t.id}".`, `${path}.id`));
    transferIds.add(t.id);
    for (const key of ['fromStopId', 'toStopId']) {
      if (!stopsById.has(t[key])) errors.push(err('broken_reference', `Transfer "${t.id}" references unknown stop "${t[key]}".`, `${path}.${key}`));
    }
    if (typeof t.walkMeters !== 'number' || !Number.isFinite(t.walkMeters) || t.walkMeters <= 0) {
      errors.push(err('malformed_transfer', `Transfer "${t.id}" needs a positive walkMeters.`, `${path}.walkMeters`));
    }
    if (!VERIFICATION_STATUSES.includes(t.verificationStatus)) {
      errors.push(err('invalid_status', `Transfer "${t.id}" has invalid verificationStatus.`, `${path}.verificationStatus`));
    }
  });

  return { valid: errors.length === 0, errors };
}
