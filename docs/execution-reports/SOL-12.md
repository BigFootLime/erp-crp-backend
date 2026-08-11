# SOL-12 — Intégration backend au contrôle de release

Date : 2026-08-11

Le runner canonique vit dans `crp-systems-web` et orchestre ce dépôt backend autoritaire. Ce dépôt fournit désormais un `pnpm typecheck` explicite et permet à `db:migrations:rehearse --report-dir <répertoire>` d'écrire ses preuves hors du worktree.

Cette option évite que la répétition SQL obligatoire modifie les rapports versionnés pendant un gate. La répétition continue de créer PostgreSQL en `tmpfs`, sauvegarder, appliquer, vérifier, rejouer à zéro, exercer le rollback test-only et restaurer dans une base neuve.

Tests ciblés avant intégration : `src/__tests__/migration-release-gate-sol06.test.ts`, 7/7 réussis ; `pnpm typecheck`, réussi. Les résultats complets seront consignés dans le rapport SOL-12 frontend produit par la commande unifiée.

Rollback : revenir sur ce commit remet l'écriture des rapports dans `docs/release`; aucun schéma ni donnée n'est modifié par ce changement.
