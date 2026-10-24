# Public route feedback and maintainer review

Public route feedback opens a prefilled GitHub issue for `rnzcrt/sakay-angeles`. Reports stay separate from route data. The private dashboard at `/admin/routes` lists open reports, shows the report body, links to the issue, and offers review status actions. A matching route name or jeepney color also links to its route in the tracer. A report never changes geometry, stops, or fare data automatically.

The server reads reports from the repository's public GitHub Issues API. Review actions use the administrator's server-side GitHub OAuth token to apply a status label and optional comment. OAuth is scoped to `public_repo`; no token or client secret is sent to the browser. The route dashboard and tracer require an authenticated GitHub account listed in `ADMIN_GITHUB_USERS`.

When a correction is justified, open the route in the tracer, make the change, preview it on the map, enter the change reason and information source, then publish. The server validates the complete dataset, preserves a revision snapshot, and leaves changed geometry and directions unverified. Route and stop edits have the same audit fields. Existing terminal verification is retained until that terminal itself is changed; changed stops are marked unverified. Fare class changes require the audit source and observation as evidence.

Route files are written atomically to `public/data` by default. Revision snapshots are stored in `.route-history`. For production, point `ROUTE_DATA_DIR` and `ROUTE_HISTORY_DIR` at persistent directories and back them up. Run `npm start`; static hosting cannot enforce this access boundary or save route changes.
