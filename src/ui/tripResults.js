// Pure string renderers for trip planner outcomes.
import { PLAN_STATUS } from '../routing/planner.js';
import { DRAFT_TIME } from '../config.js';
import { escapeHtml, formatMeters } from './html.js';

const LONG_WALK_M = 800;
const walkNote = (m) => {
  const mins = Math.max(1, Math.round((m / 1000 / DRAFT_TIME.walkKmh) * 60));
  return `Straight-line estimate · about ${mins} min on foot${m > LONG_WALK_M ? ' — a long walk, a tricycle or another ride may be quicker' : ''}`;
};

const dot = (color) => `<span class="leg-dot" style="background:${escapeHtml(color)}" aria-hidden="true"></span>`;

function renderItinerary(it, index, selectedIndex) {
  const steps = [];
  steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.access.walkMeters)}</b> to <b>${escapeHtml(it.access.stop.name)}</b><small>Straight-line estimate</small></div></li>`);
  for (const leg of it.legs) {
    if (leg.type === 'ride') {
      steps.push(`<li class="step">${dot(leg.displayColor)}<div>Board <b>${escapeHtml(leg.routeName)}</b> (${escapeHtml(leg.jeepneyColorName)} jeepney) at <b>${escapeHtml(leg.boardStop.name)}</b>
        <small>${escapeHtml(leg.directionLabel)} · ${leg.stopCount} stop${leg.stopCount === 1 ? '' : 's'} · get off at <b>${escapeHtml(leg.alightStop.name)}</b></small></div></li>`);
    } else {
      steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">⇄</span><div>${
        leg.mode === 'same-stop'
          ? `Transfer at <b>${escapeHtml(leg.fromStop.name)}</b> (same verified stop)`
          : `Walk about <b>${formatMeters(leg.walkMeters)}</b> from <b>${escapeHtml(leg.fromStop.name)}</b> to <b>${escapeHtml(leg.toStop.name)}</b> (verified transfer)`
      }</div></li>`);
    }
  }
  steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.egress.walkMeters)}</b> from <b>${escapeHtml(it.egress.stop.name)}</b> to your destination<small>Straight-line estimate</small></div></li>`);
  const title = it.transfers === 0 ? 'Direct ride' : `${it.transfers} transfer${it.transfers === 1 ? '' : 's'}`;
  return `<section class="card itinerary${index === selectedIndex ? ' is-selected' : ''}">
  <h3>${title}${index === 0 ? ' <span class="badge">Best match</span>' : ''}</h3>
  <p class="summary">Walking ≈ ${formatMeters(it.totalWalkMeters)} · ride ≈ ${formatMeters(it.approxRideMeters)} between stops (straight line)</p>
  <ol class="steps">${steps.join('')}</ol>
  <button type="button" class="btn btn-secondary" data-itinerary="${index}" aria-pressed="${index === selectedIndex}">Show on map</button>
</section>`;
}

export function renderPlanResult(result, selectedIndex = 0) {
  const d = result.details ?? {};
  switch (result.status) {
    case PLAN_STATUS.SUCCESS:
      return `<h2 class="section-title">Suggested journeys</h2>
<p class="muted">${escapeHtml(result.message)} Distances are straight-line estimates. No live locations, arrival times or fares.</p>
${result.itineraries.map((it, i) => renderItinerary(it, i, selectedIndex)).join('')}`;
    case PLAN_STATUS.NO_VERIFIED_ROUTE:
      return `<section class="card state state-empty" role="status"><h2 class="section-title">No verified route yet</h2>
<p>${escapeHtml(result.message)}</p>
${d.verifiedDirectionCount === 0 ? `<p class="muted">Route lines, ordered stops and transfers still have to be digitized and verified (${d.excludedDirectionCount ?? 0} route direction records are excluded). You can still browse the route list and the reference maps below.</p>` : ''}</section>`;
    case PLAN_STATUS.ORIGIN_TOO_FAR:
    case PLAN_STATUS.DESTINATION_TOO_FAR: {
      const which = result.status === PLAN_STATUS.ORIGIN_TOO_FAR ? 'starting point' : 'destination';
      const near = d.nearestStop ? `<p class="muted">Nearest verified stop: <b>${escapeHtml(d.nearestStop.name)}</b>, about ${formatMeters(d.nearestStop.distanceMeters)} away.</p>` : '';
      return `<section class="card state state-warn" role="status"><h2 class="section-title">Your ${which} is too far from a verified stop</h2><p>${escapeHtml(result.message)}</p>${near}
