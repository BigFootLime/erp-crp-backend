# Customer-order read models — U11

The public customer-order repository retains `repoListCommandes(filters)`. Its
list owner groups the count and data queries, filter construction, sort whitelist,
pagination, and row mapping. A filter or sorting change now stays in that owner.

The caller constructs this stateless owner when the public function is invoked.
It does not resolve the pool while an unrelated repository consumer is importing
the facade. The three dependencies are the existing pool, shared workflow-status
SQL projection, and integer conversion; shared policy is not copied.

The recording tests exercise real filter and sort construction, parameter order,
pagination, empty results, query errors, and ID mapping. Structural checks compare
the moved declarations with the historical facade. These checks do not constitute
PostgreSQL or full-ERP acceptance.

The detail aggregate remains a separate batch: its six optional includes,
contract and legacy associations, and shared schema-capability fallback must move
together. The list batch changes no transaction, authorization, API, or deployment.
