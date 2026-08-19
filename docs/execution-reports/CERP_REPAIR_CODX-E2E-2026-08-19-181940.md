# CERP-REPAIR-00 — Rapport d'exécution backend

- Date : 2026-08-19
- Audit de départ : `CODX-E2E-2026-08-19-181940`
- Issue : [#607](https://github.com/BigFootLime/erp-crp-backend/issues/607)
- Branche dédiée : `fix/607-e2e-audit-repair`
- Base de travail : `origin/dev` à `cbcd10c004dd2f9535249d7da641da00f4b1b0ef`
- Périmètre DB : PostgreSQL jetable isolé uniquement ; **aucune écriture dans `cerp_test` partagé ou `cerp_prod`**.
- Statut de release : **FINAL_FULL_E2E_PENDING**. Ce document n'est pas une autorisation de promotion `dev → main` ni de déploiement.

## Verdict intermédiaire

Les anomalies reproductibles de la campagne ont reçu une correction ciblée et une preuve ciblée réelle : clôture OF/réception, création de devis sous le rôle runtime, compatibilité machine/famille, durée de gamme, GED/ClamAV, sélecteurs de formulaires et idempotence. Les corrections sont commitées, sans secret et sans modification de données métier partagées.

Le verdict final reste volontairement en attente du runner E2E global propre : le périmètre comprend tous les scénarios, les migrations, le navigateur et les artefacts d'échec. Aucun scénario nominal ne doit être déclaré vert avant ce passage complet.

## Registre avant / après

| Audit | Cause racine démontrée | Correction livrée | Preuve ciblée | État |
|---|---|---|---|---|
| 001 GED/antivirus | Le scanner/ses signatures pouvaient être indisponibles ; la mort de `clamd` arrêtait auparavant l'API et masquait la quarantaine. | Démarrage ClamAV avec signatures rafraîchies, API maintenue en service dégradé, upload fail-closed, détails publics strictement limités à l'identifiant/état de quarantaine. | GED sain `2/2`, panne scanner `1/1`, 47 tests GED/sécurité, contrat Docker `12/12`. | Corrigé, campagne globale en attente. |
| 002 création devis | `cerp_app` n'avait pas les droits réels sur les relations de préparation/idempotence ; les tests mockés ne révélaient pas ce défaut. | Patch de droits minimaux, préflight/verify/rollback, refus sans clé idempotente avant écriture et erreurs métier. | PostgreSQL runtime : devis minimal/complet, retry même ID, pas de ligne partielle ; E2E Devis `2/2`. | Corrigé, campagne globale en attente. |
| 003 référentiels commerciaux | Les routes historiques n'étaient pas montées ; il n'existait pas de référentiel gouverné à inventer. | Routes authentifiées/RBAC, réponse explicite `NOT_CONFIGURED` avec fiabilité `UNAVAILABLE`. | Tests routes/référentiels et contrat OpenAPI ciblés. | Corrigé, campagne globale en attente. |
| 004 formulaires/combobox | Les chemins clavier/souris pouvaient diverger de la valeur réellement envoyée. | Alignement avec les contrats API et tests réels de persistance. | E2E réel `3/3` : client, fournisseur, article, machine/poste ; reload après sauvegarde. | Corrigé côté backend/intégration, campagne globale en attente. |
| 005 familles machine | L'éditeur refusait une machine non qualifiée mais l'auto-planificateur pouvait aller plus loin. | Invariant serveur commun : refus explicite `RESOURCE_NOT_QUALIFIED`, action de remédiation `/methodes/parc-machines`, aucune qualification inventée. | E2E réel `1/1` avec machine sans famille et tentative directe 422. | Corrigé ; données réelles à renseigner. |
| 006 complétude pièces | Données métier obligatoires absentes : ne pas les fabriquer. | Gates et parcours de remédiation ; création de la première révision rendue idempotente. | E2E pièce technique `1/1`. | Correction technique ; complétude réelle opérateur requise. |
| 007 doublon indice A | Création initiale déclenchée deux fois, non absence d'une règle DB à contourner. | Une seule création de révision initiale, tests de non-duplication. | E2E pièce technique `1/1` et tests ciblés. | Corrigé, campagne globale en attente. |
| 008–011 planning | Durée calculée/localement réinterprétée ; qualification, affectation et calendrier pouvaient diverger. | Durée canonique `réglage + quantité × temps unitaire`; validation de qualification dans toutes les écritures planning ; propagation de l'affectation/date depuis la source serveur. | Cas de référence `30 + 2 × 12 = 54 min`; groupe planning/méthodes `11/11`; clavier répété `30/30`. | Corrigé, campagne globale en attente. |
| 012 OF clôturé sans stock | `receipt-context` utilisait des colonnes magasins inexistantes (`42703`) et la clôture ne vérifiait pas les preuves de réception. | Transaction verrouillée, réception explicite/idempotente, clôture bloquée avec `409 OF_RECEIPT_INCOMPLETE` jusqu'à lot + mouvement `POSTED`. | Parcours production isolé : blocage, réception `201`, retry `200`, clôture `200`. | Corrigé, campagne globale en attente. |
| 013 boucle de réception | L'interface relançait durablement une erreur de contexte. | Contrat backend d'exception exploitable ; frontend corrigé dans le dépôt associé (pas de retry automatique durable). | Parcours OF/réception réel ci-dessus. | Corrigé inter-dépôts, campagne globale en attente. |
| 014 prérequis Qualité/Outillage | Référentiels et paramètres opérationnels réels manquants. | Gates, messages et liens de remédiation, sans zéro ou valeur synthétique. | Contrôles de préparation et parcours de remédiation ciblés. | Décision/données opérateur requises. |
| 015 route planning | Route historique non canonique. | Contrat backend/planning et redirection frontend associée vers `/production/planning`. | E2E responsive/planning réel `2/2`. | Corrigé inter-dépôts, campagne globale en attente. |
| 016 responsive | Risque de commandes inaccessibles selon largeur. | Backend : données et erreurs actionnables préservées ; validation frontend dédiée. | 375/430/538/768/1024/1440, responsive planning `2/2`. | Corrigé inter-dépôts, campagne globale en attente. |

## Diagnostic et architecture retenue

### Réception et clôture d'OF

Le contexte de réception échouait parce que la requête citait `magasins.code_magasin` et `magasins.libelle`, colonnes absentes du schéma courant. PostgreSQL résout toutes les références d'un `COALESCE` : le résultat était donc `42703`, exposé en 500. La transition `TERMINE → CLOTURE` ne liait pas suffisamment la production déclarée à la réception stock.

La clôture repose maintenant sur des preuves persistées : quantité bonne couverte par un reçu immuable, lot de sortie et mouvement d'entrée `POSTED`. La ressource OF est verrouillée pendant la transition. La réception est intentionnellement une commande séparée — emplacement et décision qualité ne sont pas déductibles — mais idempotente. Le résultat incomplet est explicite (`409 OF_RECEIPT_INCOMPLETE`), jamais un OF « clôturé » avec stock manquant.

### Devis, permissions et idempotence

Le correctif n'élargit pas les droits par confort. Le rôle `cerp_app` reçoit uniquement `SELECT/INSERT/DELETE` sur les lignes de préparation nécessaires et `SELECT/INSERT` sur le journal d'idempotence. Les lectures concurrentes sont sérialisées par verrou consultatif transactionnel, plutôt que `FOR SHARE`, afin de conserver un registre append-only et de ne pas requérir `UPDATE`.

Les routes de conditions de paiement et compte de vente ne prétendent plus fournir des données qui n'existent pas : elles indiquent `NOT_CONFIGURED`, avec source/période absentes et fiabilité `UNAVAILABLE`.

Le même principe append-only a été appliqué au registre de commandes achats et au portail client. Pour le portail, seule la transition réellement nécessaire de tentative d'authentification réussie reçoit `UPDATE`; le retry des commandes reste sérialisé par verrou consultatif sans mutation du reçu.

### Planning

La durée planifiée est une donnée serveur unique : `temps de réglage + quantité × temps unitaire`, donc 54 minutes pour le cas de référence. Auto-planification, déplacement manuel et validation interrogent le même invariant machine/famille. Une machine sans famille produit une erreur métier et une action de correction ; l'ERP ne déduit aucune famille machine réelle.

### GED et ClamAV

Les documents restent en quarantaine tant qu'un verdict propre n'est pas acquis. Un scanner indisponible ne publie aucun fichier : l'upload échoue de manière explicite, conserve l'état `scan_failed`/`quarantined` et n'expose ni contenu, ni chemin, ni sortie du scanner. L'API reste disponible, mais la readiness devient dégradée. Seuls un UUID de quarantaine valide et l'état `quarantined` peuvent être retournés dans ce cas, via une allowlist dédiée des détails 5xx.

L'image actualise les signatures au démarrage puis les maintient avec `freshclam`; elle conserve l'API comme processus de cycle de vie. La sortie de `clamd` est journalisée et reaped sans faire disparaître l'ERP, tandis que les nouveaux uploads continuent d'échouer fermement.

## Commits backend

| Commit | Objet |
|---|---|
| `bf19e54` | Blocage de clôture OF sans réception complète. |
| `cb51e26` | Qualification machine et durée/capacité planning. |
| `599ffbe` | Préparation Devis et idempotence. |
| `c723806` | Refresh des signatures ClamAV. |
| `5f98ae1` | Stack E2E Docker réellement isolée. |
| `d26936a` | Erreur GED de quarantaine actionnable, sans fuite. |
| `d5a1e50` | Idempotence commerciale append-only. |
| `d5beab3` | Remédiation qualification planning conservée. |
| `f724e37` | Idempotence achats append-only. |
| `f5dfa69` | Fixtures séparées machine qualifiée/non qualifiée. |
| `1387bd7` | API disponible et fail-closed durant panne scanner. |
| `b59089a` | Idempotence portail client append-only. |
| `1e6722f` | Droit portail minimal pour marquer la tentative réussie. |
| `3fdabdd` | Rollback explicite du patch de droit portail. |

## Fichiers backend principaux

- Production : `src/module/production/repository/production.repository.ts`, `src/module/production/repository/production-receipts.repository.ts`, `src/module/production/domain/planned-operation-duration.ts`.
- Planning : `src/module/planning/repository/planning.repository.ts`, `src/module/planning/services/planning.service.ts`, `src/module/planning/types/planning.types.ts`.
- Commercial : `src/module/devis/repository/devis.repository.ts`, `src/module/commercial-references/**`, `src/module/commercial-reliability/repository/commercial-reliability.repository.ts`.
- Achats / portail : `src/module/procurement-reliability/repository/procurement-reliability.repository.ts`, `src/module/client-portal/repository/client-portal.repository.ts`.
- GED : `src/shared/uploads/upload-scanner.ts`, `src/module/ged/services/ged.service.ts`, `src/middlewares/errorHandler.ts`, `docker/entrypoint.sh`, `docker/freshclam.conf`.
- Exécution : `src/config/e2e-isolation.ts`, `scripts/e2e/seed-isolated.js`, `scripts/migrations/release-gate.js`, `scripts/db-patches.js`.

## Migrations, preflight, vérification et retour arrière

| Patch | Effet | Préflight / vérification | Rollback réaliste |
|---|---|---|---|
| `db/patches/20260819_devis_preparation_idempotency_grants_002_003.sql` | Droits minimaux Devis pour `cerp_app`. | DB autorisée, rôle, relations/colonnes ; `has_table_privilege` après application. | Restaurer la sauvegarde pré-migration vérifiée : un `REVOKE` aveugle pourrait supprimer un droit légitime préexistant. |
| `db/patches/20260819_client_portal_auth_attempt_update_grant_004.sql` | `UPDATE` minimal de `client_portal_auth_attempts` afin de marquer une tentative authentifiée comme réussie. | DB autorisée, rôle, relation ; vérification précise du droit `UPDATE`. | Restaurer la sauvegarde pré-migration vérifiée, après revert code correspondant ; pas de `REVOKE` destructeur. |

Les scripts de support sont sous `db/patches/support/` (`*.preflight.sql`, `*.verify.sql`, `*.rollback.sql`). Les patches refusent une base autre que `cerp_test`, `cerp_prod` ou une restauration isolée nommée `cerp_restore_*`; le runner de cette campagne a utilisé uniquement un environnement jetable. Avant toute application partagée : sauvegarde vérifiée, preflight en lecture seule, application, verify, smoke fonctionnel, et conservation de la sauvegarde jusqu'à validation.

## Tests et preuves réellement exécutés

| Portée | Commande/scénario | Résultat observé |
|---|---|---|
| Backend ciblé OF | `npm run test:run -- src/__tests__/production-of-170.routes.test.ts src/module/production/repository/production-receipts.repository.test.ts` | PASS — 2 fichiers, 39 tests. |
| GED et sécurité | Tests GED/sécurité ciblés | PASS — 47/47. |
| Contrat image scanner | Tests contrat Docker upload scanner | PASS — 12/12. |
| Devis/référentiels/migration | Tests Devis, références commerciales et garde migration | PASS — 3 fichiers, 24 tests. |
| Planning | Groupe planning/méthodes | PASS — 11/11. |
| Clavier planning | 10 répétitions ciblées | PASS — 30/30. |
| TypeScript/build backend | `npm run typecheck`, `npm run build` | PASS sur les vagues ; build génère OpenAPI, frontières et image. |
| Migration isolée | Répétition PostgreSQL tmpfs sur `127.0.0.1:55489/cerp_test` | PASS — 167 patches, rejeu 0, intégrité et restauration vérifiées. |
| Least privilege runtime | `SET LOCAL ROLE cerp_app` | Devis : privilèges exacts ; achats : `SELECT/INSERT` autorisés, `UPDATE` refusé ; verrou consultatif + lecture sans `FOR SHARE` réussis. |
| Devis E2E isolé | Minimal, complet, retry/idempotence | PASS — 2/2. |
| Production E2E isolé | Déclaration, blocage clôture, réception, retry, clôture | PASS. |
| Achats E2E isolé | Réception nominale + partielle/anomalie + retry | PASS — 2/2. |
| Qualification planning E2E isolé | Machine sans famille, autoplan, tentative directe | PASS — 1/1. |
| Formulaires E2E isolé | Client/fournisseur/article/machine-poste, clavier/souris et reload | PASS — 3/3. |
| GED saine E2E isolée | Fichiers propres et publication après verdict | PASS — 2/2. |
| Panne scanner E2E isolée | Arrêt `clamd`, readiness dégradée, upload 503, quarantaine, aucun téléchargement | PASS — 1/1. |
| Responsive navigateur | 375, 430, 538, 768, 1024, 1440 px ; route et actions planning | PASS — 2/2. |

Les données de preuve sont préfixées par le runner isolé et vivent dans ses volumes/DB éphémères. Elles ne sont pas des données de production.

## Sécurité, compatibilité et limites

- Aucune autorisation n'est contournée : JWT/RBAC existants restent appliqués et les nouvelles routes commerciales sont authentifiées.
- Aucun secret, URL de production, contenu de document, token ou PII n'est placé dans ce rapport, les logs publics ou les réponses d'erreur.
- Le mode scanner est `enforce` hors tests ; une configuration invalide ou un scanner absent ne permet pas de publication de GED.
- Les changements de privilèges sont additifs, minimaux et validables. Ils exigent une sauvegarde avant application sur une base partagée.
- Les données métier réelles ne sont pas inventées : familles machine, calendriers de production, centres de coûts/taux horaires, structures et référentiels Qualité/Outillage doivent être renseignés par les rôles responsables via les gates fournis.
- Le build peut signaler des seuils de bundle frontend : ce n'est pas un échec backend, mais le contrôle de release global doit le juger selon son seuil configuré.

## Procédure de rollback

1. Stopper la promotion et conserver les logs/artefacts corrélés au SHA de l'image.
2. Revenir au commit applicatif immédiatement antérieur à la vague concernée, reconstruire l'image puis exécuter les tests ciblés et le smoke de santé.
3. Pour les patches de droits, **ne pas exécuter de `REVOKE` en place** : restaurer la sauvegarde pré-migration vérifiée dans un environnement isolé, vérifier le portail/Devis, puis appliquer le runbook de promotion validé.
4. Pour GED/ClamAV, restaurer le service scanner et ses signatures, contrôler `/health/ready`, puis tester un fichier propre et EICAR dans l'environnement isolé avant de rouvrir les uploads.
5. Rejouer le scénario métier affecté puis la campagne E2E complète avant toute nouvelle promotion.

## Éléments restant réellement à faire

1. Attendre et consigner le résultat du **runner E2E complet propre** ; tout échec doit être reproduit, corrigé et relancé sans assouplir les assertions métier.
2. Exécuter les gates globaux finaux backend/frontend (collection complète, build, audit, release gate) sur les SHA finaux.
3. Produire les artefacts horodatés et l'empreinte du run global, puis comparer le nouveau registre à l'audit initial.
4. Avant `cerp_test` partagé : obtenir l'autorisation de migration, réaliser sauvegarde/preflight/verify/rollback documenté. `cerp_prod` reste hors périmètre de cette campagne.
5. Les responsables métier doivent renseigner les référentiels signalés par les gates (notamment familles machines, calendriers et coûts) ; aucune valeur ne doit être fabriquée pour obtenir un faux vert.

## GO / NO-GO

**NO-GO temporaire** pour promotion et déploiement : `FINAL_FULL_E2E_PENDING`. Les preuves ciblées sont favorables, mais la sortie CERP-REPAIR-00 exige encore le run E2E global, les gates complets et l'inventaire final d'artefacts. Aucune promotion `main`, aucun push et aucune écriture `cerp_prod` ne sont présentés comme effectués.
