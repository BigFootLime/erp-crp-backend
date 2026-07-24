# Project Office — explicit work-package codes

Issue frontend: `crp-systems-web#136` (`UI-GOV`).

`POST /api/v1/project-office/work-packages` accepts an optional `code` field in addition to the
historical auto-numbering behavior.

- omitted code: the API keeps generating `WP-001`, `WP-002`, ... under the project lock;
- explicit code: normalized to uppercase, limited to 64 characters, and validated with
  `^[A-Z0-9][A-Z0-9_-]*$`;
- duplicate explicit code in the same project: HTTP `409`, code `PO_WP_CODE_TAKEN`;
- project-scoped database uniqueness remains authoritative;
- no database migration is required.

This additive contract lets the repository helper upsert stable governance codes such as
`UI-GOV-03` without direct SQL. Authentication, Project Office feature access, project write access,
activity log and global ERP audit remain unchanged.
