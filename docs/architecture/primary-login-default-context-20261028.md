# Primary login default context — 2026-10-28

When the company-runtime flag is enabled, the legacy CRP login form and older
clients do not include `X-CERP-Company`. They were incorrectly rejected before
the password and MFA flow by the company login-target middleware, although the
fixed `cerp_prod` and `cerp_test` processes are themselves the primary site.
This also covers a form left open across the flag transition (a stale form): it
must reach the normal password and MFA checks rather than fail on an invented
company-link error.

Only those two fixed primary sites may use their configured runtime as the
missing-header default. Explicit headers continue to require the exact fixed
company and environment. A `cerp_company_*` runtime still requires both headers
and therefore cannot receive a legacy CRP login by omission.
