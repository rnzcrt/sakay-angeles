import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedbackIssueUrl } from '../src/services/feedback.js';

test('route feedback pre-fills a maintainer issue without adding personal information', () => {
  const url = new URL(buildFeedbackIssueUrl({
    issueType: 'Incorrect fare', route: 'Yellow · Villa – Pampang', origin: 'City Hall', destination: 'Pampang Market',
    location: 'Miranda Street', incorrect: 'Fare was different.', correction: 'Driver charged ₱15.',
    experience: 'Rode this morning.', travelDate: '2026-10-23', sourceUrl: 'https://example.org/fare',
  }, { now: new Date('2026-10-23T01:02:03.000Z') }));
  assert.equal(url.hostname, 'github.com');
  assert.equal(url.pathname, '/rnzcrt/sakay-angeles/issues/new');
  assert.match(url.searchParams.get('title'), /Incorrect fare/);
  assert.match(url.searchParams.get('body'), /Maintainer review status: Pending review/);
  assert.match(url.searchParams.get('body'), /https:\/\/example.org\/fare/);
  assert.doesNotMatch(url.searchParams.get('body'), /phone|email|coordinates/i);
});

test('feedback report requires an issue and description, rejects honeypot and unsafe source links', () => {
  assert.throws(() => buildFeedbackIssueUrl({ issueType: '', incorrect: '' }), /Choose an issue/);
  assert.throws(() => buildFeedbackIssueUrl({ issueType: 'Other', incorrect: 'Test', website: 'spam' }), /could not be prepared/);
  const url = new URL(buildFeedbackIssueUrl({ issueType: 'Other', incorrect: 'Test', sourceUrl: 'javascript:alert(1)' }));
  assert.match(url.searchParams.get('body'), /Invalid link removed/);
  assert.doesNotMatch(url.searchParams.get('body'), /javascript:/);
});
