# Clôture après réception complète

Issue #1209, WP 287. Après retour, contrôle, emballage et transfert de quatre axes, BCF-2026-001277 devient RECUE. La clôture du dossier de sous-traitance restait refusée par une règle prévue pour les mouvements.

RECUE autorise désormais uniquement CLOSE pour un dossier SENT et une ligne ACTIVE de sous-traitance. Création, expédition, retour et annulation conservent les statuts antérieurs. Solde matière nul, traitement de réception terminé, version concurrente et audit restent obligatoires.

Validation : matrice de statuts, garde de réception, compilation et reprise normale de la clôture sur Base Test. Aucune migration.
