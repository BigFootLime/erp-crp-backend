# T5 — Contrats / horaires / règles : preuves

Objectif : rendre les calculs réellement exploitables (35h, 39h, temps partiel, horaires types), **sans
jamais coder 35/39 en dur**. Issue #119.

## Ce qui est livré

- **Migration** `db/patches/20260710_hr_users_role_responsable_rh.sql` — élargit `users_role_check` pour
  autoriser `Responsable RH` (additif/sûr, idempotent). Appliquée sur cerp_test (écart T4 fermé).
- **Moteur de règles PUR** `services/temps-deplacements-rules.ts` : `effectiveRuleSetFromRows` (rule_set
  s'il existe, sinon dérivé du contrat — heures propres du salarié), `applyRounding`, `enforceMinimumBreak`,
  `splitWeeklyOvertime`, `weeklyAggregate`, `effectiveDailyWorked`.
- **Résolution effective** `repoGetEffectiveRuleSet(employeeId, date)` : contrat **couvrant la date**
  (start ≤ date ≤ end), donc robuste au **changement de contrat** et au recalcul historique.
- **Calcul câblé sur les règles réelles** : `computeDailyTimesheet` (cible jour + arrondi + pause mini) et
  `computeWeeklyTimesheet` (cible hebdo + HS 25/50 + absence + persistance `hr_timesheet_weeks`).
- **CRUD admin RH** (réservé rôles privilégiés) : `rule-sets`, `contracts` (1 seul actif/employé → 409),
  `schedules`, + `GET /admin/employees` (pickers). Tout audité, jamais de secret.

## Endpoints (`/time-clock/admin/*`, privilégiés)

`GET employees` · `GET|POST rule-sets`, `PUT rule-sets/:id`, `PATCH rule-sets/:id/active` ·
`GET|POST contracts`, `PUT contracts/:id`, `PATCH contracts/:id/active` ·
`GET|POST schedules`, `PUT schedules/:id`, `DELETE schedules/:id`.

## Modèle de calcul (configurable)

- `weekly_target_minutes` / `daily_target_minutes` : cibles saisies (jamais 35/39 en dur).
- HS : `[0..seuil1]` normal, `[seuil1..seuil2]` taux 1 (25 %), `[seuil2..]` taux 2 (50 %). Seuils/taux
  dans `hr_time_rule_sets` ; à défaut, dérivés du contrat (HS au-delà de la cible contractuelle).
- Arrondi (`rounding_rule`: `{unit_minutes, mode}`) et pause minimale (`break_rule`:
  `{min_break_minutes, auto_deduct_after_minutes}`) appliqués au temps travaillé.

## Tests unitaires (19 verts) — suite backend **229 / 46 fichiers**, `tsc` 0

`temps-deplacements-t5-rules.test.ts` (13) : 35h normal, 39h normal, temps partiel, HS 25, HS 50, absence,
absence de contrat (null → zéros), bornes split, contrat dérivé vs rule_set, changement 35→39 (cibles
différentes), arrondis, pause mini. `temps-deplacements-t5-admin.test.ts` (6) : Responsable RH autorisé
(create règle/contrat + audit), anti-IDOR (salarié 403 sur règle/contrats/horaire), 1 seul contrat actif (409).

## Smoke SQL cerp_test (BEGIN…ROLLBACK, 0 résidu)

```
1 ONE_ACTIVE: 2e contrat actif refusé (OK)
2 RESOLVE@2026-03-01: type=H35 weekly_h=35.00 rule_target=2100 (attendu H35/35/2100)
3 RESOLVE@2026-08-01: type=H39 weekly_h=39.00 rule_target=NULL (attendu H39/39/NULL)
4 RESOLVE@2025 (avant contrat): matches=0 (attendu 0)
5 WEEK_UPSERT: worked=2400 ot25=300 (attendu 2400/300)
residus = 0
```

Décision : approbation d'une correction (T4) trace la décision ; l'**override numérique** d'un relevé n'est
pas implémenté ici (append-only) — laissé comme évolution documentée. HS « 25/50 » = libellés des taux
configurables `overtime_rate_1/2`, pas des constantes.
