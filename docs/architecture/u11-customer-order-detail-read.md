# Customer-order detail read owner — U11

`commande-detail-read.repository.ts` owns the aggregate detail read, its six
optional includes, contract and legacy associations, ID mapping, and missing-row
behavior. The existing public `repoGetCommande(id, includes)` facade constructs
the stateless owner when invoked, preserving pool lookup timing.

The workflow-status projection, integer conversion and existing role-column
capability remain shared dependencies. This does not duplicate the capability
cache or change the historical fallback when that column is absent. Contract and
legacy reads keep their existing lower repository owners.

The extracted body, `includeFlags`, `IncludeFlags` and `HeaderRow` are compared
with their actual historical declarations. The original SQL and mapping steps
are retained; only enclosing indentation changes. An earlier compact rewrite
was rejected before integration and replaced with this mechanical extraction.

Recording tests cover every combination of optional includes, mapping and query
order, missing headers, invalid IDs, child-query failure, null clients, contract
bindings, role-column fallback, and the real public facade's invocation timing.
These are complemented by strict compilation and transitive source/emitted
dependency checks. They do not certify PostgreSQL or browser acceptance.

Mutation transactions, authorization, document writes, locks, notifications and
workflow actions retain their existing owners. No public API, deployment,
production service or database is changed by this read-owner extraction.
