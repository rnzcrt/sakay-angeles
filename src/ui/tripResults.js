// Pure string renderers for trip planner outcomes.
import { PLAN_STATUS } from '../routing/planner.js';
import { DRAFT_TIME } from '../config.js';
import { escapeHtml, formatMeters } from './html.js';
import { estimateItineraryFares } from '../services/fares.js';

const LONG_WALK_M = 800;
const walkNote = (m) => {
  const mins = Math.max(1, Math.round((m / 1000 / DRAFT_TIME.walkKmh) * 60));
  return `Straight-line estimate · about ${mins} min on foot${m > LONG_WALK_M ? ' — a long walk, a tricycle or another ride may be quicker' : ''}`;
};

const dot = (color) => `<span class="leg-dot" style="background:${escapeHtml(color)}" aria-hidden="true"></span>`;
const reportButton = (legs = []) => {
  const routes = [...new Set(legs.map((leg) => leg.routeId).filter(Boolean))];
  const names = [...new Set(legs.map((leg) => `${leg.jeepneyColorName ?? ''} ${leg.routeName ?? ''}`.trim()).filter(Boolean))];
  return `<button type="button" class="btn btn-ghost" data-report-routes="${escapeHtml(routes.join(','))}" data-report-route-names="${escapeHtml(names.join(' + '))}">Report a route issue</button>`;
};

const pesos = (value) => `₱${Number(value).toFixed(2)}`;
const pesoRange = (range) => range?.min === range?.max ? pesos(range.min) : `${pesos(range?.min)}–${pesos(range?.max)}`;
const additionalFare = (range) => range?.min === 0 ? `included in minimum–${pesos(range.max)}` : pesoRange(range);

function fareSummary(legs, passengerType) {
  const fares = estimateItineraryFares(legs, passengerType);
  const lines = fares.rides.map(({ routeName, estimate }) => estimate.status === 'unavailable'
    ? `<li>${escapeHtml(routeName)} · fare not confirmed for this jeepney</li>`
    : `<li>${escapeHtml(routeName)} · ride distance ≈ ${formatMeters(estimate.distanceMeters)}${estimate.distanceRangeMeters ? ` (${formatMeters(estimate.distanceRangeMeters.min)}–${formatMeters(estimate.distanceRangeMeters.max)})` : ''} · ${estimate.status === 'confirmed' ? 'confirmed fare' : 'estimated fare'} <b>${pesoRange(estimate.fareRange ?? { min: estimate.fare, max: estimate.fare })}</b>${estimate.minimumFare !== undefined ? ` (minimum ${pesos(estimate.minimumFare)} + succeeding distance ${additionalFare(estimate.additionalFareRange)})` : ''}${estimate.discountRange?.max ? ` · ${escapeHtml(estimate.passengerLabel)} discount ${pesoRange(estimate.discountRange)}` : ''}</li>`).join('');
  const total = fares.available
    ? `${fares.status === 'confirmed' ? 'Confirmed total fare' : 'Estimated total fare'}: <b>${pesoRange(fares.fareRange)}</b>`
    : fares.partialKnownFareRange
      ? `Fare not confirmed for complete trip · known rides subtotal ${pesoRange(fares.partialKnownFareRange)} (incomplete)`
      : 'Fare not confirmed';
  const sample = fares.rides.find((ride) => ride.estimate.status !== 'unavailable')?.estimate;
  const source = sample?.status === 'confirmed'
    ? 'Fare is confirmed for this route.'
    : sample ? `Approximate route distances use the configured ±10% distance range. Fare guide effective ${escapeHtml(sample.effectiveDate)} · <a href="${escapeHtml(sample.sourceUrl)}" target="_blank" rel="noopener noreferrer">rate reference</a>. Confirm the fare posted inside the jeepney.`
      : 'Fare is not confirmed for this jeepney, so no price is shown.';
  return `<details class="fare-breakdown"><summary>${total} (${escapeHtml(sample?.passengerLabel ?? fares.passengerType)})</summary><ul>${lines}</ul><small>${source}</small></details>`;
}

