# SOL-12 — Intégration backend au contrôle de release

Date : 2026-08-11

Le runner canonique vit dans `crp-systems-web` et orchestre ce dépôt backend autoritaire. Ce dépôt fournit désormais un `pnpm typecheck` explicite et permet à `db:migrations:rehearse --report-dir <répertoire>` d'écrire ses preuves hors du worktree.

Cette option évite que la répétition SQL obligatoire modifie les rapports versionnés pendant un gate. La répétition continue de créer PostgreSQL en `tmpfs`, sauvegarder, appliquer, vérifier, rejouer à zéro, exercer le rollback test-only et restaurer dans une base neuve.

La répétition attend désormais le marqueur officiel de fin d'initialisation PostgreSQL puis deux réponses `pg_isready` consécutives. Cela élimine la course avec le serveur temporaire lancé par l'image pendant `initdb`, sans augmenter le timeout de 60 secondes. La fixture E2E charge aussi la famille canonique `PT` réellement utilisée par le frontend. Enfin, les erreurs PostgreSQL peuvent journaliser le nom de contrainte après validation stricte comme identifiant SQL ; aucune valeur, requête ou donnée personnelle n'est ajoutée aux logs.

Le lockfile force `nanoid@3.3.18` pour corriger l'avis transitif sans montée majeure. L'audit backend final retourne zéro vulnérabilité connue.

## Preuve finale intégrée

Le gate `test` a attesté `dev` backend `d8077b5f01fac99aadc2b7a6da371a9c1238868e` avec le frontend `53d0638ce80a3dd0b71d111c362745bf409acc2f`.

- typecheck et build backend : réussis ;
- 267 fichiers de tests réussis, 1 ignoré ; 4 446 tests réussis, 4 ignorés ;
- audit : zéro vulnérabilité connue ;
- répétition migrations : 5 patches appliqués, restauration réussie, rejeu idempotent ;
- E2E isolé : 63/63 scénarios réussis, dont les deux parcours métier SOL-05 ;
- manifeste global : 1 146 fichiers, SHA-256 `5488551b1ecb3c06c21ae9f47bd8a07eb711a8cb711486406cf36de56353519f`, vérifié.

Rapport canonique : `crp-systems-web/docs/execution-reports/SOL-12.md`. Preuve d'exécution locale : `test-results/release-gate/20260811T153143Z-test-53d0638c-d8077b5f/` dans le checkout de validation frontend.

## Données, risques et rollback

SOL-12 n'ajoute aucune migration et n'écrit dans aucune base persistante. La famille `PT` est une fixture strictement limitée à la base jetable E2E. Le seul risque opérationnel nouveau est qu'une release auparavant tolérée soit désormais bloquée ; c'est le comportement voulu.

Rollback code : redéployer les artefacts précédents par SHA. Rollback de données : restaurer la sauvegarde vérifiée dans une base neuve sous approbation humaine. Revenir sur les commits SOL-12 supprimerait le contrôle mais ne modifierait aucun schéma ni donnée.

Reste identifié : le dépôt backend n'a pas encore de lint autoritaire ; l'exception est explicite et typecheck, tests et build restent bloquants.
