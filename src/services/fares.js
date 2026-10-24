import { JEEPNEY_FARE_RULES } from '../config.js';

const roundToIncrement = (amount, increment) => Number((Math.round((amount + Number.EPSILON) / increment) * increment).toFixed(2));

export const FARE_STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  ESTIMATED: 'estimated',
  RANGE_ESTIMATE: 'range_estimate',
  UNAVAILABLE: 'unavailable',
});

function fareAtDistance(distanceMeters, matrix, rules) {
  const succeedingKm = Math.max(0, distanceMeters / 1000 - matrix.minimumKm);
  const units = rules.succeedingKmRounding === 'ceil' ? Math.ceil(succeedingKm - Number.EPSILON) : succeedingKm;
  const additionalFare = roundToIncrement(units * matrix.succeedingFarePerKm, rules.fareIncrementPesos);
  return { fare: roundToIncrement(matrix.minimumFare + additionalFare, rules.fareIncrementPesos), units, additionalFare };
}

/** Return an explicit estimate/range or an unavailable result, never a fake zero. */
export function estimateJeepneyFare({ distanceMeters, distanceUncertaintyMeters, fareClass, passengerType = 'regular', confirmedFarePesos, fareVerificationStatus, rules = JEEPNEY_FARE_RULES }) {
  const vehicle = rules.vehicleClasses?.[fareClass];
  if (!vehicle || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return { status: 'unavailable', fare: null, lowerFare: null, upperFare: null, reason: !vehicle ? 'vehicle_class_unknown' : 'invalid_distance' };
  }
  if (!rules.categories?.[passengerType]) return { status: 'unavailable', fare: null, lowerFare: null, upperFare: null, reason: 'passenger_type_unknown' };
  if (fareVerificationStatus === 'verified' && Number.isFinite(confirmedFarePesos) && confirmedFarePesos > 0) {
    return { status: FARE_STATUS.CONFIRMED, fare: roundToIncrement(confirmedFarePesos, rules.fareIncrementPesos), lowerFare: roundToIncrement(confirmedFarePesos, rules.fareIncrementPesos), upperFare: roundToIncrement(confirmedFarePesos, rules.fareIncrementPesos), fareRange: null, fareClass, passengerType, passengerLabel: rules.categories[passengerType].label, distanceMeters: Math.round(distanceMeters), estimated: false };
  }

  const uncertainty = Number.isFinite(distanceUncertaintyMeters)
    ? Math.max(0, distanceUncertaintyMeters)
    : distanceMeters * (rules.approximateDistanceUncertaintyRatio ?? 0);
  const matrix = passengerType === 'regular' ? vehicle.regular : vehicle.discounted;
  const lowDistance = Math.max(1, distanceMeters - uncertainty);
  const highDistance = distanceMeters + uncertainty;
  const low = fareAtDistance(lowDistance, matrix, rules);
  const high = fareAtDistance(highDistance, matrix, rules);
  const fareRange = low.fare === high.fare ? null : { min: low.fare, max: high.fare };
  let discountRange = { min: 0, max: 0 };
  if (passengerType !== 'regular') {
    const regularLow = fareAtDistance(lowDistance, vehicle.regular, rules);
    const regularHigh = fareAtDistance(highDistance, vehicle.regular, rules);
    discountRange = {
      min: roundToIncrement(regularLow.fare - low.fare, rules.fareIncrementPesos),
      max: roundToIncrement(regularHigh.fare - high.fare, rules.fareIncrementPesos),
    };
  }
  return {
    status: uncertainty > 0 ? FARE_STATUS.RANGE_ESTIMATE : FARE_STATUS.ESTIMATED,
    fare: fareRange ? null : low.fare,
    lowerFare: low.fare,
    upperFare: high.fare,
    fareRange,
    fareClass,
    vehicleLabel: vehicle.label,
    passengerType,
    passengerLabel: rules.categories[passengerType].label,
    distanceMeters: Math.round(distanceMeters),
    distanceRangeMeters: { min: Math.round(lowDistance), max: Math.round(highDistance) },
    minimumFare: matrix.minimumFare,
    additionalFareRange: { min: low.additionalFare, max: high.additionalFare },
    succeedingKilometersRange: { min: low.units, max: high.units },
    discountRange,
    estimated: true,
    effectiveDate: rules.effectiveDate,
    sourceUrl: rules.sourceUrl,
  };
}

/** Price rides separately. A single unknown ride makes the complete total unavailable. */
export function estimateItineraryFares(legs = [], passengerType = 'regular', rules = JEEPNEY_FARE_RULES) {
  // Verified-plan and draft-plan legs have different shapes: draft ride legs
  // carry rideMeters but do not have a `type` field. Recognize both so drafts
  // receive fare estimates too, while walk/transfer legs remain free.
  const rides = (legs ?? []).filter((leg) => leg.type === 'ride' || Number.isFinite(leg.rideMeters)).map((leg) => ({
    routeId: leg.routeId,
    routeName: leg.routeName,
    estimate: estimateJeepneyFare({ distanceMeters: leg.rideMeters, distanceUncertaintyMeters: leg.fareDistanceUncertaintyMeters, fareClass: leg.fareClass, passengerType, rules }),
  }));
  if (!rides.length) return { status: 'unavailable', available: false, totalFare: null, fareRange: null, rides, passengerType, reason: 'no_jeepney_rides' };
  const known = rides.filter(({ estimate }) => estimate.status !== 'unavailable');
  const allKnown = known.length === rides.length;
  const partial = known.length ? {
    min: roundToIncrement(known.reduce((sum, ride) => sum + ride.estimate.lowerFare, 0), rules.fareIncrementPesos),
    max: roundToIncrement(known.reduce((sum, ride) => sum + ride.estimate.upperFare, 0), rules.fareIncrementPesos),
  } : null;
  const fareRange = allKnown ? partial : null;
  const exact = fareRange && fareRange.min === fareRange.max;
  const confirmed = allKnown && rides.every(({ estimate }) => estimate.status === FARE_STATUS.CONFIRMED);
  return {
    status: !allKnown ? FARE_STATUS.UNAVAILABLE : confirmed ? FARE_STATUS.CONFIRMED : exact ? FARE_STATUS.ESTIMATED : FARE_STATUS.RANGE_ESTIMATE,
    available: allKnown,
    totalFare: exact ? fareRange.min : null,
    fareRange,
    partialKnownFareRange: allKnown ? null : partial,
    rides,
    passengerType,
    reason: allKnown ? null : 'one_or_more_ride_fares_unknown',
    estimated: allKnown && !confirmed,
  };
}
