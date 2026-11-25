/** Apply only deliberate fare-class/evidence edits to a route record. */
export function applyFareClassEdit(route, { fareClass, originalFareClass, evidence, evidenceEdited }) {
  if (!fareClass) {
    route.fareClass = null;
    delete route.fareClassEvidence;
    return route;
  }

  route.fareClass = fareClass;
  if (fareClass !== originalFareClass && !evidence) {
    delete route.fareClassEvidence;
  } else if (evidence && (fareClass !== originalFareClass || evidenceEdited)) {
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
  if (controls.evidenceSource) controls.evidenceSource.value = original.evidence?.source ?? '';
  if (controls.evidenceMethod) controls.evidenceMethod.value = original.evidence?.method ?? '';
  if (controls.evidenceDate) controls.evidenceDate.value = original.evidence?.checkedAt ?? '';
  updateFareEvidenceRequirements(controls);
  return original;
}

export function updateFareEvidenceRequirements(controls) {
  const required = Boolean(controls.fareClass.value);
  if (controls.evidenceSource) controls.evidenceSource.required = required;
  if (controls.evidenceMethod) controls.evidenceMethod.required = required;
  if (controls.evidenceDate) controls.evidenceDate.required = required;
}

export function handleFareClassChange(controls, original) {
  if (controls.fareClass.value !== original.fareClass) {
    if (controls.evidenceSource) controls.evidenceSource.value = '';
    if (controls.evidenceMethod) controls.evidenceMethod.value = '';
    if (controls.evidenceDate) controls.evidenceDate.value = '';
  } else {
    if (controls.evidenceSource) controls.evidenceSource.value = original.evidence?.source ?? '';
    if (controls.evidenceMethod) controls.evidenceMethod.value = original.evidence?.method ?? '';
    if (controls.evidenceDate) controls.evidenceDate.value = original.evidence?.checkedAt ?? '';
  }
  updateFareEvidenceRequirements(controls);
}

export function gatherRouteFormEdits({ route, controls, original, stops, selectedId, stopRows, originalStops, directionRows, metadataOnly = false }) {
  route.name = controls.name.value.trim();
  if (controls.sourceLabel) route.sourceLabel = controls.sourceLabel.value.trim();
  if (controls.description) route.description = controls.description.value.trim();
  if (controls.colorName) route.jeepneyColorName = controls.colorName.value.trim();
  if (controls.colorText) route.displayColor = controls.colorText.value.trim();
  else if (controls.color) route.displayColor = controls.color.value;
  if (controls.active) route.active = controls.active.value === 'true';
  if (controls.startPoint) route.startPoint = controls.startPoint.value.trim();
  if (controls.destination) route.destination = controls.destination.value.trim();
  if (controls.via) route.via = controls.via.value.trim();
  if (directionRows) {
    const existing = new Map((route.directions ?? []).map((direction) => [direction.id, direction]));
    route.directions = [...directionRows].map((row) => {
      const id = row.dataset.direction;
      const direction = structuredClone(existing.get(id) ?? { id, verificationStatus: 'unverified', orderedStopIds: [], active: true });
      const value = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? '';
      direction.label = value('label').trim();
      direction.startPoint = value('startPoint').trim();
      direction.destination = value('destination').trim();
      direction.via = value('via').trim();
      direction.description = value('description').trim();
      direction.active = value('active') !== 'false';
      return direction;
    });
  }
  const hasEvidenceControls = Boolean(controls.evidenceSource && controls.evidenceMethod && controls.evidenceDate);
  const evidence = hasEvidenceControls ? {
    source: controls.evidenceSource.value.trim(),
    method: controls.evidenceMethod.value.trim(),
    checkedAt: controls.evidenceDate.value,
  } : null;
  const evidenceEdited = Boolean(evidence) && (evidence.source !== (original.evidence?.source ?? '') ||
    evidence.method !== (original.evidence?.method ?? '') ||
    evidence.checkedAt !== (original.evidence?.checkedAt ?? ''));
  applyFareClassEdit(route, { fareClass: controls.fareClass.value, originalFareClass: original.fareClass, evidence, evidenceEdited });

  if (metadataOnly) {
    if (!route.sourceLabel) route.sourceLabel = route.name;
    if (!route.jeepneyColorName) route.jeepneyColorName = route.displayColor;
    return { route, stops };
  }

  const updatedStops = stops.filter((stop) => stop.routeId !== selectedId);
  for (const row of stopRows) {
    const id = row.dataset.stop;
    const old = originalStops.find((stop) => stop.id === id);
    const value = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? '';
    const stop = old ? structuredClone(old) : { id, routeId: selectedId, verificationStatus: 'unverified' };
    stop.name = value('name').trim();
    stop.kind = value('kind');
    stop.coordinates = [value('lng').trim() === '' ? null : Number(value('lng')), value('lat').trim() === '' ? null : Number(value('lat'))];
    const directionId = value('directionId');
    if (directionId) stop.directionId = directionId;
    else delete stop.directionId;
    if (stop.kind !== 'terminal') { stop.verificationStatus = 'unverified'; delete stop.source; }
    updatedStops.push(stop);
  }
  const nextStopIds = new Set(updatedStops.map((stop) => stop.id));
  const changedDirectionIds = new Set();
  for (const oldStop of originalStops) if (!nextStopIds.has(oldStop.id) && oldStop.directionId) changedDirectionIds.add(oldStop.directionId);
  for (const direction of route.directions ?? []) {
    direction.orderedStopIds = (direction.orderedStopIds ?? []).filter((id) => nextStopIds.has(id));
  }
  const previousStopById = new Map(originalStops.map((stop) => [stop.id, stop]));
  for (const row of stopRows) {
    const id = row.dataset.stop;
    const oldDirectionId = previousStopById.get(id)?.directionId;
    const directionId = row.querySelector('[data-field="directionId"]')?.value ?? '';
    if (directionId === oldDirectionId) continue;
    if (oldDirectionId) changedDirectionIds.add(oldDirectionId);
    if (directionId) changedDirectionIds.add(directionId);
    for (const direction of route.directions ?? []) direction.orderedStopIds = direction.orderedStopIds.filter((stopId) => stopId !== id);
    const target = route.directions?.find((direction) => direction.id === directionId);
    if (target && nextStopIds.has(id)) target.orderedStopIds.push(id);
  }
  const rowsByDirection = new Map();
  for (const row of stopRows) {
    const directionId = row.querySelector('[data-field="directionId"]')?.value ?? '';
    if (!directionId) continue;
    rowsByDirection.set(directionId, [...(rowsByDirection.get(directionId) ?? []), row.dataset.stop]);
  }
  for (const direction of route.directions ?? []) {
    const assignedInOrder = rowsByDirection.get(direction.id);
    if (changedDirectionIds.has(direction.id) || (assignedInOrder && JSON.stringify(assignedInOrder) !== JSON.stringify(direction.orderedStopIds))) {
      direction.orderedStopIds = assignedInOrder ?? [];
    }
  }
  return { route, stops: updatedStops };
}
