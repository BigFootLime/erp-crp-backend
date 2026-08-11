# SOL-06 — Déploiement du centre de préparation production

Date d'exécution : 2026-08-11  
Responsable technique : Codex / Keenan Martin  
Décision métier liée : valorisation **CUMP** (`WEIGHTED_AVERAGE`), source « Décision dirigeant Keenan Martin — validation de release SOL-06 du 2026-08-11 », fiabilité `DECLARED`.

## Résultat

Le centre de préparation production est opérationnel sur `cerp_test`. Il signale sans les inventer les deux données encore manquantes :

- un calendrier de production réel et actif ;
- au moins un centre de frais actif avec un taux horaire positif, daté et sourcé.

La création ou le passage d'un OF dans un état de production reste protégé côté base par le SQLSTATE `P2606` tant que ces prérequis ne sont pas satisfaits. L'interface affiche la définition, l'unité, la période, la source, la fraîcheur, la fiabilité et une action directe vers la page de saisie.

`cerp_prod` n'a reçu **aucune écriture** pendant cette exécution, conformément à SOL-00. Le code final est déployé, mais le gate SQL de production attend une fenêtre opérateur explicitement autorisée.

## Diagnostic et cause racine

Le premier preflight terrain a échoué avant écriture car le patch utilisait `warehouses.is_active` et `locations.is_active`. Ces colonnes existaient dans le bootstrap E2E mais pas dans les schémas PostgreSQL réels. La répétition isolée avait donc validé un schéma artificiellement divergent.

Un second défaut a été identifié avant l'application : la vérification post-migration exigeait que les calendriers et taux soient déjà renseignés. Cela empêchait d'installer le mécanisme précisément chargé de guider leur saisie.

Corrections :

- alignement du bootstrap et du seed E2E sur les colonnes terrain ;
- suppression des références aux deux colonnes inexistantes ;
- absence de chaîne stock et absence de données de production transformées en constats métier, pas en blocage d'installation ;
- post-vérification centrée sur la présence des fonctions, triggers et contrôles guidés ;
- mise à jour du checksum LF immuable du patch modifié avant toute application réelle.

## Choix d'architecture

- Le gate demeure en base, donc il ne dépend pas seulement du frontend.
- L'API fournit un état structuré ; l'interface ne déduit ni horaire ni tarif.
- Les données déclarées par l'utilisateur restent `DECLARED`, les contrôles système restent `VERIFIED`.
- Les deux patches sont sélectionnés avec `--only`, sous verrou advisory et transaction incluant l'inscription dans `cerp_schema_migrations`. Les quinze anciens patches encore en attente sur `cerp_test` n'ont pas été appliqués implicitement.
- HYPERBOX2 utilise une release immuable séparée des anciens worktrees sales. Aucun fichier dormant n'a été écrasé.

## Fichiers modifiés

- `db/e2e/legacy-bootstrap.sql`
- `db/patches/20260810_system_reference_data_readiness.sql`
- `db/patches/support/20260810_system_reference_data_readiness.preflight.sql`
- `db/patches/support/20260810_system_reference_data_readiness.verify.sql`
- `scripts/db-patches.js`
- `scripts/e2e/seed-isolated.js`
- `src/__tests__/db-patches.runner.test.ts`
- `src/__tests__/migration-release-gate-sol06.test.ts`
- `docs/release/MIGRATION_REHEARSAL_SOL_06.json`
- `docs/release/MIGRATION_REHEARSAL_SOL_06.md`

## Git et promotion

- Correctif : `b180d69`, PR `#393` vers `dev`, puis PR `#394` vers `main`.
- Vérification guidée : `810822b`, PR `#395` vers `dev`, puis PR `#396` vers `main`.
- Backend après promotion fonctionnelle : `main=49765cc`, `dev=2a56265`, arbres identiques `a6c6784c5625e13be516476cf414f57298a2a4d9`.
- Le commit qui ajoute ce rapport est une promotion documentaire ultérieure : il ne modifie pas l'artefact applicatif fonctionnel ci-dessus.
- Frontend : `main=f73cc12`, `dev=846b3b0`, arbres identiques ; la release frontend contient SOL-06 et le suivi SOL-03.

Les modifications non commitées des anciens arbres locaux et HYPERBOX2 ont été préservées. Les services ne démarrent plus depuis ces arbres, mais depuis `/srv/cerp/releases/<date>-<sha>`.

## Migrations et données

### `cerp_test` — appliqué

Sauvegarde préalable :

- fichier : `/var/backups/cerp/cerp_test_pre_sol06_readiness_20260811-144908.dump` ;
- taille : `72 810 916` octets ;
- SHA-256 : `17229cd0cbfa9129d028f52a7a266274a7b40488e4fdc3b3e6a26116f01ee812` ;
- catalogue `pg_restore` : `4 204` entrées.

Patches inscrits atomiquement :

- `20260810_system_reference_data_readiness.sql` — `8a6bfa740ddc6e80f7b19ace948a92df379cc0df097879e9f5d125758a9f8eec` ;
- `20260811_production_readiness_center.sql` — `2657f0f1eeca1a708a32ec41ae4c2a9eb2755df074d0a7984ccebcfce6b2dde5`.

Post-vérification : fonctions v1/v2 présentes, trigger production actif, cinq contrôles retournés. Trois sont prêts ; calendrier et taux horaires sont explicitement non prêts. Aucun calendrier, centre de frais ou taux n'a été créé automatiquement.

La sauvegarde a été restaurée dans la base temporaire `cerp_restore_verify_sol06_20260811` : registre à `129` patches et fonctions SOL-06 absentes, comme à l'instant de sauvegarde. La base temporaire a ensuite été supprimée.

### `cerp_prod` — non appliqué

