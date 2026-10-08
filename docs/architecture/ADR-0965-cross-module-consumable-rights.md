# ADR-0965 — Cross-module consumable rights

Consumable and assembly operations start from a Production route but also
require Stock, Quality or supplier access. An authoritative account profile
already separates those modules and must continue to take precedence over a
historical role, including explicit denials and the superadmin exception.

When no profile is available, legacy capability helpers also recognize the
ambient route module grant. Calculating stock or supplier capabilities in that
Production context incorrectly borrows its authorization, including prices.

The fallback capabilities now run inside a nested, empty account-module scope.
They are derived from the historical role alone. The surrounding request's
Production context remains unchanged. Existing authoritative module decisions
are preserved; no role, account, permission assignment or grant is modified.
Over-receipt additionally requires supplier access as well as quality access;
ordinary quality/stock receiving remains available independently.

Build/TypeScript/OpenAPI are checked before integration. Tests for absent
profile, explicit denials, inherited grants, legacy administrators, ordinary
receiving and over-receipt are prepared for the final combined acceptance,
following the human instruction of 7 October 2026. No SQL or schema change.
