import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureHistoryPreviewContainer, renderSavedDataPreview, toggleSavedDataPreview } from '../src/admin/historyPreview.js';

function fakePreview() {
  return {
    dataset: {}, markup: '', textContent: '',
    get innerHTML() { return this.markup; },
    set innerHTML(value) { this.markup = value; },
    querySelector(selector) { return selector === 'details' && this.markup.includes('<details') ? {} : null; },
    replaceChildren() { this.markup = ''; this.textContent = ''; },
  };
}

function fakeEntry(previews = []) {
  return {
    previews,
    querySelector() { return this.previews.find((preview) => preview.dataset.preview) || null; },
    appendChild(preview) { this.previews.push(preview); return preview; },
  };
}

test('history preview container is recreated when missing before rendering', () => {
  const entry = fakeEntry();
  let created = 0;
  const preview = ensureHistoryPreviewContainer(entry, 'revision-a', () => { created += 1; return fakePreview(); });
  assert.ok(preview);
  assert.equal(preview.dataset.preview, 'revision-a');
  assert.equal(entry.previews.length, 1);
  assert.equal(ensureHistoryPreviewContainer(entry, 'revision-a', () => { created += 1; return fakePreview(); }), preview);
  assert.equal(created, 1, 'an existing row preview is reused');
});

test('history preview renders a valid route snapshot with saved data escaped', () => {
  const markup = renderSavedDataPreview({ data: {
    routes: [{ id: 'r1', name: '<img src=x onerror=alert(1)>' }, { id: 'r2', name: 'Other route' }],
    stops: [{ id: 's1', routeId: 'r1', name: '<script>alert(1)</script>' }, { id: 's2', routeId: 'r2' }],
    geojson: { features: [{ properties: { routeId: 'r1' }, geometry: { type: 'LineString', coordinates: [[120, 15], [121, 16]] } }, { properties: { routeId: 'r2' } }] },
  } }, 'r1');
  assert.match(markup, /<details open>/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<img|<script>/);
  assert.doesNotMatch(markup, /Other route|"s2"/);
});

test('malformed saved revisions render a safe explanation', () => {
  assert.match(renderSavedDataPreview({ data: { routes: null } }, 'r1'), /unavailable or malformed/);
  assert.match(renderSavedDataPreview(null, 'r1'), /unavailable or malformed/);
});

test('saved-data previews independently open and close for multiple history entries', () => {
  const firstEntry = fakeEntry();
  const secondEntry = fakeEntry();
  const first = ensureHistoryPreviewContainer(firstEntry, 'revision-a', () => fakePreview());
  const second = ensureHistoryPreviewContainer(secondEntry, 'revision-b', () => fakePreview());
  const markup = renderSavedDataPreview({ data: { routes: [], stops: [], geojson: { features: [] } } }, 'route-id');

  assert.equal(toggleSavedDataPreview(first, markup), true);
  assert.equal(toggleSavedDataPreview(second, markup), true);
  assert.match(first.markup, /<details open>/);
  assert.match(second.markup, /<details open>/);
  assert.equal(toggleSavedDataPreview(first, ''), false);
  assert.equal(first.markup, '');
  assert.match(second.markup, /<details open>/, 'closing one history entry leaves the other open');
});

test('history click handler re-resolves and ensures the row preview after loading the revision', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/admin.js', import.meta.url)), 'utf8');
  assert.match(source, /const preview = historyPreviewFor\(inspectId\);[\s\S]*?preview\.innerHTML = renderSavedDataPreview/);
  assert.doesNotMatch(source, /\$\(`\[data-preview=/);
});
