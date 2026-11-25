import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEditTracker, makeEditSnapshot, protectBeforeUnload, runUnsavedAction } from '../src/admin/unsavedChanges.js';

const source = readFileSync(fileURLToPath(new URL('../src/admin.js', import.meta.url)), 'utf8');
const adminHtml = readFileSync(fileURLToPath(new URL('../admin.html', import.meta.url)), 'utf8');

function fixture() {
  return {
    route: { id: 'route-a', name: 'Route A', description: 'Original', fareClass: 'traditional', fareClassEvidence: { source: 'Source', method: 'Review', checkedAt: '2026-11-01' } },
    stops: [{ id: 'stop-a', routeId: 'route-a', name: 'Terminal', coordinates: [120, 15] }],
    audit: { change: '', reason: '', source: '', observation: '' },
  };
}

const copy = (value) => structuredClone(value);

test('clean editor does not become dirty or trigger browser navigation protection', () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  assert.equal(tracker.dirty, false);
  assert.equal(protectBeforeUnload(event, tracker), false);
  assert.equal(event.prevented, false);
  assert.equal(event.returnValue, undefined);
});

test('text, stop, stop addition, removal, and fare evidence changes mark edits dirty', () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));

  const renamed = copy(initial); renamed.route.name = 'Changed';
  assert.equal(tracker.update(makeEditSnapshot(renamed.route, renamed.stops, renamed.audit)), true);
  const stopChanged = copy(initial); stopChanged.stops[0].name = 'Changed stop';
  assert.equal(tracker.update(makeEditSnapshot(stopChanged.route, stopChanged.stops, stopChanged.audit)), true);
  const stopAdded = copy(initial); stopAdded.stops.push({ id: 'stop-b', routeId: 'route-a', name: 'New stop' });
  assert.equal(tracker.update(makeEditSnapshot(stopAdded.route, stopAdded.stops, stopAdded.audit)), true);
  const stopRemoved = copy(initial); stopRemoved.stops = [];
  assert.equal(tracker.update(makeEditSnapshot(stopRemoved.route, stopRemoved.stops, stopRemoved.audit)), true);
  const evidenceChanged = copy(initial); evidenceChanged.route.fareClassEvidence.method = 'Another review';
  assert.equal(tracker.update(makeEditSnapshot(evidenceChanged.route, evidenceChanged.stops, evidenceChanged.audit)), true);
});

test('reverting every form edit returns the tracker to clean', () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));
  const changed = copy(initial); changed.route.description = 'Temporary edit';
  assert.equal(tracker.update(makeEditSnapshot(changed.route, changed.stops, changed.audit)), true);
  assert.equal(tracker.update(makeEditSnapshot(initial.route, initial.stops, initial.audit)), false);
});

test('audit-only edits are dirty but cannot use Save in the guarded-action flow', async () => {
  const initial = fixture();
  const tracker = createEditTracker();
  const baseline = makeEditSnapshot(initial.route, initial.stops, initial.audit);
  tracker.setBaseline(baseline);
  const changed = copy(initial); changed.audit.reason = 'Reviewed new source';
  const current = makeEditSnapshot(changed.route, changed.stops, changed.audit);
  assert.equal(tracker.update(current), true);
  assert.equal(tracker.dataDirty, false);
  assert.equal(tracker.auditDirty, true);

  const outcome = await runUnsavedAction({
    dirty: tracker.dirty, canSave: tracker.dataDirty, choice: 'save',
    save() { assert.fail('audit-only edits must not offer or attempt Save'); },
    discard() {}, proceed() { assert.fail('unavailable Save must not proceed'); },
  });
  assert.equal(outcome, 'save-unavailable');
  assert.equal(tracker.dirty, true);
});