function renderItinerary(it, index, selectedIndex, passengerType) {
  const steps = [];
  steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.access.walkMeters)}</b> to <b>${escapeHtml(it.access.stop.name)}</b><small>Straight-line estimate</small></div></li>`);
  for (const leg of it.legs) {
    if (leg.type === 'ride') {
      steps.push(`<li class="step">${dot(leg.displayColor)}<div>Board <b>${escapeHtml(leg.routeName)}</b> (${escapeHtml(leg.jeepneyColorName)} jeepney) at <b>${escapeHtml(leg.boardStop.name)}</b>
        <small>${escapeHtml(leg.directionLabel)} · ${leg.stopCount} stop${leg.stopCount === 1 ? '' : 's'} · get off at <b>${escapeHtml(leg.alightStop.name)}</b> · ≈ ${formatMeters(leg.rideMeters)} · ${leg.fareClass ? 'estimated fare shown below' : 'fare not confirmed'}</small></div></li>`);
    } else {
      steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">⇄</span><div>${
        leg.mode === 'same-stop'
          ? `Transfer at <b>${escapeHtml(leg.fromStop.name)}</b>`
          : `Walk about <b>${formatMeters(leg.walkMeters)}</b> from <b>${escapeHtml(leg.fromStop.name)}</b> to <b>${escapeHtml(leg.toStop.name)}</b>`
      }</div></li>`);
    }
  }
  steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.egress.walkMeters)}</b> from <b>${escapeHtml(it.egress.stop.name)}</b> to your destination<small>Straight-line estimate</small></div></li>`);
  const title = it.transfers === 0 ? 'Direct ride' : `${it.transfers} transfer${it.transfers === 1 ? '' : 's'}`;
  return `<section class="card itinerary${index === selectedIndex ? ' is-selected' : ''}">
  <h3>${title}${index === 0 ? ' <span class="badge">Best match</span>' : ''}</h3>
  <p class="summary">Walking ≈ ${formatMeters(it.totalWalkMeters)} · ride ≈ ${formatMeters(it.approxRideMeters)} between stops (straight line)</p>
  ${fareSummary(it.legs, passengerType)}
  <ol class="steps">${steps.join('')}</ol>
  <button type="button" class="btn btn-secondary" data-itinerary="${index}" aria-pressed="${index === selectedIndex}">Show on map</button>
  ${reportButton(it.legs)}
</section>`;
}

export function renderPlanResult(result, selectedIndex = 0, { passengerType = 'regular' } = {}) {
  const d = result.details ?? {};
  switch (result.status) {
    case PLAN_STATUS.SUCCESS:
      return `<h2 class="section-title">Suggested journeys</h2>
<p class="muted">${escapeHtml(result.message)} Walking distances are approximate. Fare totals are shown only when the jeepney type is known.</p>
${result.itineraries.map((it, i) => renderItinerary(it, i, selectedIndex, passengerType)).join('')}`;
    case PLAN_STATUS.NO_VERIFIED_ROUTE:
      return `<section class="card state state-empty" role="status"><h2 class="section-title">We're still adding route details</h2>
<p>Try the community route suggestions when available, or choose a different starting point or destination.</p></section>`;
    case PLAN_STATUS.ORIGIN_TOO_FAR:
    case PLAN_STATUS.DESTINATION_TOO_FAR: {
      const which = result.status === PLAN_STATUS.ORIGIN_TOO_FAR ? 'starting point' : 'destination';
      const near = d.nearestStop ? `<p class="muted">Nearest listed stop: <b>${escapeHtml(d.nearestStop.name)}</b>, about ${formatMeters(d.nearestStop.distanceMeters)} away.</p>` : '';
      return `<section class="card state state-warn" role="status"><h2 class="section-title">Try a closer ${which}</h2><p>${escapeHtml(result.message)}</p>${near}
<p class="muted">You can also move the point closer to a listed jeepney route.</p></section>`;
    }
    case PLAN_STATUS.INVALID_INPUT:
      return `<section class="card state state-warn" role="alert"><h2 class="section-title">Check your trip</h2><p>${escapeHtml(result.message)}</p></section>`;
    default:
      return `<section class="card state state-error" role="alert"><h2 class="section-title">We couldn't find a route</h2><p>${escapeHtml(result.message)}</p></section>`;
  }
}

