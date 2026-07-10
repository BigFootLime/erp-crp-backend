# T6 — Kilomètres : preuves

Objectif : déclaration de kilomètres par le salarié + validation responsable, avec réfs métier
(affaire/client/fournisseur) optionnelles, statut, audit, anti-IDOR. Issue #119.

## Livré

- **Cycle** : `DRAFT → SUBMITTED → VALIDATED | REJECTED` (transitions gardées côté SQL).
- **Salarié (anti-IDOR)** : `POST /kilometers` (employé dérivé de `req.user`, JAMAIS du corps),
  `GET /kilometers/me`, `PATCH /kilometers/:id/submit` (ne soumet que SES déclarations DRAFT).
- **Responsable** : `GET /kilometers/team` (périmètre manager / RH), `PATCH /kilometers/:id/validate|reject`
  (uniquement si SUBMITTED ; hors périmètre → 403). Audit sur chaque écriture.
- **Distance** : l'écart d'odomètre prime (arrondi 2 déc., jamais négatif) ; sinon distance saisie.
- **Réfs douces** : `affaire_id` (bigint), `client_id`/`fournisseur_id` (int) — sans FK dure (comme T1).
- **Véhicules** : `GET /kilometers/vehicles` (picker) + `POST /admin/vehicles` (privilégié).
- **Frontend** : « Mes kilomètres » (déclarer/soumettre) + « Kilomètres équipe » (valider/refuser, gate rôle).
- **Pas de géolocalisation continue** : uniquement lieux texte + odomètre saisis.

## Tests (7 verts) — suite backend **248 / 49 fichiers**, `tsc` 0

`t6-km.test.ts` : createKmSchema refuse `employee_id` (anti-IDOR) + odomètre incohérent ;
`computeDistanceKm` (odomètre prime / distance / jamais négatif) ; `createMyKmEntry` (employé = token,
audit) ; soumission ownership 403 ; DRAFT→SUBMITTED puis 409 ; validation hors périmètre 403 / RH VALIDATED ;
validation d'une non-soumise → 409.

## Smoke SQL cerp_test (BEGIN…ROLLBACK, 0 résidu)

```
0 CREATE: km cree (distance 42.5, refs douces)
1 SUBMIT: rows=1 (attendu 1)
2 VALIDATE: rows=1 (attendu 1)
3 NON_REPLAY: rows=0 status=VALIDATED (attendu 0 / VALIDATED)
4 TEAM_SCOPE: matches=1 (attendu 1)
```
