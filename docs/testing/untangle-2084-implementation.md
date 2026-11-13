# Maintenance de la baseline CERP 2.0.84

Tâche locale proposée : `UNTANGLE-2084-BASELINE-20261113`. Le lot reste local, sans déploiement, migration, changement de service ni publication.

Les deux tests de création de sous-état de `src/__tests__/stock.routes.test.ts` conservent leurs cas et vérifient désormais la cinquième valeur SQL `informations`. Le cas renseigné contrôle le texte multiligne dans la réponse et les paramètres SQL ; le cas code seul vérifie `NULL`. Ces tests simulés ne prouvent pas une persistance en base réelle.

La référence applicative backend est `9f1153d858f8bf27f666946f41866b77cdc21cf3`, suivie du HEAD documentaire `dfeb995b`. La référence de la paire source et des artefacts connus est maintenue dans le dépôt frontend, sous `docs/release/baselines/2.0.84.json`, avec le vérificateur en lecture seule `scripts/release/verify-baseline.mjs` et le rapport `docs/testing/untangle-2084-implementation.md`.

La provenance de la livraison historique reste celle de [l’assemblage du 12 novembre](../operational-provenance/2026-11-12-substate-informations.md). Le paquet d’overlay ne permet pas de certifier tous les fichiers des runtimes déployés. Aucun contrat workflow n’est régénéré avant accord sur le candidat backend complet de consolidation.
