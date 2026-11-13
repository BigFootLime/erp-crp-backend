# Manufactured client article defaults — #1058

Project Office: FLUX-20261009-08 / WP-285; full recipe #1035.

The canonical client article created from a technical piece must be sellable, measured in the canonical unit `u`, and traceable by lot. Previously the creation payload omitted those fields. A validated article was therefore absent from the contract picker, which requires `is_sold` and a matching unit.

Scope: the creation branch of `createOrLinkArticleFabrique` only. Existing article links remain idempotent and are not rewritten. Validation, client scope and API shape remain unchanged. No migration or automatic historical correction.

Verification: `piece-article-creation.test.ts` covers the payload and existing-link behavior; `article-unit-stock-contract.test.ts` covers stock unit compatibility. Sixteen targeted checks passed locally, as did TypeScript. Build and immutable release checks are recorded in the recipe release proof; end-to-end manufacturing remains in progress.

Test fixture replay: the recipe article was repaired through its existing editor with unit `u`, sales enabled and a synthetic price. It then appeared in the contract, and RF261009-CADRE-ALPHA was saved with a 20-unit replenishment batch. New-article creation must be replayed after deployment before closing the finding.
