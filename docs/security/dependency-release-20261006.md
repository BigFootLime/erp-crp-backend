# Dépendances de release — 6 octobre 2026 (#813)

Le contrôle test du lot OF complet a relevé 9 avis élevés et 3 critiques dans le lockfile backend. Les correctifs bornés concernent fast-uri, brace-expansion, Engine.IO, source-map-js, proxy-addr et Tinypool. Les overrides npm et pnpm sont alignés ; Docker utilise npm ci et doit recevoir les mêmes correctifs que les contrôles pnpm. Le package-lock est régénéré sans exécuter de scripts d'installation.

## Lancement en développement

L'avis braces annonce une version 3.0.4 qui n'est pas publiée sur npm à la date du contrôle. Le seul chemin atteint est ts-node-dev → chokidar → braces. ts-node-dev est remplacé par le mode watch natif de Node et la **même version ts-node 10.9.2 déjà utilisée**, maintenant déclarée directement. Le démarrage reste transpile-only : npm run dev utilise node --watch --require ts-node/register/transpile-only src/index.ts. Le build TypeScript strict et le démarrage production node dist/index.js restent inchangés.

Les deux lanceurs de fixtures qui cherchaient ts-node dans ts-node-dev utilisent maintenant la dépendance directe. Aucune variable, base ou donnée de production n'est utilisée pour les essais isolés.

## Compatibilité du pool de tests

Tinypool est verrouillé à 2.1.2, qui corrige les gadgets de pollution du prototype. Le changement de majeure 2 abandonne Node 18 ; CERP utilise Node 24. La collection locale conserve 514 fichiers de tests. Les suites et le contrôle de release doivent confirmer la compatibilité avec Vitest 3.2.7 ; aucun test n'est retiré et aucune erreur n'est ignorée.

## Mesures locales

- pnpm audit --audit-level high : 0 critique / 0 élevée, 7 modérées.
- npm audit --audit-level high : 0 critique / 0 élevée, 10 modérées (nouvelle interrogation après génération du lockfile).
- Collection : 514 fichiers ; typecheck réussi.
- Le premier passage des tests a détecté le package-lock npm périmé ; celui-ci est synchronisé et les 8 tests de contrat Docker passent ensuite.
- Suite backend complète après synchronisation : 5852 tests réussis, zéro échec ; build production/OpenAPI réussi.
- Watch natif avec ts-node : lancement TypeScript et rechargement d'un module importé vérifiés, sans accès ERP/DB.
- Contrôle de release et mise en service : consulter les preuves de PR et les rapports de release ; aucun déploiement n'est attesté ici.

Les avis modérés restent visibles et les seuils de sécurité ne changent pas. Les versions sont reproductibles depuis les deux lockfiles. Aucun changement de schéma ou de données.

Références : [Tinypool 2.0](https://github.com/tinylibs/tinypool/releases/tag/v2.0.0), [Tinypool 2.1.2](https://github.com/tinylibs/tinypool/releases/tag/v2.1.2), [mode watch Node](https://nodejs.org/docs/latest-v24.x/api/cli.html#--watch).