<p class="muted">Try a point closer to a covered route.</p></section>`;
    }
    case PLAN_STATUS.INVALID_INPUT:
      return `<section class="card state state-warn" role="alert"><h2 class="section-title">Check your trip</h2><p>${escapeHtml(result.message)}</p></section>`;
    default:
      return `<section class="card state state-error" role="alert"><h2 class="section-title">Route data problem</h2><p>${escapeHtml(result.message)}</p>
${(d.errors ?? []).map((e) => `<p class="muted">• ${escapeHtml(e.message)}</p>`).join('')}</section>`;
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

export function renderDraftResult(result, selectedIndex = 0) {
  const warn = `<div class="notice" role="note"><b>Terminal locations A/B are verified from your real-world observations.</b> Route geometry, boarding and drop-off points along the route, transfers between routes, service direction and current operation are unverified or estimated. Walking directions use pedestrian paths mapped in OpenStreetMap; check crossings in person. Times are estimates, not schedules.</div>`;
  if (result.status !== 'draft_success') {
    return `${warn}<section class="card state state-empty" role="status"><h2 class="section-title">No draft match</h2><p>${escapeHtml(result.message)}</p></section>`;
  }
  const anyTwoWay = result.itineraries.some((it) => it.legs.some((l) => !l.oneWay));
  const twoWayWarn = anyTwoWay ? '<div class="notice" role="note"><b>Check the way back.</b> Some lines were traced as “both ways”, so they assume the same road in each direction. Jeepney routes often return by a different road — trace the way there (Route 1) and the way back (Route 2) separately in the route tracer for correct results when you switch the trip.</div>' : '';
  const cards = result.itineraries.map((it, i) => {
    if (it.walkingOnly) {
      const walk = it.walkRoutes?.[0];
      const meters = walk?.distanceMeters ?? it.totalWalkMeters;
      const directions = walk?.steps?.length ? `<small><details class="walk-turns"><summary>Show ${walk.steps.length} walking steps</summary><ol>${walk.steps.map((s) => `<li>${escapeHtml(s.instruction)} · ${formatMeters(s.distanceMeters)}</li>`).join('')}</ol></details></small>` : '<small>Pedestrian route unavailable; straight-line estimate shown. Sidewalks and crossings may differ.</small>';
      const steps = `<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk to your destination, about <b>${formatMeters(meters)}</b>${directions}</div></li>`;
      return `<section class="card itinerary${i === selectedIndex ? ' is-selected' : ''}"><h3>Walk (no fare)${i === 0 ? ' <span class="badge">No jeepney fare</span>' : ''}</h3><p class="summary">${walk ? `≈ ${Math.max(1, Math.round(walk.durationSeconds / 60))} min` : `≈ ${it.estimatedMinutes} min`} on foot · walking ≈ ${formatMeters(meters)}</p><ol class="steps">${steps}</ol><button type="button" class="btn btn-secondary" data-draft-itinerary="${i}" aria-pressed="${i === selectedIndex}">Show on map</button></section>`;
    }
    const walkingStep = (index, fallbackMeters) => {
      const walk = it.walkRoutes?.[index];
      if (!walk) return `${walkNote(fallbackMeters)} · straight-line guide; sidewalks and crossings are not checked`;
      return walk.steps.length
        ? `Pedestrian route via OpenStreetMap · <details class="walk-turns"><summary>Show ${walk.steps.length} walking steps</summary><ol>${walk.steps.map((s) => `<li>${escapeHtml(s.instruction)} · ${formatMeters(s.distanceMeters)}</li>`).join('')}</ol></details>`
        : 'Pedestrian route via OpenStreetMap';
    };
    const walkMeters = (index, fallback) => it.walkRoutes?.[index]?.distanceMeters ?? fallback;
    const steps = [`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(walkMeters(0, it.accessWalkMeters))}</b> to the <b>${escapeHtml(it.legs[0].routeName)}</b> line (the ${escapeHtml(it.legs[0].jeepneyColorName)} jeepney)<small>${walkingStep(0, it.accessWalkMeters)}</small></div></li>`];
    it.legs.forEach((l, k) => {
      steps.push(`<li class="step">${dot(l.displayColor)}<div>Ride the <b>${escapeHtml(l.routeName)}</b> (${escapeHtml(l.jeepneyColorName)} jeepney) about <b>${formatMeters(l.rideMeters)}</b> along its line<small>${escapeHtml(l.directionLabel)}${l.oneWay && !l.isLoop ? ' (one-way)' : ''} · terminal locations A/B are verified; boarding and drop-off points along the line are approximate</small></div></li>`);
      if (k < it.legs.length - 1) steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">⇄</span><div>Transfer between jeepney lines (about ${formatMeters(walkMeters(k + 1, it.transferWalkMeters))} on foot)<small>${walkingStep(k + 1, it.transferWalkMeters)} · transfer is inferred from unverified traces</small></div></li>`);
    });
    const lastWalk = it.walkLines.length - 1;
    const [destLng, destLat] = result.destination ?? it.walkLines[lastWalk]?.at(-1) ?? [null, null];
    const [walkStartLng, walkStartLat] = it.legs.at(-1)?.alightPoint ?? [null, null];
    const crossingHelp = (result.crossingFacilities ?? []).filter((facility) => facility.distanceMeters <= 1200).slice(0, 3).map((facility) => {
      const [facilityLng, facilityLat] = facility.coordinates;
      const url = `https://www.google.com/maps/dir/?api=1&origin=${walkStartLat},${walkStartLng}&destination=${destLat},${destLng}&waypoints=${facilityLat},${facilityLng}&travelmode=walking`;
      return `<li>${escapeHtml(facility.kind)}${facility.name !== facility.kind ? ` · ${escapeHtml(facility.name)}` : ''}, about ${formatMeters(facility.distanceMeters)} from destination — <a href="${url}" target="_blank" rel="noopener noreferrer">walking directions via this point</a> · <a href="${escapeHtml(facility.osmUrl)}" target="_blank" rel="noopener noreferrer">OSM map</a></li>`;
    }).join('');
    const crossingList = crossingHelp
      ? ` Nearby OpenStreetMap-mapped pedestrian facilities (check access and conditions in person):<ul>${crossingHelp}</ul>`
      : '';
    steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(walkMeters(lastWalk, it.egressWalkMeters))}</b> from the approximate drop-off to your destination<small>${walkingStep(lastWalk, it.egressWalkMeters)} · crossing safety is not assessed.${crossingList}</small></div></li>`);
    const title = it.transfers === 0 ? 'Direct ride (draft)' : `${it.transfers} ${it.transfers === 1 ? 'transfer' : 'transfers'} (draft)`;
    return `<section class="card itinerary${i === selectedIndex ? ' is-selected' : ''}"><h3>${title}${i === 0 ? ' <span class="badge">Recommended option</span>' : ''}${it.isFastest ? ' <span class="badge badge-fast">Fastest (estimated)</span>' : ''}${it.isLeastWalking ? ' <span class="badge">Least walking</span>' : ''}</h3>
      <p class="summary"><b>≈ ${it.estimatedMinutes} min</b> (rough estimate) · ${it.legs.length} jeepney ride${it.legs.length === 1 ? '' : 's'} · walking ≈ ${formatMeters(it.routedWalkMeters ?? it.totalWalkMeters)} · ride ≈ ${formatMeters(it.approxRideMeters)} · fare data unavailable</p>
      <ol class="steps">${steps.join('')}</ol>
      <button type="button" class="btn btn-secondary" data-draft-itinerary="${i}" aria-pressed="${i === selectedIndex}">Show on map</button></section>`;
  }).join('');
  return `<h2 class="section-title">Draft suggestions</h2>${warn}${twoWayWarn}${cards}`;
}
