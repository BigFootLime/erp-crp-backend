# T7 — Exports paie CSV/PDF : preuves

Objectif : exports paie **figés** + **checksum**, CSV `;` UTF-8 BOM et PDF récap, **sans XLSX ni
dépendance Excel**. Issue #119.

## Livré

- **Générateurs PURS** `services/temps-deplacements-exports.ts` : `toCsv` (séparateur `;`, BOM UTF-8,
  CRLF, échappement `; " CR LF`), `buildPayrollCsv`, `minutesToDecimalHours`, `sha256Hex`, `buildPayrollPdf`
  (pdfkit, police Helvetica intégrée — déjà en dépendance, **aucun ajout**).
- **Lot figé** : `createExport` gèle les octets (base64) dans `hr_payroll_export_batches.frozen_snapshot_json`
  + `checksum` SHA-256 en colonne. Re-téléchargement = octets **identiques**, intégrité **vérifiée**
  (`getExportFile` recalcule le checksum → 409 si altération).
- **Endpoints** (`/time-clock/admin/exports`, privilégiés) : `POST` (génère+fige), `GET` (liste, sans
  octets), `GET /:id/download` (octets + en-têtes `Content-Disposition` + `X-Checksum-SHA256`).
- **Frontend** : onglet « Exports paie » (période + format → générer ; liste + checksum + téléchargement
  via `httpBlob` authentifié).

## Tests (12 verts) — suite backend **241 / 48 fichiers**, `tsc` 0 ; frontend **103**, build OK

`t7-exports.test.ts` (6, pur) : BOM + `;` + CRLF, échappement, minutes→heures, ligne paie complète,
checksum SHA-256 connu (`sha256('abc')`), PDF `%PDF`. `t7-service.test.ts` (6) : CSV figé (base64 =
octets, checksum exact) + audit, période invalide 400, salarié 403, intégrité (checksum OK → octets ;
altéré → 409), 404/403.

## Smoke SQL cerp_test (BEGIN…ROLLBACK, 0 résidu)

```
1 PERIOD_QUERY: matches=1 (attendu 1)
2 BATCH_INSERT: format=CSV checksum=ba7816bf status=GENERATED row_count=1 (attendu CSV/ba7816bf/GENERATED/1)
```

Source des lignes = `hr_timesheet_weeks` (agrégats persistés par T5). Un export vide est possible tant que
les semaines ne sont pas calculées/persistées (dépend des règles T5 + du pointage).
