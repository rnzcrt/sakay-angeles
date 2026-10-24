import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

test('public page has the community notice and no contributor or reference-map links', () => {
  assert.match(index, /Help improve Sakay Angeles/);
  assert.doesNotMatch(index, /trace\.html|Reference maps|Contributors: open/);
});

test('feedback form offers all report types and does not request identity information', () => {
  const issues = [
    'Incorrect jeepney route', 'Wrong route direction', 'Incorrect boarding or drop-off point', 'Missing stop',
    'Incorrect fare', 'Incorrect jeepney color or name', 'Missing or incorrect transfer', 'Walking route is too long',
    'Unsafe pedestrian crossing', 'Better or more direct route available', 'Other',
  ];
  for (const issue of issues) assert.ok(index.includes(`<option>${issue}</option>`), issue);
  assert.match(index, /Reports open as a GitHub issue/);
  assert.doesNotMatch(index, /name="(phone|email|fullName)"/i);
});

test('private admin pages are built for the access-controlled Node server', async () => {
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(vite, /admin: 'admin\.html', trace: 'trace\.html'/);
  assert.match(server, /pathname === '\/trace\.html'[\s\S]*?if \(!sessionFor\(req\)\)/);
  assert.match(server, /pathname\.startsWith\('\/api\/admin\/'\)[\s\S]*?if \(!session\)/);
  assert.match(server, /pathname\.startsWith\('\/data\/'\)/);
});
