# Stock reporting ownership

`stock-reporting.repository.ts` owns the consolidated inventory, balances,
analytics and movement-list read models. Their SQL, bindings, pagination,
sorting and result mapping remain unchanged. The compatibility exports in
`stock.repository.ts` preserve the existing service and API imports.

These reads depend directly on the database, Stock DTOs, query helpers,
traceability SQL and material-count read model. They do not depend on Stock
commands, the compatibility facade or article lifecycle commands. Inventory
count sessions and movement correction transactions retain their own owners.

The customer business-code SQL projection is shared with article reads and
historical opening reference resolution. Its exact existing default alias,
fallback policy and comments live in `stock-article-projection.ts`, beside the
existing historical material projection. Consumers import the same primitive;
there is no second implementation in an article or reporting owner.

The #446 migration guards inspect complete historical function declarations,
choosing the historical owner when present and the facade while that extraction
is pending. Their migration, preflight and rollback assertions remain intact.

Focused regression coverage exercises query bindings and pagination, material
bar requirements, OLD/NEW display mapping and authoritative analytics defaults.
These controlled database tests do not claim PostgreSQL or whole-application
acceptance. The coordinated combined candidate still requires its full checks.
