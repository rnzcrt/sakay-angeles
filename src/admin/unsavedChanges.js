export function createEditTracker(onChange = () => {}) {
  let baseline = null;
  let dirty = false;
  let dataDirty = false;
  let auditDirty = false;
  return {
    get dirty() { return dirty; },
    get dataDirty() { return dataDirty; },
    get auditDirty() { return auditDirty; },
    setBaseline(snapshot) {
      baseline = structuredClone(snapshot);
      this.update(snapshot);
    },
    update(snapshot) {
      dataDirty = baseline !== null && JSON.stringify({ route: snapshot.route, stops: snapshot.stops }) !== JSON.stringify({ route: baseline.route, stops: baseline.stops });
      auditDirty = baseline !== null && JSON.stringify(snapshot.audit) !== JSON.stringify(baseline.audit);
      dirty = dataDirty || auditDirty;
      onChange(dirty, { dataDirty, auditDirty });
      return dirty;
    },
  };
}

export function makeEditSnapshot(route, stops, audit) {
  return structuredClone({ route, stops, audit });
}

export function protectBeforeUnload(event, tracker) {
  if (!tracker.dirty) return false;
  event.preventDefault();
  event.returnValue = '';
  return true;
}

export async function runUnsavedAction({ dirty, canSave = true, choice, save, discard, proceed }) {
  if (!dirty) {
    await proceed();
    return 'proceeded';
  }
  if (!choice) return 'confirmation-required';
  if (choice === 'cancel') return 'cancelled';
  if (choice === 'save') {
    if (!canSave) return 'save-unavailable';
    const saved = await save();
    if (!saved) return 'save-failed';
  } else if (choice === 'discard') {
    await discard();
  } else {
    return 'cancelled';
  }
  await proceed();
  return 'proceeded';
}
