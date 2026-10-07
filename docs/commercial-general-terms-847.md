# Approved commercial terms — WP274 / #847

The backend owns append-only legal-template selections for quotes, customer orders
and supplier orders. The existing GED owns the approved PDF and immutable blob.
CGV/CGA are distinct from issuer legal mentions and supplier payment terms.

The two new source classes require approval, a released clean upload and a live,
unambiguous authorized GED parent. Selection records pin the exact version/hash;
they do not create extra GED parent links. A legal hold and restrictive foreign
keys retain the source. Reads expose no physical locator.

Writes lock the business parent, check the expected selection, and use a UUID
idempotency key with a server-side request hash. Quote and supplier-order choices
change only in draft; customer orders cannot change after closure. A successful
choice updates the source revision and invalidates an unsent AR’s content fingerprint.
Emission locks/validates the applicable version and freezes its reference in the
authoritative snapshot. Archived attachments authorize the receiving business
archive, validate the pinned GED identity/hash/verdict and read verified vault bytes.
Obsoleting a template prevents new issuance but preserves earlier annexes.

Conditions are separate PDF annexes; no PDF merge dependency or invented legal
text is introduced. The commercial PDF names its annex, and AR email transport
attaches the exact approved annex alongside the exact official AR.

Rollout is additive: legacy archives remain intact. Before an approved source of
the corresponding class is configured, an explicit UI warning preserves existing
issuance. Afterwards, new issuance requires an applicable explicit selection.
Actual approved CGV/CGA references remain to be supplied by the business owner.

Migration: `20261007_versioned_general_terms_847.sql` with preflight, verification
and guarded rollback. Rollback refuses deletion after source documents or selections
exist. Application rollback can keep this additive schema and access-event vocabulary.

Runtime TypeScript and frontend TypeScript compile. Regression cases are authored
for missing configuration, mandatory selection, obsolete/changed sources, frozen
metadata and AR freshness. Business/tests suites are deliberately deferred to the
final combined validation per the user’s instruction; no green acceptance is claimed.
