# Consolidation material transfer — issue #844

Project Office: CERP / FLUX-METIER-20261006-L7 (WP272).

An OF consolidation with prepared, physically reserved material failed with PostgreSQL error `42P08`: the same parameter was inferred as both a numeric OF identifier and text for the generic reservation source. Both assignments now explicitly derive from a bigint identifier. The transfer remains in the consolidation transaction; existing reservations move once and their original owners remain in the transfer journal for dissolution. No schema change or relaxed material policy is required.

The isolated workbench fixture now prepares the MP needs through the canonical configuration and confirmation commands before consolidating. It creates 35 kg of released synthetic material for two demands of 10 and 20 plus a surplus of 5, with the canonical warehouse/location mapping and reception quality evidence. Existing finished-piece fixtures keep their defaults.

The regression checks concurrent replay, unchanged reservation identities, the producer OF/source/need references, and restoration of the original references on dissolution. The other receipt quarantine, physical stock and demand assertions remain active.

The latest prerequisite-only run reached the real transfer and exposed `42P08` (14 passed, 2 failed). Execution of the corrected suite and the combined acceptance is deferred to completion of the changes, as requested by the user. The deployment build must typecheck both repositories; final results belong in the combined recipe evidence, not in an invented green status.