test('audit-only Discard clears audit values, while Cancel preserves them', async () => {
  const initial = fixture();
  const tracker = createEditTracker();
  const baseline = makeEditSnapshot(initial.route, initial.stops, initial.audit);
  tracker.setBaseline(baseline);
  const changed = copy(initial); changed.audit.reason = 'Unsaved audit details';
  const current = makeEditSnapshot(changed.route, changed.stops, changed.audit);
  tracker.update(current);

  const cancelled = await runUnsavedAction({ dirty: tracker.dirty, canSave: false, choice: 'cancel', proceed() {} });
  assert.equal(cancelled, 'cancelled');
  assert.equal(tracker.dirty, true);
  assert.equal(current.audit.reason, 'Unsaved audit details');

  const discarded = await runUnsavedAction({
    dirty: tracker.dirty, canSave: false, choice: 'discard',
    discard() { tracker.setBaseline(baseline); }, proceed() {},
  });
  assert.equal(discarded, 'proceeded');
  assert.equal(tracker.dirty, false);
  assert.equal(tracker.auditDirty, false);
  assert.equal(tracker.dataDirty, false);
});

test('a successful route/stop save clears both data and audit dirty states', async () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));
  const changed = copy(initial); changed.route.name = 'Saved route'; changed.audit.reason = 'Updated source';
  const current = makeEditSnapshot(changed.route, changed.stops, changed.audit);
  tracker.update(current);
  assert.equal(tracker.dataDirty, true);
  assert.equal(tracker.auditDirty, true);

  const outcome = await runUnsavedAction({
    dirty: tracker.dirty, canSave: tracker.dataDirty, choice: 'save',
    async save() { tracker.setBaseline(current); return true; }, proceed() {},
  });
  assert.equal(outcome, 'proceeded');
  assert.equal(tracker.dirty, false);
  assert.equal(tracker.dataDirty, false);
  assert.equal(tracker.auditDirty, false);
});

test('failed save preserves dirty state and does not switch routes', async () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));
  const changed = copy(initial); changed.route.name = 'Unsaved';
  tracker.update(makeEditSnapshot(changed.route, changed.stops, changed.audit));
  let selectedId = 'route-a';

  const outcome = await runUnsavedAction({
    dirty: tracker.dirty, choice: 'save',
    async save() { return false; }, discard() { assert.fail('failed save must not discard'); },
    proceed() { selectedId = 'route-b'; },
  });
  assert.equal(outcome, 'save-failed');
  assert.equal(selectedId, 'route-a');
  assert.equal(tracker.dirty, true);
  assert.equal(changed.route.name, 'Unsaved');
});

test('clean route switch proceeds normally', async () => {
  let selectedId = 'route-a';
  const outcome = await runUnsavedAction({ dirty: false, proceed() { selectedId = 'route-b'; } });
  assert.equal(outcome, 'proceeded');
  assert.equal(selectedId, 'route-b');
});

test('Save and switch waits for successful save before switching', async () => {
  const events = [];
  let finishSave;
  const saving = new Promise((resolve) => { finishSave = resolve; });
  const pending = runUnsavedAction({
    dirty: true, choice: 'save',
    async save() { events.push('save-start'); await saving; events.push('save-finished'); return true; },
    discard() {}, proceed() { events.push('switch'); },
  });
  await Promise.resolve();
  assert.deepEqual(events, ['save-start']);
  finishSave();
  assert.equal(await pending, 'proceeded');
  assert.deepEqual(events, ['save-start', 'save-finished', 'switch']);
});

test('Discard restores before switching; Cancel preserves edits and selection', async () => {
  const events = [];
  const initial = fixture();
  const changed = copy(initial); changed.route.name = 'Unsaved name'; changed.audit.reason = 'Unsaved reason';
  let selectedId = 'route-a';
  const discarded = await runUnsavedAction({ dirty: true, choice: 'discard', save() {}, discard() { events.push('restore-baseline'); }, proceed() { selectedId = 'route-b'; } });
  assert.equal(discarded, 'proceeded');
  assert.deepEqual(events, ['restore-baseline']);
  assert.equal(selectedId, 'route-b');

  selectedId = 'route-a';
  const cancelled = await runUnsavedAction({ dirty: true, choice: 'cancel', save() {}, discard() { events.push('unexpected-discard'); }, proceed() { selectedId = 'route-b'; } });
  assert.equal(cancelled, 'cancelled');
  assert.equal(selectedId, 'route-a');
  assert.equal(changed.route.name, 'Unsaved name');
  assert.equal(changed.audit.reason, 'Unsaved reason');
  assert.deepEqual(events, ['restore-baseline']);
});

