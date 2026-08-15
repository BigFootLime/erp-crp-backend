# SOL-43 — Audit final de feu vert commercial (backend)

- Date de décision : 2026-08-15 (Europe/Paris)
- Propriétaire : Keenan Martin
- Candidat runtime contrôlé : frontend `15b4fee33764fe0e8da70c8e267e0cb5c0077608`, backend `74fdc333e55f14d43bcb48fac9ebc992881496ce`
- Release ID : `20260815T131043Z-production-15b4fee3-74fdc333`
- Verdict technique : **GO pour déploiement contrôlé**
- Verdict premier pilote payant : **NO-GO jusqu'à saisie et validation des trois prérequis métier P0**

## Diagnostic et corrections

Le gate final a d'abord détecté un test d'invitation portail dépendant de la date réelle. Son horloge est maintenant figée avec Vitest, sans timeout augmenté ni assertion assouplie.

L'exercice de restauration a révélé que `project_report_exports.file_path` est un nom logique tandis que le document est stocké inline dans `file_base64`. Le recovery set ne traite plus ce champ comme une référence GED externe : il décode, recompte les octets et vérifie cryptographiquement le checksum avant sauvegarde et après restauration. Les requêtes du collecteur sont sérialisées sur un même client PostgreSQL.

Sur HYPERBOX2, PostgreSQL s'est arrêté faute de droit de traversée pour `postgres` sur `/mnt/data/cerp`. L'ACL minimale `u:postgres:--x` a été restaurée, le cluster relancé et les API production/test contrôlées. L'origine du retrait de l'ACL n'est pas établie ; la cause immédiate est prouvée par le refus d'accès à `pg_control`.

## État base et migrations

- `cerp_prod` : 165/165 migrations canoniques, 0 en attente, 0 checksum divergent.
- `cerp_test` : 165/165 migrations canoniques plus
  `20260731_ged_fiches_360.sql`, patch historique externe connu ; checksum et
  artefacts `ged_entity_types`, `ged_entity_class_bindings`, fonction et trigger
  de garde vérifiés par le gate.
- Sauvegarde prod préflight : `/var/backups/cerp/cerp_prod_20260815-124145.dump`, 52 011 726 octets, SHA-256 `01a98f14c98b516628cfdf02d29e63e85be1c5a94cf73cf58cd564bc594ed34a`.
- Sauvegarde test préflight : `/var/backups/cerp/cerp_test_pre_sol43_20260815-124300.dump`, 73 159 079 octets, SHA-256 `e38a48f3e7c3b181cb3de8ba3508b01a06fd7d27248584315b575917e137eaa3`.
- La restauration de répétition et le rollback isolé du gate ont réussi.
- Onze contraintes `CHECK` restent `NOT VALID` ; aucune clé étrangère invalide n'a été détectée.

## Preuves obligatoires

| Exigence | Preuve au 2026-08-15 | Résultat |
|---|---|---|
| Aucun compte public | routes sensibles, RBAC négatif et E2E provisioning | PASS |
| Parcours vente complet | Playwright isolé parmi 139 scénarios | PASS |
| Parcours achat complet | Playwright isolé parmi 139 scénarios | PASS |
| Restauration réelle DB + documents | snapshot Restic `b0d2b0b8a049f300e8e68006c7dc64dd932a5174ab4f67352cc86b455fdcfdc7` | PASS |
| Données non simulées | garde production-data boundary | PASS |
| Coûts et marges qualifiés | contrats SOL-13 et données manquantes explicites | PASS |
| Migrations/rollback/environnement | gate SOL-12 et rehearsal isolé | PASS |
| Permissions négatives | suites auth, portail, admin, GED et E2E | PASS |
| Supervision/alertes/runbooks | 13 contrats runbooks, 17 liens alertes, 14 P0 | PASS |

## Résultats du contrôle de release

Commande autoritaire : `pnpm release:gate --target production --backend <backend-main>` depuis le dépôt frontend propre, associé explicitement à ce backend propre.

- Durée : 911,3 s, verdict `PASSED`.
- Backend : 343 fichiers réussis et 3 ignorés ; 4 775 tests réussis et 8 ignorés ; typecheck et build réussis.
- Frontend : 298 fichiers et 2 508 tests réussis ; typecheck, lint et build réussis.
- E2E : 139 scénarios Playwright réussis, minimum contractuel 54.
- Migrations : inventaire, application isolée, rollback et restauration réussis.
- Audit dépendances : aucune vulnérabilité backend ; aucune vulnérabilité élevée frontend de production.
- Manifeste d'intégrité : SHA-256 `91dccc71b4776ed19ad00f52690fb5e40b67038cd378eab7d7a74ab76a79360e`.

