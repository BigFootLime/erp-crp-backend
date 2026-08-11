# SOL-06 — Fiabiliser migrations et données de référence

Date d'exécution : 2026-08-10

Branche de travail : `fix/sol-06-migration-reliability`

Statut : **code fusionné ; décision CUMP enregistrée sur les deux bases ; gate SOL-06 non activé tant que calendriers et taux réels manquent**

## Diagnostic et cause racine

Le backend disposait d'un registre de patches et d'un runner fiable, mais pas d'une frontière de release unique prouvant sauvegarde, prérequis, intégrité, rejeu et restauration. Les flux stock, planning et production consommaient en outre des référentiels indispensables sans contrat commun : rôles, statuts, unités, emplacements, calendrier, taux de centres de frais et méthode de valorisation pouvaient manquer jusqu'à une erreur métier tardive.

La cause racine est donc double : contrôles opérateur dispersés et absence de gate de prérequis au plus près des écritures sensibles. La politique de valorisation est une décision de gestion ; la migration ne pouvait pas lui attribuer une valeur arbitraire.

## Choix d'architecture

- Un gate Node unique inventorie les patches, exécute le preflight en lecture seule, contrôle l'intégrité et orchestre une répétition Docker jetable.
- Le patch `20260810_system_reference_data_readiness.sql` est additif et transactionnel. Il enrichit `erp_settings` avec définition, unité, période, source, fraîcheur et fiabilité.
- `fn_business_prerequisite_status(flow)` expose des contrôles actionnables. Trois triggers refusent les écritures stock, OF et planning avec le SQLSTATE dédié `P2606` si un prérequis manque.
- L'API ne traduit en HTTP 409 que le JSON `P2606` strictement validé ; aucun détail SQL arbitraire n'est renvoyé.
- La migration importe une décision de valorisation déjà présente dans `value_json`, mais n'en invente jamais. La fixture `TEST_ONLY` est confinée à `cerp_test`.
- Le rollback d'exploitation est une restauration vers une base neuve. Le SQL inverse est volontairement gardé à `cerp_test` et à `cerp.migration_rehearsal=on`.

## Fichiers modifiés

- Migration et contrats : `db/patches/20260810_system_reference_data_readiness.sql` et les fichiers `.preflight.sql`, `.verify.sql`, `.rollback.sql` associés.
- Gate : `scripts/migrations/release-gate.js` et scripts `db:migrations:*` de `package.json`.
- E2E isolé : `scripts/e2e/migrate-isolated.js`, `scripts/e2e/seed-isolated.js`.
- API : `src/middlewares/errorHandler.ts`.
- Tests : `src/__tests__/migration-release-gate-sol06.test.ts`, `src/__tests__/errorHandler.test.ts`.
- Documentation : `docs/database-patches.md`, inventaire, répétition, exceptions, runbook et ce rapport.

## Migrations et changements de données

- 140 patches exécutables inventoriés, dont 82 depuis le 2026-07-01 ; 211 fichiers auxiliaires.
- Ajout de sept colonnes de provenance à `erp_settings`.
- Mise à jour conditionnelle d'au plus une ligne `stock.valuation_method`, uniquement si sa décision existe déjà dans le JSON.
- Création de deux fonctions et trois triggers de validation.
- Aucun seed d'exploitation et aucune valeur décisionnelle simulée en production.
- En test seulement : calendrier, taux, rôles, emplacements et méthode de valorisation déterministes.

## Preuves migration, restauration et intégrité

Commande : `pnpm db:migrations:rehearse`.

- PostgreSQL épinglé par digest, loopback uniquement, données en tmpfs et conteneur détruit en sortie.
- Base précédente reconstruite avec 139 patches, puis seed déterministe.
- Source : 36 199 447 octets ; dump : 1 954 131 octets ; SHA-256 vérifié.
- Migration SOL-06 : 160 ms ; rejeu : 0 patch en 135 ms.
- 364 tables et 1 057 clés étrangères contrôlées ; zéro orphelin et zéro FK invalide.
- Les 13 prérequis STOCK/PLANNING/PRODUCTION sont prêts après migration.
- Cas négatif : refus `P2606` démontré en 40 ms.
- Rollback SQL test-only démontré en 22 ms.
- Restauration vers une base neuve en 4 085 ms ; comptages identiques et empreinte source/restaurée identique `34a2f805c9ea33c785a7e36f5f5bb8666396dd457823cae8cf7b05ebf762ed79`.

Rapport machine et humain : `docs/release/MIGRATION_REHEARSAL_SOL_06.json` et `.md`.

## Tests exécutés

| Vérification | Résultat réel |
|---|---|
| Tests ciblés gate + middleware | 36/36 réussis |
| Suite backend complète `pnpm test:run` | 879/879 fichiers réussis ; 4 393 tests réussis, 4 en attente, 0 échec |
| Build/typecheck backend `pnpm build` | réussi |
| Inventaire `pnpm db:migrations:inventory` | 140 patches, 211 supports, SHA et ordre publiés |
| Répétition `pnpm db:migrations:rehearse` | réussie, rollback et restauration inclus |
| Suite frontend Vitest | 263/263 fichiers, 2 389/2 389 tests réussis |
| Typecheck, lint frontend, architecture, docs, build Vite | réussis ; seuls les avertissements connus de taille de chunks subsistent |
| Playwright isolé final, 1 worker, 0 retry | 61/61 scénarios réussis en 6,6 min |

