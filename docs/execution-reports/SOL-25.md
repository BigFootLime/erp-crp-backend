# SOL-25 — Administration, RBAC, notifications et import (backend)

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue : [#468](https://github.com/BigFootLime/erp-crp-backend/issues/468)
- Branche : `feature/468-sol25-admin-operations`
- Base initiale : `origin/main` (`2ab49797527dfb3250838740f8ea69cb71c42aa8`)
- ADR : `docs/adr/ADR-0071-admin-access-notification-import-boundary.md`

## Diagnostic et cause racine

La tour d'accès permettait l'administration courante des droits, mais pas une
revue périodique traçable. Les notifications ne portaient ni entité métier
normalisée, ni état de traitement, ni expiration ou temporisation. L'assistant
d'import conservait bien son pipeline staging → validation → dry-run → commit,
mais ne fournissait pas les mesures de volume, progression, durée et erreurs
nécessaires au pilotage.

Une régression transactionnelle réelle a aussi été isolée : l'enrichissement des
notifications était transmis tel quel au bus temps réel historique, dont le
contrat v1 refuse toute clé supplémentaire. Le rejet
`INVALID_REALTIME_EVENT_INPUT` annulait la transaction de planning ou de
commande. La frontière temps réel projette désormais explicitement le payload
v1 au lieu de propager les nouveaux champs.

## Architecture livrée

- snapshots de revue d'accès périodique, non destructifs et réservés aux
  superadministrateurs ;
- signaux privilégié, inactif, bloqué, rafale d'échecs de connexion et accès
  exceptionnel, avec décision humaine auditée ;
- un seul cycle ouvert, création et décisions idempotentes, fermeture refusée
  tant qu'une décision reste en attente ;
- notifications liées à une entité, action interne, module, expiration, sourdine
  et escalade ; action supprimée côté serveur si le droit ne peut pas être prouvé ;
- métriques d'import sourcées : entonnoir, durée et Pareto d'erreurs, sans
  écriture ni assimilation d'une donnée absente à zéro ;
- neutralisation des formules CSV commençant par `=`, `+`, `-` ou `@`.

Aucune revue ne désactive un compte ou ne révoque un droit automatiquement.

## Migration et données

Le patch additif `20260814_admin_operations_sol25.sql`, SHA-256
`741a16b710835f4bc05dcac52c7ba5ceb74504c962bfe4307805d2071142d3f3`,
ajoute les cycles et éléments de revue, puis enrichit les notifications. Il
préserve les anciennes lignes et ne crée ni utilisateur, ni rôle, ni décision.
Un preflight, une validation post-migration et un rollback protégé accompagnent
le patch. Le rollback destructif exige explicitement
`cerp.allow_destructive_rollback=on` ; en exploitation, le retour applicatif
conserve le schéma additif.

La répétition PostgreSQL 16 jetable a appliqué 156 patchs et vérifié zéro patch
en attente ou checksum divergent. Le dump de 1 968 424 octets, SHA-256
`032b963c8f078e0aa5b30304dbee2004d083c97c950c452e3968687a9fbe53b0`,
a été restauré dans une base neuve ; les empreintes source et restaurée sont
identiques (`73d3223f43345a6dff0877afb4ae30e5ccf531227789d08548fe61f58dea85f5`).
Le rejeu a appliqué zéro patch.

## Promotion, migration réelle et déploiement

Le commit fonctionnel backend `68b77a4bb90962e0b3d2872f37eb33598687e4f0`
a été fusionné dans `dev` par la PR `#469`, puis dans `main` par la PR `#470`.
Les SHA issus de ces promotions sont respectivement
`be864e50b36d4f06d441b4aa3cadd90651c58c1e` et
`2892253bcc7a882487943664b58280edd484f9bd`.

Avant toute écriture réelle, deux dumps PostgreSQL custom ont été produits sur
HYPERBOX2, inventoriés par `pg_restore -l` et protégés en `0600 root:root` :

| Base | Dump | Taille | SHA-256 |
|---|---|---:|---|
| `cerp_test` | `/var/backups/cerp/cerp_test_pre_sol25_20260814-134046.dump` | 72 949 827 octets | `207851f88ff8cf77a400a3fc481716d3feeb20f13c1a4b369c991092a8aaea61` |
| `cerp_prod` | `/var/backups/cerp/cerp_prod_pre_sol25_20260814-134046.dump` | 49 458 084 octets | `c991d3fedc2c9eab4caa2d14f308968a6410900225f56538ddfb059e40d60507` |

Le preflight a détecté que `cerp_prod` n'avait pas encore le staging
`20260726_import_assistant_167.sql`. Ce prérequis additif a été sélectionné seul,
avec le SHA-256 vérifié
`2527f82ac3e816b3b1289d8a5ba11d4d77ed4532ff369c76ebcd13ef8f57689a` :
dry-run `1`, application `1`, contrôle post-migration entièrement vrai et
registre final `applied=1 pending=0 checksum-mismatch=0` pour cette sélection.

Le patch SOL-25 a ensuite été appliqué par sélection immuable, d'abord sur
`cerp_test` en `0,08 s`, puis sur `cerp_prod` en `0,09 s`. Les deux registres le
marquent `applied`, sans checksum divergent. La vérification post-migration
confirme l'intégrité des décisions, au plus un cycle ouvert et les couples
entité/identifiant des notifications.

HYPERBOX2 exécute l'artefact immuable
`/srv/cerp/releases/20260814-2892253b` sur les services test et production. Les
deux endpoints `live` et `ready` renvoient le SHA exact ; PostgreSQL, GED,
ClamAV et temps réel sont `up`, et les routes revue d'accès et métriques import
refusent l'anonyme en HTTP `401`.

Sur Coolify, le premier déploiement `x3y783wfvcrjo0msmh1ikdla` a été rollbacké :
le frontend et le backend construisaient simultanément, la charge hôte a dépassé
150 et les sondes ont expiré avant que ClamAV et le contrôle temps réel soient
prêts. Aucun timeout n'a été augmenté. Le retry backend isolé
`k2lv5faw2maqzxl0h6kstz0j` a terminé avec succès en utilisant la même image et
le même SHA. L'ancien conteneur a été retiré ; deux paires de contrôles publics
`live`/`ready` ont renvoyé exclusivement `2892253bcc7a882487943664b58280edd484f9bd`,
avec DB, GED, antivirus et temps réel `up`. Les routes sensibles refusent
l'anonyme en HTTP `401`.

## Tests exécutés

| Contrôle | Résultat |
|---|---|
| tests ciblés backend | PASS — 8 fichiers, 113 tests |
| typecheck backend | PASS |
| suite backend complète | PASS — 311 fichiers, 4 635 tests ; 4 tests optionnels ignorés |
| build + frontière données production | PASS — 683 fichiers runtime et émis |
| audit dépendances production | PASS — aucune vulnérabilité connue |
| répétition migration SOL-06 | PASS — backup, migration, vérification, rollback, restauration et rejeu |
| E2E Chromium isolé | PASS — 3/3, sans retry, 13,0 s |

L'E2E a créé PostgreSQL, appliqué 156 migrations, chargé huit comptes, construit
le frontend et démarré l'API. Il a prouvé la création et la décision de revue,
le rejeu idempotent, le refus d'un utilisateur standard et le contrat de
métriques d'import avec durées nulles quand aucun lot n'est terminé.

## Permissions, audit et compatibilité

Toutes les routes de revue exigent authentification et superadministration côté
API. Les opérations de notification restent limitées au destinataire. Les
métriques d'import conservent la frontière administrateur/directeur et la garde
`cerp_test`. Les journaux d'audit enregistrent l'acteur et la décision sans
copier le contenu des notifications ou des fichiers.

Le patch est compatible avec l'ancien binaire. La base ne possède pas encore de
dimension société/site cohérente sur ces objets ; aucune isolation inexistante
n'est revendiquée.

## Rollback

Suspendre les nouvelles mutations, redéployer le SHA backend précédent et
conserver les colonnes/tables additives. Si une restauration de schéma est
indispensable, restaurer le dump pré-SOL-25 correspondant dans une base neuve,
démarrer l'ancien SHA, puis contrôler authentification, rôles, notifications,
imports, contraintes et comptages. Ne jamais exécuter le rollback destructif en
place sur la production.

## Reste réel

Les anciens patchs encore en attente sont indépendants de SOL-25 et conservent
leurs propres preflights et fenêtres opérateur. Le rollback physique du schéma
SOL-25 n'a volontairement pas été exécuté sur les bases réelles : la preuve de
restauration et de rollback a été réalisée dans l'environnement PostgreSQL
jetable, tandis que l'exploitation réelle conserve le schéma additif compatible.
