const MAX_FIELD_LENGTH = 2000;

const clean = (value, limit = MAX_FIELD_LENGTH) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()
  .slice(0, limit);

export function buildFeedbackIssueUrl(fields, { repository = 'rnzcrt/sakay-angeles', now = new Date() } = {}) {
  const issueType = clean(fields.issueType, 120);
  const incorrect = clean(fields.incorrect);
  if (!issueType || !incorrect) throw new Error('Choose an issue and describe what happened.');
  if (clean(fields.website, 200)) throw new Error('This report could not be prepared.');

  const route = clean(fields.route, 160) || 'Route not selected';
  const title = `[Community route feedback] ${issueType}: ${route}`.slice(0, 180);
  let source = clean(fields.sourceUrl, 500) || 'Not provided';
  if (source !== 'Not provided') {
    try {
      const sourceUrl = new URL(source);
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) source = 'Invalid link removed';
    } catch {
      source = 'Invalid link removed';
    }
  }
  const sections = [
    ['Issue', issueType],
    ['Route / jeepney color', route],
    ['Starting point', clean(fields.origin, 180) || 'Not provided'],
    ['Destination', clean(fields.destination, 180) || 'Not provided'],
    ['Location or stop', clean(fields.location, 240) || 'Not provided'],
    ['What seems incorrect?', incorrect],
    ['Suggested correction', clean(fields.correction) || 'Not provided'],
    ['Trip experience', clean(fields.experience) || 'Not provided'],
    ['Date of trip', clean(fields.travelDate, 20) || 'Not provided'],
    ['Public source', source],
    ['Report received', now.toISOString()],
  ];
  const body = [
    '> Community testing report. This is a suggestion for review, not an automatic route-data change.',
    '',
    ...sections.flatMap(([heading, value]) => [`### ${heading}`, value, '']),
    'Maintainer review status: Pending review',
  ].join('\n');
  const url = new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  url.searchParams.set('labels', 'community-feedback');
  if (url.toString().length > 7500) throw new Error('This report is too long for GitHub. Shorten the details and try again.');
  return url.toString();
}
