# OLD reference and packaging audit repair

Issue #1098 / OBS056 / recipe WP-285, S08.

Appending a historical document reference returned HTTP500 on Base Test. The
transaction attempted an incomplete direct audit INSERT. Read-only schema
inspection confirmed that `erp_audit_logs.event_type` is required and has no
default; SQLSTATE23502 rolled back the reference. Packaging creation used the
same incomplete writer.

Both commands now use `repoInsertAuditLog` with the canonical `ACTION` event,
the caller's transaction, and the original actor, action, lot and details.
The audit's durable notification also belongs to that transaction. No schema,
authorization, quality gate, stock quantity or historical provenance is changed.

The focused repository tests exercise the real shared audit writer against a
query fixture enforcing the observed required column. They reproduce the prior
failure and cover success, exact replay, key conflicts, wrong stock scope,
physical remainder and quality refusal, audit failure, notification failure,
and rollback of packaging/identification. Existing packaging domain and audit
immutability checks run alongside them. These tests do not replace the real
Test UI replay after deployment.

Recipe proof: append the explicit fictive OLD document reference on Base Test,
verify one reference and one ACTION audit, then preserve that link in the BL.
The referenced demonstration file actually exists on the server and is clearly
marked as fictive; it is not a material certificate or a fabricated historical OF.
Do not declare shipment or the complete ERP recipe passed from this repair alone.
