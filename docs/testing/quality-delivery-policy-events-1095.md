# Delivery-policy audit events — #1095 / OBS054

A signed policy could not be activated: the repository inserted event type
`ACTIVE`, while the existing PostgreSQL CHECK accepts `ACTIVATED`. Returning an
in-review policy to draft similarly inserted `DRAFT` instead of `UPDATED`.
Both errors rolled back the transaction and appeared as HTTP 500.

The domain now maps every target status to the existing audit vocabulary.
The repository only accepts that closed event type. Legal transitions,
optimistic locking, required signature references, command receipts and
transactional rollback remain unchanged. No migration is needed.

## Targeted verification

`src/__tests__/quality-delivery-policy-events-1095.repository.test.ts` calls the
real repository with a transactional query double enforcing the vocabulary
read from migration #0437. It checks activation, return to draft, the other
legal transitions, event snapshots and actor attribution. It also verifies
rollback on an audit failure and rejection of activation before signature.
The original delivery-policy domain tests remain required.

## Actual recipe replay

On `cerp_test`, retry activation of the already signed fictive RF261010 policy
through the ERP. Confirm `ACTIVE`, a persisted `ACTIVATED` event, preserved
signature/rule fingerprints and an unchanged production policy. Continue BL
eligibility normally: a successful policy activation is not a stock release.
No direct SQL policy edit, automatic release or security exception is allowed.

Runtime deployment and this replay are documented in the recipe journal;
targeted tests alone do not validate the complete manufacturing scenario.