## Vérification navigateur/E2E

La commande frontend `node scripts/e2e/run-isolated.mjs --workers=1 --retries=0` a recréé backend, frontend, PostgreSQL et fixtures avant d'exécuter les 61 scénarios. Les parcours vente → commande → analyse → OF → planning → production → livraison → facture et achat → commande fournisseur → réception → contrôle → stock sont réussis. Les scénarios d'inscription désactivée, routes privées et panneau d'administration sont également réussis.

La première exécution globale avait isolé un défaut clavier hors migration : après vingt tabulations, `Escape` ne fermait pas toujours le dialogue Article vierge. La fermeture propre est désormais explicitement déléguée au propriétaire du dialogue ; le fichier ciblé passe 11/11 et la suite finale 61/61 sans timeout ni retry.

## Risques et compatibilité

- `ALTER TABLE erp_settings` prend un verrou `ACCESS EXCLUSIVE` bref ; la répétition mesure 160 ms sur 36 MB, pas sur la volumétrie de production.
- Dix contraintes `CHECK NOT VALID` historiques restent visibles. Aucune FK invalide n'est tolérée.
- Vingt-cinq patches récents n'ont pas encore un triplet auxiliaire complet. Le contrôle global de l'état final est actif, mais la dette est listée dans `MIGRATION_EXCEPTIONS_SOL_06.md`.
- Le backend reste compatible avec le frontend précédent. Une action sensible reçoit désormais un HTTP 409 actionnable si le référentiel est incomplet.
- L'ajout de colonnes, fonctions et triggers n'est pas destructif ; une ancienne version applicative ignore les nouvelles colonnes.

## Rollback opérateur

1. conserver l'ancien artefact backend/frontend et placer l'API en maintenance ;
2. restaurer le dump vérifié dans une base neuve ;
3. exécuter intégrité, comptages et comparaison d'empreinte ;
4. basculer `DATABASE_URL` vers la base restaurée ;
5. redéployer les artefacts précédents ;
6. conserver la base échouée en lecture seule.

La procédure exacte est dans `docs/runbooks/database-upgrade-sol06.md`. Le fichier `.rollback.sql` ne doit jamais être utilisé comme rollback principal de production.

## Éléments restant réellement à faire

- Avant toute production : répéter sur une copie de staging anonymisée représentative de la volumétrie et fixer la fenêtre de verrou.
- Traiter les 25 contrats historiques manquants et les 10 `CHECK NOT VALID` selon les propriétaires/échéances de `MIGRATION_EXCEPTIONS_SOL_06.md`.
- Créer puis faire valider les calendriers de production et les taux horaires réels des centres de coûts ; ces données ne doivent pas être inventées par une migration.
- Activer ensuite le patch SOL-06 et ses triggers sur les deux bases avec un nouveau preflight.

## Validation métier et application contrôlée du 11/08/2026

Keenan Martin a validé la méthode CUMP. La valeur canonique enregistrée est
`WEIGHTED_AVERAGE`, définie comme le coût moyen pondéré recalculé à chaque
réception valorisée ; les sorties de stock et consommations d'OF utilisent le
coût moyen courant. Provenance : « Décision dirigeant Keenan Martin — validation
de release SOL-06 du 2026-08-11 », période à compter du 11/08/2026, fraîcheur
11/08/2026, fiabilité `DECLARED`.

La décision a été écrite de façon idempotente dans `cerp_test` et `cerp_prod`
après sauvegarde complète et répétition sur deux restaurations jetables. Le patch
`20260810_system_reference_data_readiness.sql` n'a volontairement pas été
appliqué aux bases actives : le preflight réaliste prouve l'absence de
calendriers de production actifs et de centres de coûts/taux horaires actifs ;
le schéma réel des magasins/emplacements ne porte pas encore le contrat
`is_active` attendu. Activer les triggers dans cet état bloquerait des flux
métier légitimes. Cette retenue est un gate de sécurité, pas un échec de
migration.

Sauvegardes opérateur avant écriture :

- `cerp_test_pre_sol11_20260811-120450.dump`, 72 779 738 octets, SHA-256
  `05844614cac0e3ac7e81bc11735aa9e70f80ab3cbc46a8655660fe6751ef1373` ;
- `cerp_prod_pre_sol11_20260811-120450.dump`, 49 314 521 octets, SHA-256
  `9c35b2a3eb80390a74a19c06e80d7967333066d4a024215fb8024feef28220a7`.

Les deux dumps ont passé `pg_restore --list`, ont été restaurés dans des bases
neuves, migrés, vérifiés, puis la restauration production a été refaite depuis
le dump original avant le second passage. Les unités canoniques `u`, `mm`, `m`
et `kg` sont présentes sur les deux bases actives ; la réparation du drift de
l'unité `u` et la réparation du schéma de provisioning sont enregistrées dans le
ledger avec empreintes immuables.
