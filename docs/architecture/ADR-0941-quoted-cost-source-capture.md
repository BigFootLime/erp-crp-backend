# ADR-0941 — Quote cost sources captured at issue

Status: implemented; final combined business acceptance pending.

## Problem and decision

The QUOTED margin basis read today's technical dossier and manual inputs. Later technical changes could alter the apparent historical quote cost. The original query also combined historical purchase versions and used a stored operation quantity instead of the quote line quantity.

At the first BROUILLON → ENVOYE transition, capture internal margin inputs for the commercial quote revision and every persisted line in the quote's own transaction. The immutable capture stores revenue, cost rows, line quantities, observed technical version IDs and manual/rate evidence. Read the automatic line costs once and reuse those rows for the quote total and line captures. Capture failure rolls back the commercial transition; its existing idempotent write protocol covers the capture too.

The quote schema currently stores PT identity, without a pinned technical version. Resolve the current version/gamme using the canonical dossier selection, retaining only that version's purchases and operations. Legacy unversioned data is used only when no versioned dossier exists. Purchases use the line quantity; operation estimates reuse the PT formula `(tp + tf_unit * quote_quantity) * coef * hourly_rate`, with its existing hour convention. An absent price/rate remains a missing cost, rather than disappearing. These are estimates, not verified accounting costs.

QUOTED uses immutable captured inputs. STANDARD continues to calculate current estimates. Sent quotes created before this feature are not backfilled from current PT data. A quote or revision entered already ENVOYE is marked RECORDED_SENT: historical costs remain unknown. Draft QUOTED remains a preview. A requested observation date before capture cannot use future frozen data.

## Boundaries

Captures are internal; the client-facing GED/PDF snapshot contains no additional cost data. Margin read/export RBAC is unchanged. The database guard verifies the sent quote revision and line ownership, and prevents updates/deletes. Captured commercial quotes remain retained even if later cancelled or refused. A new commercial revision captures independently and does not copy the previous quote's frozen costs.

This does not claim verified CUMP, invoice reconciliation, an approved commercial forecast, or costing of an unapproved technical draft. The capture records the observed canonical dossier and its estimation evidence. Missing categories and historic captures stay explicit.

## Migration, verification and recovery

Additive migration `20261008_quote_margin_source_snapshots_941.sql` with dependency ordering, preflight, ownership/sent-state trigger, verification and non-destructive rollback companion. Retain immutable captures. Before any new capture exists, the previous binary can be restored with the schema retained. After capture use, prefer a forward fix or the matching database/release recovery set; the older binary would reread current costs.

TypeScript and ten real SQL plans are compiled under cerp_app after additive DDL, entirely rolled back. Business cases are prepared using temporary fixtures: per-line quantity, obsolete dossier exclusion, missing rates, stable capture after PT update, idempotence and a posteriori entry. Execution is deferred to the final combined acceptance by explicit user instruction. Further final cases cover public QUOTED reads, new commercial revisions, immutable guards, legacy sent quotes, deletion refusal and client PDFs without internal costs.

WP-278, issue #941. Report sections 7/9/12/14/15/16; deployment/backup/health evidence is recorded separately and never substituted for business acceptance.
