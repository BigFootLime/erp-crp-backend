# Dossier objective for anticipated contract OFs

The OF dossier reads the immutable replenishment target through the same adapter as central planning and the master plan. It preserves an earlier internal objective, leaves customer AR dates unchanged, and never derives the target from estimated finishes. The read uses the caller snapshot, keeps execution and committed slots unchanged, and does not alter the dossier completeness hash. No migration.

Acceptance: anticipated root/child/group ownership through the existing adapter; normal firm/internal orders; earlier internal due; missing migration; propagated read failure; valid COMPLETE dossier and existing source hash retained. Reproduce on Base Test contract RF261009-CADRE-ALPHA, OF95, target2026-09-30, then check both themes. Original past target remains visible.
