# Client supplier approvals — WP275 / N16

An approved supplier for one client or domain was previously usable without checking client-specific lists or exclusivity. Purchases now resolve every linked client, manufactured article and purchased article, including the original customer OFs behind active production consolidations. Submission, approval, prepared-document generation, official reissue and sending evaluate all applicable scopes together.

Quality records an explicit supplier list or exclusive supplier with inclusive validity dates, reason and approved evidence. Scope may target all client products, one manufactured article, one purchased article, or both. A general restriction cannot be overridden by a specific permissive rule. Suspension, expiry, obsolete evidence and an unlisted supplier block engagement with a recoverable 409. Missing configuration is shown as such and does not invent an approval or automatically block legacy unrelated purchases.

Evidence uses the existing GED workflow: PDF class `CERP_AGREMENT_FOURNISSEUR`, one live CLIENT parent matching the policy, applicable publication and clean/released upload. No source text or real supplier decision is seeded. Selection creates a retention hold. Scope/revision/member rows cannot be rewritten; members can only be added in the revision's original transaction. Revisions use optimistic concurrency and idempotency. Policy writers and engagements lock clients in sorted order before suppliers to avoid inverse lock order.

The full policy revision, supplier list, source document/version/hash, linked OF and articles are retained in prepared, sent and official purchase snapshots. A relevant new revision requires document regeneration before sending. Old preparations keep their existing qualification fingerprint when no client policy applies. Historical purchase proof does not change when current approvals expire or are revised.

Routes under `/fournisseurs/client-approvals`: GET current policies by required `client_id`; GET `/evidence`; GET `/:scopeId/history`; POST `/revisions`. Existing supplier qualification roles gate writing; each client source uses the existing client module/parent authorization. Bytes remain served by GED's authorized download route. Diagnostics expose proof metadata, not storage paths or credentials.

Publication checks: TypeScript, build/OpenAPI, and SQL/migration compilation under `cerp_app` in a rollback transaction. Seven domain regression cases are authored. Their execution, UI acceptance and combined business recipe remain deferred until the whole requested change set is finished, per Keenan's instruction.

Business recipe: approved/forbidden suppliers, inclusive expiry then expired approval, client/product/purchase scopes, two-client consolidation, concurrent revision/response-loss retry, stale prepared purchase, retained historical proof, Quality vs buyer rights. No real purchase or external email is required. UI captures/console evidence are to be completed during the combined recipe.

Next WP275 work: periodic evaluation and open supplier contracts/call-offs (N17). This lot does not close WP275.