test('beforeunload protection runs only while dirty', () => {
  const initial = fixture();
  const tracker = createEditTracker();
  tracker.setBaseline(makeEditSnapshot(initial.route, initial.stops, initial.audit));
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  const changed = copy(initial); changed.route.description = 'Unsaved';
  tracker.update(makeEditSnapshot(changed.route, changed.stops, changed.audit));

  assert.equal(protectBeforeUnload(event, tracker), true);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
});

test('production admin uses the tracker, guard, and accessible Save/Discard/Cancel dialog', () => {
  assert.match(source, /const editTracker = createEditTracker\(setUnsavedIndicator\)/);
  assert.match(source, /editTracker\.setBaseline\(makeEditSnapshot/);
  assert.match(source, /editTracker\.update\(snapshot\)/);
  assert.match(source, /const auditOnly = editTracker\.auditDirty && !editTracker\.dataDirty/);
  assert.match(source, /Audit details can only be saved together with an actual route or stop change/);
  assert.match(source, /\$\('unsaved-save'\)\.hidden = auditOnly/);
  assert.match(source, /canSave: editTracker\.dataDirty/);
  assert.match(source, /if \(!editTracker\.dataDirty\)[\s\S]*?Make a route or stop change before saving/);
  assert.match(source, /auditDirty && !dataDirty[\s\S]*?Unsaved audit details\. They can only be saved with a route or stop change/);
  assert.match(source, /window\.addEventListener\('beforeunload',[\s\S]*?protectBeforeUnload\(event, editTracker\)/);
  assert.match(source, /guardAction\(\(\) => \{ selectedId = nextId/);
  assert.match(source, /runUnsavedAction\(\{[\s\S]*?save: saveCurrentRoute,[\s\S]*?discard: restoreSelectedBaseline/);
  assert.match(source, /choice === 'save' && !\$\('route-form'\)\.checkValidity\(\)[\s\S]*?\$\('unsaved-dialog'\)\.close\(\)[\s\S]*?\$\('route-form'\)\.reportValidity\(\)/);
  assert.match(source, /\$\('reload'\)\.addEventListener\('click',[\s\S]*?guardAction/);
  assert.match(source, /\$\('signout'\)\.addEventListener\('click',[\s\S]*?guardAction/);
  assert.match(source, /metadataOnly: true/);
  assert.doesNotMatch(source, /add-stop|stops-list|add-direction|directions-list/);
  assert.match(adminHtml, /id="unsaved-indicator"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(
  adminHtml,
  /<dialog\b(?=[^>]*\bid="unsaved-dialog")(?=[^>]*\baria-labelledby="unsaved-title")(?=[^>]*\baria-describedby="unsaved-description")[^>]*>/
);
 assert.match(
  adminHtml,
  /id="unsaved-cancel"[\s\S]*?>\s*Cancel/
);

assert.match(
  adminHtml,
  /id="unsaved-save"[\s\S]*?>\s*Save and continue/
);

assert.match(
  adminHtml,
  /id="unsaved-discard"[\s\S]*?>\s*Discard and continue/
);
  assert.match(source, /\$\('unsaved-dialog'\)\.addEventListener\('cancel',[\s\S]*?resolveGuard\('cancel'\)/);
  assert.match(source, /\$\('history-list'\)\.addEventListener\('click',[\s\S]*?guardAction\(\(\) => restoreRevision\(id\)\)/);
});
