# Stock customer code (#1485)

The stock article DTO used `pieces_techniques.code_client` directly. Historical
rows can contain the internal `client_id` in that field, although the linked
customer has a valid business `client_code`. Technical-piece screens already
prefer the linked customer, which caused inconsistent displays.

Stock now resolves the linked customer's trimmed `client_code` first. A legacy
piece code is a fallback only if it is nonempty and differs from `client_id`.
Missing business references remain null; internal identifiers are never used as
display references. Article detail/list, filtering/search/sorting, consolidated
inventory and the historical finished-part client check share this rule.

No schema or business-data mutation, customer reassignment or part-reference
rewrite is included. This is a backend-only patch on the deployed material-unit
correction; the existing web and desktop bundles remain compatible.

Validation: targeted stock customer-filter, article-unit contract and historical
import route suites (25 tests); TypeScript build; generated repository SELECTs
checked in a read-only transaction on the shared test database. Cover linked
customer overriding a stale code, empty code, historical fallback and rejection
of an internal-ID fallback. Runtime promotion uses exact before/after component
hashes, health checks and preserved rollback files/images.

Project Office has no session token in this task. GitHub issue #1485 provides
the task and delivery evidence; no production SQL write is authorized or used.