export function renderGeocodeChoices(which, results) {
  const items = results
    .map(
      (r, i) => `<li><button type="button" class="choice" data-choice="${which}:${i}">${escapeHtml(r.label)}${
        r.inServiceArea ? '' : ' <span class="tag-warn">outside Angeles–Clark area</span>'
      }</button></li>`,
    )
    .join('');
  return `<p class="muted">${results.length > 1 ? 'Several places match. Choose one:' : 'Confirm this place:'}</p><ul class="choices">${items}</ul>`;
}

export function renderDraftResult(result, selectedIndex = 0, { passengerType = 'regular' } = {}) {
  const warn = `<div class="notice" role="note"><b>Community testing:</b> These route suggestions are based on observations and may need correction. Confirm the jeepney direction and fare with the driver. Take care at street crossings.</div>`;
  if (result.status !== 'draft_success') {
    return `${warn}<section class="card state state-empty" role="status"><h2 class="section-title">No jeepney route found</h2><p>${escapeHtml(result.message)}</p></section>`;
  }
  const anyTwoWay = result.itineraries.some((it) => it.legs.some((l) => !l.oneWay));
  const twoWayWarn = anyTwoWay ? '<div class="notice notice-soft" role="note">The return direction may use different streets. Please confirm with the driver.</div>' : '';
  const cards = result.itineraries.map((it, i) => {
    if (it.walkingOnly) {
      const walk = it.walkRoutes?.[0];
      const meters = walk?.distanceMeters ?? it.totalWalkMeters;
      const directions = walk?.steps?.length ? `<small><details class="walk-turns"><summary>Show ${walk.steps.length} walking steps</summary><ol>${walk.steps.map((s) => `<li>${escapeHtml(s.instruction)} · ${formatMeters(s.distanceMeters)}</li>`).join('')}</ol></details></small>` : '<small>Walking distance is approximate; no walkable path was available. Check the route before setting out.</small>';
      const steps = `<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk to your destination, about <b>${formatMeters(meters)}</b>${directions}</div></li>`;
      return `<section class="card itinerary${i === selectedIndex ? ' is-selected' : ''}"><h3>Walk (no fare)${i === 0 ? ' <span class="badge">No jeepney fare</span>' : ''}</h3><p class="summary">${walk ? `≈ ${Math.max(1, Math.round(walk.durationSeconds / 60))} min` : `≈ ${it.estimatedMinutes} min`} on foot · walking ≈ ${formatMeters(meters)}</p><ol class="steps">${steps}</ol><button type="button" class="btn btn-secondary" data-draft-itinerary="${i}" aria-pressed="${i === selectedIndex}">Show on map</button>${reportButton(it.legs)}</section>`;
    }
    const walkingStep = (index, fallbackMeters) => {
      const walk = it.walkRoutes?.[index];
      if (!walk) return `${walkNote(fallbackMeters)} · approximate distance only; check the walking route before setting out.`;
      const duration = walk.durationSeconds ? ` · about ${Math.max(1, Math.round(walk.durationSeconds / 60))} min on foot` : '';
      return walk.steps.length
        ? `Walking directions${duration} · <details class="walk-turns"><summary>Show ${walk.steps.length} steps</summary><ol>${walk.steps.map((s) => `<li>${escapeHtml(s.instruction)} · ${formatMeters(s.distanceMeters)}</li>`).join('')}</ol></details>`
        : `Walking directions${duration}`;
    };
    const walkMeters = (index, fallback) => it.walkRoutes?.[index]?.distanceMeters ?? fallback;
    const steps = [`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(walkMeters(0, it.accessWalkMeters))}</b> to the <b>${escapeHtml(it.legs[0].routeName)}</b> line (the ${escapeHtml(it.legs[0].jeepneyColorName)} jeepney)<small>${walkingStep(0, it.accessWalkMeters)}</small></div></li>`];
    it.legs.forEach((l, k) => {
      const fare = estimateItineraryFares([l], passengerType).rides[0]?.estimate;
      const fareText = !fare || fare.status === 'unavailable'
        ? ' · fare not confirmed for this jeepney'
        : ` · ${fare.status === 'confirmed' ? 'confirmed fare' : 'estimated fare'} ${pesoRange(fare.fareRange ?? { min: fare.fare, max: fare.fare })}${fare.minimumFare !== undefined ? ` (minimum ${pesos(fare.minimumFare)} + succeeding distance ${additionalFare(fare.additionalFareRange)}${fare.discountRange?.max ? ` · ${escapeHtml(fare.passengerLabel)} discount ${pesoRange(fare.discountRange)}` : ''})` : ''}`;
      steps.push(`<li class="step">${dot(l.displayColor)}<div>Ride the <b>${escapeHtml(l.routeName)}</b> (${escapeHtml(l.jeepneyColorName)} jeepney) about <b>${formatMeters(l.rideMeters)}</b> along its line<small>${escapeHtml(l.directionLabel)}${l.oneWay && !l.isLoop ? ' · one-way' : ''} · boarding and drop-off points are approximate${fareText}</small></div></li>`);
      if (k < it.legs.length - 1) steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">⇄</span><div>Transfer between jeepneys (walk about ${formatMeters(walkMeters(k + 1, it.transferWalkMeters))})<small>${walkingStep(k + 1, it.transferWalkMeters)}</small></div></li>`);
    });
    const lastWalk = it.walkLines.length - 1;
    const [destLng, destLat] = result.destination ?? it.walkLines[lastWalk]?.at(-1) ?? [null, null];
    const [walkStartLng, walkStartLat] = it.legs.at(-1)?.alightPoint ?? [null, null];
    const crossingHelp = (result.crossingFacilities ?? []).filter((facility) => facility.distanceMeters <= 1200).slice(0, 3).map((facility) => {
      const [facilityLng, facilityLat] = facility.coordinates;
      const url = `https://www.google.com/maps/dir/?api=1&origin=${walkStartLat},${walkStartLng}&destination=${destLat},${destLng}&waypoints=${facilityLat},${facilityLng}&travelmode=walking`;
      return `<li>${escapeHtml(facility.kind)}${facility.name !== facility.kind ? ` · ${escapeHtml(facility.name)}` : ''}, about ${formatMeters(facility.distanceMeters)} from destination — <a href="${url}" target="_blank" rel="noopener noreferrer">walking directions via this point</a></li>`;
    }).join('');
    const crossingList = crossingHelp
      ? ` Nearby mapped crossings and bridges (check access in person):<ul>${crossingHelp}</ul>`
      : '';
    steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(walkMeters(lastWalk, it.egressWalkMeters))}</b> from the approximate drop-off to your destination<small>${walkingStep(lastWalk, it.egressWalkMeters)} · crossing safety is not confirmed.${crossingList}</small></div></li>`);
    const title = it.transfers === 0 ? 'Direct ride' : `${it.transfers} ${it.transfers === 1 ? 'transfer' : 'transfers'}`;
    const fares = estimateItineraryFares(it.legs, passengerType);
    const fareTotal = fares.available ? `estimated total fare ${pesoRange(fares.fareRange)}` : 'fare not confirmed';
    const walkQualifier = it.walkRoutingComplete === false ? ' (some distances approximate)' : '';
    return `<section class="card itinerary${i === selectedIndex ? ' is-selected' : ''}"><h3>${title}${i === 0 ? ' <span class="badge">Recommended option</span>' : ''}${it.isFastest ? ' <span class="badge badge-fast">Fastest (estimated)</span>' : ''}${it.isLeastWalking ? ' <span class="badge">Least walking</span>' : ''}${it.isLowestFare ? ' <span class="badge">Lowest fare</span>' : ''}</h3>
      <p class="summary"><b>≈ ${it.estimatedMinutes} min</b> estimated · ${it.legs.length} jeepney ride${it.legs.length === 1 ? '' : 's'} · walking ≈ ${formatMeters(it.routedWalkMeters ?? it.totalWalkMeters)}${walkQualifier} · ${fareTotal}</p>
      ${fareSummary(it.legs, passengerType)}
      <ol class="steps">${steps.join('')}</ol>
      <button type="button" class="btn btn-secondary" data-draft-itinerary="${i}" aria-pressed="${i === selectedIndex}">Show on map</button>${reportButton(it.legs)}</section>`;
  }).join('');
  return `<h2 class="section-title">Route suggestions</h2>${warn}${twoWayWarn}${cards}`;
}
