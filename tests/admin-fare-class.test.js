import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyFareClassEdit, gatherRouteFormEdits, handleFareClassChange, loadFareClassForm } from '../src/admin/routeFareClass.js';
import { validateDataset } from '../src/data/validate.js';
import { makeData } from './fixtures.js';

const evidence = { source: 'Transit office notice', method: 'Published fare-class confirmation', checkedAt: '2026-10-20', reviewedBy: 'maintainer' };

function fareFormControls() {
  return Object.fromEntries(['name', 'description', 'fareClass', 'evidenceSource', 'evidenceMethod', 'evidenceDate']
    .map((field) => [field, { value: '', required: false }]));
}

function gather(route, controls, original, stops = [], selectedId = route.id, originalStops = stops) {
  return gatherRouteFormEdits({ route, controls, original, stops, selectedId, originalStops, stopRows: [] });
}

function stopRow(id, { name, kind = 'stop', lng = '0', lat = '0' }) {
  const values = { name, kind, lng, lat };
  return {
    dataset: { stop: id },
    querySelector(selector) { return { value: values[selector.match(/data-field="([^"]+)/)[1]] }; },
  };
}

test('description-only edit preserves existing fare evidence exactly', () => {
  const route = { id: 'route-a', name: 'Old name', description: 'Old', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  route.description = 'Updated description';
  applyFareClassEdit(route, { fareClass: 'traditional', originalFareClass: 'traditional', evidence: {}, evidenceEdited: false });
  assert.deepEqual(route.fareClassEvidence, evidence);
});

test('stop-only edit preserves existing fare evidence exactly', () => {
  const route = { id: 'route-a', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  const stop = { id: 'stop-a', name: 'Old stop' };
  stop.name = 'Updated stop';
  applyFareClassEdit(route, { fareClass: 'traditional', originalFareClass: 'traditional', evidence: {}, evidenceEdited: false });
  assert.deepEqual(route.fareClassEvidence, evidence);
});

test('intentional fare-class change uses only explicitly supplied evidence and validates', () => {
  const data = makeData();
  const route = data.routes[0];
  const explicitEvidence = { source: 'Transit office notice', method: 'Reviewed published classification', checkedAt: '2026-10-20' };
  applyFareClassEdit(route, { fareClass: 'traditional', originalFareClass: '', evidence: explicitEvidence, evidenceEdited: true });
  assert.equal(route.fareClass, 'traditional');
  assert.deepEqual(route.fareClassEvidence, explicitEvidence);
  assert.equal(validateDataset(data).valid, true);
});

test('invalid or incomplete fare evidence remains rejected by dataset validation', () => {
  const missing = makeData();
  missing.routes[0].fareClass = 'modern';
  applyFareClassEdit(missing.routes[0], { fareClass: 'modern', originalFareClass: '', evidence: { source: '', method: '', checkedAt: '' }, evidenceEdited: true });
  assert.ok(validateDataset(missing).errors.some((error) => error.code === 'missing_verification_evidence'));

  const invalidDate = makeData();
  applyFareClassEdit(invalidDate.routes[0], { fareClass: 'modern', originalFareClass: '', evidence: { source: 'Source', method: 'Review', checkedAt: '2026-99-99' }, evidenceEdited: true });
  assert.ok(validateDataset(invalidDate).errors.some((error) => error.code === 'missing_verification_evidence'));
});

test('admin fare form loads existing classification evidence into its controls', () => {
  const route = { id: 'route-a', name: 'Route A', description: '', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  const controls = fareFormControls();
  const original = loadFareClassForm(route, controls);

  assert.equal(controls.fareClass.value, 'traditional');
  assert.equal(controls.evidenceSource.value, evidence.source);
  assert.equal(controls.evidenceMethod.value, evidence.method);
  assert.equal(controls.evidenceDate.value, evidence.checkedAt);
  assert.deepEqual(original.evidence, evidence);
  assert.equal(controls.evidenceSource.required, true);
  assert.equal(controls.evidenceMethod.required, true);
  assert.equal(controls.evidenceDate.required, true);
});

test('admin form gather path preserves evidence after a description-only edit', () => {
  const route = { id: 'route-a', name: 'Route A', description: 'Before', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  const controls = fareFormControls();
  const original = loadFareClassForm(route, controls);
  controls.description.value = 'After';

  gather(route, controls, original);
  assert.equal(route.description, 'After');
  assert.deepEqual(route.fareClassEvidence, evidence);
});

test('admin form gather path preserves evidence after a stop-only edit', () => {
  const route = { id: 'route-a', name: 'Route A', description: '', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  const controls = fareFormControls();
  const original = loadFareClassForm(route, controls);
  const stop = { id: 'stop-a', routeId: 'route-a', name: 'Old stop', kind: 'stop', coordinates: [0, 0], verificationStatus: 'unverified' };

  const gathered = gatherRouteFormEdits({ route, controls, original, stops: [stop], selectedId: route.id, originalStops: [stop], stopRows: [stopRow(stop.id, { name: 'Updated stop' })] });
  assert.equal(gathered.stops[0].name, 'Updated stop');
  assert.deepEqual(route.fareClassEvidence, evidence);
});

test('admin fare-class change clears old evidence and requires complete replacement fields', () => {
  const route = { id: 'route-a', name: 'Route A', description: '', fareClass: 'traditional', fareClassEvidence: structuredClone(evidence) };
  const controls = fareFormControls();
  const original = loadFareClassForm(route, controls);
  controls.fareClass.value = 'modern';
  handleFareClassChange(controls, original);

  assert.deepEqual([controls.evidenceSource.value, controls.evidenceMethod.value, controls.evidenceDate.value], ['', '', '']);
  assert.ok([controls.evidenceSource, controls.evidenceMethod, controls.evidenceDate].every((control) => control.required));
  controls.evidenceSource.value = 'Current operator fare notice';
  controls.evidenceMethod.value = 'Reviewed the published notice';
  controls.evidenceDate.value = '2026-11-24';

  gather(route, controls, original);
  assert.equal(route.fareClass, 'modern');
  assert.deepEqual(route.fareClassEvidence, {
    source: 'Current operator fare notice', method: 'Reviewed the published notice', checkedAt: '2026-11-24',
  });
});

test('admin form does not produce a valid save when replacement evidence is incomplete', () => {
  const data = makeData();
  const route = data.routes[0];
  const controls = fareFormControls();
  controls.name.value = route.name;
  controls.description.value = '';
  const original = loadFareClassForm(route, controls);
  controls.fareClass.value = 'modern';
  handleFareClassChange(controls, original);
  gather(route, controls, original);

  assert.ok([controls.evidenceSource, controls.evidenceMethod, controls.evidenceDate].every((control) => control.required && control.value === ''));
  assert.ok(validateDataset(data).errors.some((error) => error.code === 'missing_verification_evidence'));
});

test('admin route selection and submit handlers are wired to the tested form workflow', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/admin.js', import.meta.url)), 'utf8');
  assert.match(source, /originalFareForm = loadFareClassForm\(route, fareControls\(\)\)/);
  assert.match(source, /\$\('route-select'\)\.addEventListener\('change',[\s\S]*?showRoute\(\)/);
  assert.match(source, /\$\('fare-class'\)\.addEventListener\('change',[\s\S]*?handleFareClassChange\(fareControls\(\), originalFareForm\)/);
  assert.match(source, /gatherRouteFormEdits\(\{ route, controls: fareControls\(\), original: originalFareForm,[\s\S]*?stopRows: \$\('stops-list'\)\.querySelectorAll/);
  assert.match(source, /\$\('route-form'\)\.addEventListener\('submit',[\s\S]*?gatherRouteEdits\(\); const result = await api\('\/api\/admin\/save'/);
});
