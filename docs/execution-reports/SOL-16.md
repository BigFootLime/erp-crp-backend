# SOL-16 — API Direction ARIANE

- Date : 2026-08-11
- Propriétaire : Keenan Martin — Direction CERP+
- Issue : [#415](https://github.com/BigFootLime/erp-crp-backend/issues/415)
- Branche : `feature/415-sol16-ariane-direction`
- Contrat : `direction-dashboard/1.0`

## Diagnostic et architecture

Les sources de commande, livraison, production, stock et finance existaient, mais aucun endpoint n'assemblait les quatre décisions Direction avec leurs preuves et leur couverture. Le nouveau `GET /api/v1/reporting/direction/overview` concentre les calculs côté serveur, applique `reporting_financial`, refuse le cache partagé et renvoie un contrat versionné validé.

Les formules exactes, filtres, statuts, limites et règles de fiabilité sont documentés dans `docs/http/direction-dashboard-415.md`. L'OTIF est volontairement `PARTIAL` : la date d'expédition est traçable, mais les versions passées du délai client ne sont pas historisées au grain ligne. La rupture sept jours reste `UNAVAILABLE` plutôt que simulée.

## Fichiers modifiés

- `src/module/facturation/validators/direction-dashboard.validators.ts` ;
- `src/module/facturation/domain/direction-dashboard.ts` et son test ;
- `src/module/facturation/repository/direction-dashboard.repository.ts` et son test ;
- `src/module/facturation/services/direction-dashboard.service.ts` ;
- `src/module/facturation/controllers/direction-dashboard.controller.ts` ;
- `src/module/facturation/routes/reporting.routes.ts` ;
- `src/module/facturation/domain/reporting-metrics.ts` ;
- `src/__tests__/direction-dashboard-sol16.routes.test.ts` ;
- `docs/http/direction-dashboard-415.md` ;
- `docs/execution-reports/SOL-16.md`.

## Migrations et données

Aucune migration ni donnée n'est modifiée. Les requêtes ont été exécutées contre PostgreSQL jetable après application réussie de 146 migrations (`pending=0`, `checksum-mismatch=0`). Aucune connexion production n'a été utilisée.

## Tests réels

- `pnpm typecheck` : PASS ;
- tests ciblés domaine/repository/route : PASS, 3 fichiers et 11 tests ;
- `pnpm test:run` : PASS, suite complète, code 0 ;
- `pnpm build` : PASS, frontière de données production validée ;
- Playwright isolé piloté par le frontend : PASS, 2/2, incluant appel SQL réel, 401 anonyme, absence de données pour un rôle standard et accès Direction autorisé.

Les tests RBAC backend couvrent 401, 403 utilisateur standard, 403 secrétariat, 200 Direction, requête invalide 400 et cash indisponible avec filtre site.

## Risques, rollback et reste

La compatibilité est additive. Le risque principal est l'historisation du délai client ; il est exposé dans la réponse et empêche la fiabilité `MEASURED`. Les retours et l'allocation facture/site demandent encore une règle métier autoritaire.

Rollback : retirer la route et les modules Direction, puis redéployer le SHA backend précédent. Aucun rollback SQL.

Reste : ajouter une historisation append-only des révisions de délai ligne dans une tâche dédiée avec migration, preflight, sauvegarde, vérification et rollback ; ne pas reclasser OTIF avant cette preuve.
