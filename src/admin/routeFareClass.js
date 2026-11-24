/** Apply only deliberate fare-class/evidence edits to a route record. */
export function applyFareClassEdit(route, { fareClass, originalFareClass, evidence, evidenceEdited }) {
  if (!fareClass) {
    route.fareClass = null;
    delete route.fareClassEvidence;
    return route;
  }

  route.fareClass = fareClass;
  if (fareClass !== originalFareClass || evidenceEdited) {
    route.fareClassEvidence = {
      source: evidence.source,
      method: evidence.method,
      checkedAt: evidence.checkedAt,
    };
  }
  return route;
}

export function loadFareClassForm(route, controls) {
  const original = {
    fareClass: route.fareClass ?? '',
    evidence: route.fareClassEvidence ? structuredClone(route.fareClassEvidence) : null,
  };
  controls.fareClass.value = original.fareClass;
  controls.evidenceSource.value = original.evidence?.source ?? '';
  controls.evidenceMethod.value = original.evidence?.method ?? '';
  controls.evidenceDate.value = original.evidence?.checkedAt ?? '';
  updateFareEvidenceRequirements(controls);
  return original;
}

export function updateFareEvidenceRequirements(controls) {
  const required = Boolean(controls.fareClass.value);
  controls.evidenceSource.required = required;
  controls.evidenceMethod.required = required;
  controls.evidenceDate.required = required;
}

export function handleFareClassChange(controls, original) {
  if (controls.fareClass.value !== original.fareClass) {
    controls.evidenceSource.value = '';
    controls.evidenceMethod.value = '';
    controls.evidenceDate.value = '';
  } else {
    controls.evidenceSource.value = original.evidence?.source ?? '';
    controls.evidenceMethod.value = original.evidence?.method ?? '';
    controls.evidenceDate.value = original.evidence?.checkedAt ?? '';
  }
  updateFareEvidenceRequirements(controls);
}

export function gatherRouteFormEdits({ route, controls, original, stops, selectedId, stopRows, originalStops }) {
  route.name = controls.name.value.trim();
  route.description = controls.description.value.trim();
  const evidence = {
    source: controls.evidenceSource.value.trim(),
    method: controls.evidenceMethod.value.trim(),
    checkedAt: controls.evidenceDate.value,
  };
  const evidenceEdited = evidence.source !== (original.evidence?.source ?? '') ||
    evidence.method !== (original.evidence?.method ?? '') ||
    evidence.checkedAt !== (original.evidence?.checkedAt ?? '');
  applyFareClassEdit(route, { fareClass: controls.fareClass.value, originalFareClass: original.fareClass, evidence, evidenceEdited });

  const updatedStops = stops.filter((stop) => stop.routeId !== selectedId);
  for (const row of stopRows) {
    const id = row.dataset.stop;
    const old = originalStops.find((stop) => stop.id === id);
    const value = (field) => row.querySelector(`[data-field="${field}"]`).value;
    const stop = old ? structuredClone(old) : { id, routeId: selectedId, verificationStatus: 'unverified' };
    stop.name = value('name').trim();
    stop.kind = value('kind');
    stop.coordinates = [value('lng').trim() === '' ? null : Number(value('lng')), value('lat').trim() === '' ? null : Number(value('lat'))];
    if (stop.kind !== 'terminal') { stop.verificationStatus = 'unverified'; delete stop.source; }
    updatedStops.push(stop);
  }
  return { route, stops: updatedStops };
}