Preflight lecture seule réussi : PostgreSQL `17.10`, quatre unités canoniques, quatre warehouses, zéro location, zéro calendrier, zéro centre de frais, politique CUMP complète, trente-trois rôles actifs.

État post-exécution : fonctions SOL-06 absentes, trigger absent, aucune ligne SOL-06 dans le registre. Il ne s'agit pas d'un oubli : SOL-00 interdit l'écriture de production par l'agent.

## Tests exécutés

- `pnpm run build` : réussi ; frontière données de production validée sur `633` fichiers source et `633` fichiers émis.
- `pnpm exec vitest run src/__tests__/migration-release-gate-sol06.test.ts src/__tests__/db-patches.runner.test.ts src/__tests__/production-readiness-543.test.ts` : `3` fichiers, `37` tests réussis.
- `pnpm run test:run` : réussi, `267` fichiers et `4 443` tests attendus après ajout du nouveau contrat.
- `pnpm run db:migrations:rehearse` : réussi sur PostgreSQL jetable ; sauvegarde, cinq patches, rejeu à zéro, refus négatif `P2606`, rollback test-only et restauration avec empreinte identique.
- Preflight réel en lecture seule : réussi sur `cerp_test` et `cerp_prod`.
- Restore HYPERBOX2 de la sauvegarde pré-patch : réussi dans une base temporaire puis détruite.

Deux tentatives de répétition isolée ont été interrompues pendant le bootstrap par une reconnexion du moteur Docker. Aucune assertion SQL n'avait alors échoué et les conteneurs ont été supprimés. Les répétitions exécutées seules ont ensuite réussi sans hausse de timeout ni assouplissement.

## Déploiement et vérification navigateur

- Coolify frontend : release `f73cc12683d6f410009d29244e3a5ec11ace227e`, healthcheck réussi, SHA présent dans le bundle public.
- Coolify backend : release fonctionnelle `49765ccc6e4873763b8c81b70a3d9d7138d052e8`, `/health/live` et `/health/ready` à `200`; DB, GED, antivirus et realtime à `up` avec mesures.
- HYPERBOX2 `cerp-api.service` et `cerp-api-test.service` : release `49765cc`, version complète exposée, liveness/readiness réussies, route protégée à `401` sans JWT.
- Navigateur authentifié sur `cerp_test` : page « Préparation de la production » chargée, deux prérequis manquants affichés, aucune erreur 404.
- Action « Configurer les calendriers » : page vide actionnable avec bouton « Créer le premier calendrier ».
- Action « Renseigner les taux horaires » : page vide actionnable avec bouton « Nouveau centre de frais ».

## Risques et compatibilité

- **P0 avant activation réelle de production** : appliquer les deux patches sur `cerp_prod` dans une fenêtre autorisée, après sauvegarde et preflight. Sans cela, la protection `P2606` n'existe pas dans la base de production et l'écran de préparation production ne peut pas fournir son état complet pour cette base.
- **P0 sécurité** : un ancien build Coolify backend a rendu visibles des secrets de build dans un log avant annulation. L'injection de build args est désormais désactivée et le rebuild suivant ne les expose plus. Il reste à faire tourner les identifiants concernés, tester l'envoi mail, puis supprimer ou expirer l'ancien log selon la politique de rétention. Aucune valeur secrète n'est reproduite ici.
- **P1 migrations historiques** : `cerp_test` conserve quinze patches anciens hors SOL-06 en attente. Ils n'ont ni été masqués ni appliqués en bloc ; chacun nécessite sa propre classification et son preflight.
- Les tables terrain `warehouses` et `locations` n'ont pas de cycle actif/inactif. La disponibilité métier est donc définie par une chaîne cohérente vers un magasin et un emplacement actifs.

## Procédure opérateur `cerp_prod`

À exécuter uniquement après autorisation explicite d'écriture production :

1. vérifier que `main` et la release HYPERBOX2 pointent vers le même SHA ;
2. exécuter le preflight SOL-06 en lecture seule ;
3. créer un `pg_dump -Fc` de `cerp_prod`, calculer son SHA-256 et vérifier son catalogue avec `pg_restore -l` ;
4. exécuter `db-patches.js up --dry-run --only` puis `up --only` pour le patch `20260810`, lancer sa vérification ;
5. exécuter le preflight `20260811`, puis son dry-run, son application et sa vérification ;
6. contrôler le registre, les fonctions, les trois triggers, `/health/ready`, l'écran navigateur en contexte `cerp_prod` et un refus métier négatif ;
7. renseigner ensuite les calendriers et taux réels via l'interface ; ne jamais les insérer comme valeurs par défaut.

## Rollback

- Code HYPERBOX2 : supprimer uniquement le dernier drop-in `zzzzzzzzz-codex-release-<sha>.conf`, recharger systemd et redémarrer ; le drop-in précédent reprend automatiquement la release antérieure.
- Base `cerp_test` : arrêter les écritures, conserver une copie de l'état incident, restaurer le dump pré-SOL-06 validé, puis redémarrer et vérifier les comptages. Le rollback SQL fourni reste volontairement limité aux répétitions `cerp_test` avec `cerp.migration_rehearsal=on`.
- Base `cerp_prod` : après application future, le rollback réaliste est la restauration du dump validé et du point GED cohérent, pas un `DROP FUNCTION` improvisé.

## Reste réellement à faire

1. Obtenir une autorisation explicite de fenêtre de migration `cerp_prod`, puis suivre la procédure ci-dessus.
2. Saisir dans l'interface les calendriers, centres de frais et taux horaires réels pour chaque base concernée.
3. Faire tourner les secrets potentiellement exposés par l'ancien log Coolify et tester les services dépendants.
4. Auditer séparément les quinze patches historiques encore en attente sur `cerp_test`.
