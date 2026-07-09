# T4 — Validation responsable RH : preuves

Périmètre : corrections tracées (motif obligatoire, pas d'auto-validation), validation jour/semaine,
lecture périmètre équipe (manager / RH-Direction-Admin). Issue #119. Append-only : les événements ne
sont jamais mutés — une correction approuvée est la **preuve légale** de la décision ; l'application
numérique d'un override dans le relevé relève de T5.

## Endpoints (montés après le socle `authenticateToken`)

| Méthode | Route | Rôle | Contrôle |
|---|---|---|---|
| POST | `/time-clock/adjustments` | salarié | motif obligatoire ; anti-IDOR (soi / manager / RH) |
| PATCH | `/time-clock/adjustments/:id/approve` | responsable/RH | pas d'auto-validation ; périmètre ; idempotent |
| PATCH | `/time-clock/adjustments/:id/reject` | responsable/RH | idem |
| GET | `/time-clock/team/adjustments` | responsable/RH | demandes en attente du périmètre |
| GET | `/time-clock/team/today` | responsable/RH | relevé du jour de l'équipe |
| GET | `/time-clock/team/anomalies` | responsable/RH | anomalies du jour du périmètre |
| PATCH | `/time-clock/days/:id/validate` | responsable/RH | DRAFT/TO_REVIEW → VALIDATED, non rejouable |
| PATCH | `/time-clock/weeks/:id/validate` | responsable/RH | idem semaine |

## Garanties

- **Pas d'auto-validation** : refusée à deux niveaux — service (`requested_by === actor` → 403
  `HR_SELF_APPROVAL_FORBIDDEN`) **et** DB (`CHECK approved_by <> requested_by`).
- **Motif obligatoire** : Zod (`reason` min 3, `.strict()`) + DB (`CHECK length(btrim(reason)) > 0`).
- **Anti-IDOR périmètre** : une décision/validation n'est permise qu'au manager de l'employé cible ou à
  un rôle privilégié (`isHrPrivileged` = rh / direction / directeur / administrateur).
- **Idempotence** : transition `WHERE status='REQUESTED'` (0 ligne si déjà décidée → 409) ; validation
  `WHERE validation_status IN ('DRAFT','TO_REVIEW')` (409 si déjà VALIDATED/EXPORTED).
- **Audit** : chaque écriture journalisée (`requested`/`approved`/`rejected`/`day.validated`/
  `week.validated`) via `insertAuditLog` — jamais de secret, motif = donnée opérationnelle.

## Tests unitaires — `src/__tests__/temps-deplacements-t4.test.ts` (15 verts)

Validateurs (motif, strict, enum, uuid) ; `isHrPrivileged` ; `createAdjustment` (404 cible / 403
anti-IDOR / créée+audit) ; `decideAdjustment` (404 / 409 déjà traitée / 403 auto-validation / 403 hors
périmètre / APPROVED+audit / 409 course) ; `validateTimesheetDay` (404 / 409 déjà validée / VALIDATED+audit).

Suite backend complète : **210 verts / 44 fichiers**, `tsc --noEmit` = 0.

## Smoke SQL cerp_test (BEGIN…ROLLBACK, aucune persistance)

```
1 SELF_APPROVE_CHECK: bloqué par CHECK (OK)
2 REASON_CHECK: motif vide refusé (OK)
3 APPROVE_BY_OTHER: t (attendu t)
4 NON_REPLAY: lignes_modifiees=0 reste_APPROVED=t (attendu 0 / t)
5 DAY_VALIDATE: t (attendu t)
6 TEAM_SCOPE_RESOLVE: matches=1 (attendu 1)
residus_smoke = 0
```

## Écart ouvert (à traiter en T5)

- **`users_role_check` ne contient pas `Responsable RH`** sur cerp_test (valeurs autorisées :
  Directeur, Employee, Administrateur Systeme et Reseau, Responsable Qualité, Secretaire, Responsable
  Programmation). Le validateur applicatif (`user.validator.ts`) l'autorise, mais la contrainte DB non :
  on ne peut donc pas *créer* un utilisateur `Responsable RH` tant que la contrainte n'est pas étendue.
  Mitigation actuelle : `isHrPrivileged` reconnaît `Directeur` et `Administrateur…` (rôles autorisés) →
  les fonctions RH restent accessibles. **Correctif T5** : migration additive étendant `users_role_check`
  (+ éventuel `Responsable RH`) ou décision d'utiliser les rôles existants. Preuve disponible ; écart ouvert.
