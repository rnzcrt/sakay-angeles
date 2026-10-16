// Pure string renderers for trip planner outcomes.
import { PLAN_STATUS } from '../routing/planner.js';
import { escapeHtml, formatMeters } from './html.js';

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
  const warn = `<div class="notice" role="note"><b>Draft guidance only.</b> These suggestions come from hand-traced, <b>unverified</b> route lines. They do not know real stops, which way a jeepney runs, or whether it is running. Ask a driver or local before relying on them. Times assume about 4.5 km/h walking, 12 km/h by jeepney and a few minutes of waiting per ride; they are not schedules.</div>`;
  if (result.status !== 'draft_success') {
    return `${warn}<section class="card state state-empty" role="status"><h2 class="section-title">No draft match</h2><p>${escapeHtml(result.message)}</p></section>`;
  }
  const anyTwoWay = result.itineraries.some((it) => it.legs.some((l) => !l.oneWay));
  const twoWayWarn = anyTwoWay ? '<div class="notice" role="note"><b>Check the way back.</b> Some lines were traced as “both ways”, so they assume the same road in each direction. Jeepney routes often return by a different road — trace the way there (Route 1) and the way back (Route 2) separately in the route tracer for correct results when you switch the trip.</div>' : '';
  const cards = result.itineraries.map((it, i) => {
    const steps = [`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.accessWalkMeters)}</b> to the <b>${escapeHtml(it.legs[0].routeName)}</b> line<small>Straight-line estimate · look for the jeepney color below</small></div></li>`];
    it.legs.forEach((l, k) => {
      steps.push(`<li class="step">${dot(l.displayColor)}<div>Ride the <b>${escapeHtml(l.routeName)}</b> (${escapeHtml(l.jeepneyColorName)} jeepney) about <b>${formatMeters(l.rideMeters)}</b> along its line<small>${escapeHtml(l.directionLabel)}${l.oneWay && !l.isLoop ? ' (one-way)' : ''} · board and get off near the white dots on the map (approximate — no real stops are known)</small></div></li>`);
      if (k < it.legs.length - 1) steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">⇄</span><div>Transfer where the two lines come close (about ${formatMeters(it.transferWalkMeters)} apart)<small>Assumed from the traced lines — not a verified transfer</small></div></li>`);
    });
    steps.push(`<li class="step"><span class="step-icon" aria-hidden="true">🚶</span><div>Walk about <b>${formatMeters(it.egressWalkMeters)}</b> to your destination<small>Straight-line estimate</small></div></li>`);
    const title = it.transfers === 0 ? 'Direct ride (draft)' : `${it.transfers} transfer (draft)`;
    return `<section class="card itinerary${i === selectedIndex ? ' is-selected' : ''}"><h3>${title}${i === 0 ? ' <span class="badge">Fastest (estimated)</span>' : ''}</h3>
      <p class="summary"><b>≈ ${it.estimatedMinutes} min</b> (rough estimate) · walking ≈ ${formatMeters(it.totalWalkMeters)} · ride ≈ ${formatMeters(it.approxRideMeters)} along the line</p>
      <ol class="steps">${steps.join('')}</ol>
      <button type="button" class="btn btn-secondary" data-draft-itinerary="${i}" aria-pressed="${i === selectedIndex}">Show on map</button></section>`;
  }).join('');
  return `<h2 class="section-title">Draft suggestions</h2>${warn}${twoWayWarn}${cards}`;
}