Artefact : `test-results/release-gate/20260815T131043Z-production-15b4fee3-74fdc333/` dans le worktree frontend de promotion.

La première sauvegarde hors site a duré 71 s et produit un snapshot de 50 159 299 octets, dépôt 47 762 979 octets, âge final 65 s. Sa restauration dans `cerp_restore_offsite_sol43` a duré 46 s et vérifié 464 tables publiques, 165 migrations, 18 utilisateurs, 6 exports inline et 35 596 106 octets, sans erreur ni FK invalide. La DB, le rôle et le chemin temporaires ont été supprimés par le trap.

Après correction du groupement de rétention, le snapshot réel
`6d822890a66c35e562ef83e794fda6ecbd38a6c6721fe1605322143ab1363e66`
a terminé en 68 s. Le résumé Restic, `last-backup.json` et le heartbeat portent
le même ID ; le contrôle du dépôt et le prune ont réussi.

## Sécurité et architecture de sauvegarde

- Rôle PostgreSQL dédié `cerp_backup`, non superutilisateur, membre de `pg_read_all_data` ; aucun élargissement du rôle applicatif.
- Dépôt Restic hors HYPERBOX2 via compte SFTP forcé et restreint.
- Clé de transport, empreinte hôte et mot de passe Restic séparés ; aucun secret dans Git ou le recovery set.
- Le timer `cerp-backup-full.timer` est actif. Le timer DB local reste actif ; les deux anciens timers GED incomplets sont désactivés.
- RPO cible 24 h et RTO cible 4 h ; exercice observé largement inférieur, sans extrapoler à un sinistre total.

## P0 résiduels et décision pilote

Trois valeurs métier réelles manquent encore dans `cerp_prod` et ne peuvent pas être inventées :

1. un calendrier actif de production ;
2. des centres de coûts actifs et leurs taux horaires datés ;
3. un emplacement actif rattaché à un magasin.

La valorisation CUMP est enregistrée comme décision déclarée de Keenan Martin du 2026-08-11. Les utilisateurs sont guidés vers `/administration/preparation-production` et `/administration/reference-data`. Le premier pilote payant reste **NO-GO** tant que le preflight métier n'est pas vert après leur saisie.

Le patch GED historique supplémentaire n'est pas appliqué à `cerp_prod` : le
code applicatif correspondant n'est pas dans la branche canonique `main` mais
dans une branche de sécurité dormante. Une application SQL seule créerait une
surface non prise en charge. Le gate le classe donc explicitement comme externe
connu sur `cerp_test`, refuse tout checksum différent et exige ses quatre preuves
de schéma.

## Risques acceptés

| Risque | Priorité | Propriétaire | Échéance / action |
|---|---:|---|---|
| Backend sans commande lint autoritaire | P2 | Keenan Martin | 2026-09-15 ; conserver typecheck/build bloquants |
| 11 contraintes `CHECK NOT VALID` | P2 | DBA / Keenan Martin | qualifier et valider avant le 2026-08-31 |
| `dpkg` incomplet sur HYPERBOX2 après échec DKMS VirtualBox 7.0.16 / noyau 7.0.0-28 | P1 exploitation | Keenan Martin | réparer avant toute activation du noyau ou redémarrage de l'hôte |
| Dépôt VPS avec environ 15,8 Go libres, plafond CERP 14 Go | P2 exploitation | Keenan Martin | alertes 90/95 %, revue mensuelle capacité/rétention |

## Fichiers modifiés dans la clôture

- `scripts/backup/recovery-set.mjs` : classification inline/externe, vérification checksum et requêtes sérialisées ;
- `src/__tests__/recovery-set-inline-documents.test.ts` : quatre régressions de recovery set ;
- `src/module/client-portal/services/client-portal.service.test.ts` : horloge déterministe ;
- ce rapport.

Les autres changements SOL/CLAUDE sont tracés dans leurs rapports et dans l'historique `main`.

## Rollback

1. Rebasculer HYPERBOX2 vers l'artefact backend précédent et restaurer son drop-in systemd exact.
2. Redéployer dans Coolify l'image précédente par digest/SHA, sans reconstruire une branche différente.
3. Pour une mutation de données, arrêter les writers et restaurer ensemble DB et GED depuis le snapshot explicite validé ; ne jamais improviser un rollback SQL destructif.
4. Vérifier migrations, comptages, contraintes, documents, live/ready, 401 sur route protégée et les deux parcours E2E avant réouverture.

## Reste réellement à faire

- saisir et approuver les trois prérequis métier P0 ;
- réparer DKMS/dpkg HYPERBOX2 avant redémarrage ;
- valider progressivement les 11 contraintes CHECK ;
- répéter périodiquement la restauration et la revue de capacité.
