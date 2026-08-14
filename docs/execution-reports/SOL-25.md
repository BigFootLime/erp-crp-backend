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

Les preuves de migration des bases réelles, de déploiement, de SHA et de santé
seront ajoutées après la fenêtre opérateur SOL-25. Les anciens patchs en attente
restent hors de cette fenêtre et doivent conserver leurs propres preflights.
