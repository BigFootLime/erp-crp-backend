# Account provisioning HTTP contract (SOL-02)

## Boundary

- `POST /api/v1/auth/register`: absent (`404`)
- `POST /api/v1/admin/users`: active live account + `users.is_superadmin`, UUID `Idempotency-Key`; always creates `Inactive` and accepts no administrator-selected password
- `POST /api/v1/admin/users/:id/invitations`: same guard and idempotency; returns a one-use activation token once for controlled delivery
- `POST /api/v1/auth/activate`: public token redemption with strong password; signed token, 24-hour expiry, hashed-at-rest evidence and safe replay
- `PATCH /api/v1/admin/users/:id`: audited modification/status transition; superadmin lifecycle immutable
- `DELETE /api/v1/admin/users/:id`: absent (`404`)
- `POST /api/v1/admin/users/:id/password-reset-token`: superadmin and idempotency protected
- `PATCH /api/v1/admin/users/:id/password`: superadmin, one-use token, audited transaction

`authenticateToken` verifies the JWT and then reads the account status and session epoch from PostgreSQL. Only `Active` accounts continue. The administration router additionally resolves `is_superadmin` from PostgreSQL and fails closed.

## Audit and secrets

Business mutations and their ERP audit event share a transaction. Audit details never contain a raw password, activation/reset token, email or RH values. Token tables contain SHA-256 hashes only.

## First administrator and recovery

`db/seeds/access-tower-superadmin-keenan.sql` is the only supported bootstrap path. Production requires the explicit session setting `cerp.access_tower_superadmin_approved='KEENAN'`. HTTP routes cannot grant superadmin. Public password recovery and the KEENAN console reset are retained.

## Tenant scope

The current `users` schema has no company, tenant or site key. No tenant isolation claim is made. Introducing it requires a separate schema/RBAC migration and horizontal-access tests.
