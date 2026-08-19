# CERP-REPAIR-00 — Rapport d'exécution backend

- Date de départ : 2026-08-19
- Audit source : `CODX-E2E-2026-08-19-181940`
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/607
- Branche : `fix/607-e2e-audit-repair`
- Base : `origin/dev` à `cbcd10c004dd2f9535249d7da641da00f4b1b0ef`
- Production écrite : **NON**

## Registre provisoire des anomalies

| ID | Domaine | État actuel |
|---|---|---|
| 001 | GED / antivirus | DIAGNOSTIQUÉ — scanner CERP_TEST indisponible ; réparation opérationnelle à prouver |
| 002 | Création devis | DIAGNOSTIC EN COURS — transaction/schema réel à reproduire |
| 003 | Référentiels devis | DIAGNOSTIQUÉ — routes backend absentes |
| 004 | Combobox métier | À REPRODUIRE |
| 005 | Familles machine | DÉCISION MÉTIER REQUISE — aucune valeur ne sera inventée |
| 006 | Complétude pièces | DIAGNOSTIQUÉ — données métier manquantes |
| 007 | Double indice A | DIAGNOSTIQUÉ — double commande frontend, pas une contrainte DB manquante |
| 008–011 | Planning / durée / dates / machine | DIAGNOSTIQUÉS — corrections et preuves à réaliser |
| 012 | OF clôturé sans stock | CORRIGÉ EN CODE — preuve E2E PostgreSQL à réaliser |
| 013 | Boucle d'erreurs réception | CORRIGÉ côté client |
| 014 | Référentiels Qualité/Outillage | DÉCISION MÉTIER REQUISE — valeurs réelles non inventées |
| 015 | Route planning | À CORRIGER |
| 016 | Responsive | À REPRODUIRE APRÈS LES VAGUES MÉTIER |

## Vague A — réception et clôture OF

### Cause racine

`repoGetOfReceiptContext` référençait `magasins.code_magasin` et
`magasins.libelle` dans un `COALESCE`. PostgreSQL résout tous les identifiants :
ces colonnes absentes provoquaient `42703`, donc le 500 observé. Par ailleurs,
la transition `TERMINE → CLOTURE` ne vérifiait ni `of_receipts`, ni lot de
sortie, ni mouvement stock publié.

### Correction et invariant

- lecture des seules colonnes canoniques `magasins.code` et `magasins.name` ;
- OF verrouillé avant transition ;
- clôture autorisée seulement si la quantité bonne déclarée est couverte par
  le registre immuable, un lot de sortie et un mouvement d'entrée `POSTED` ;
- refus `409 OF_RECEIPT_INCOMPLETE` avec quantités et compteur de preuves
  invalides ;
- la réception reste une commande explicite et idempotente car emplacement et
  qualité ne peuvent pas être déduits sans décision utilisateur.

### Fichiers backend

- `src/module/production/repository/production-receipts.repository.ts`
- `src/module/production/repository/production.repository.ts`
- `src/__tests__/production-of-170.routes.test.ts`

### Contrôles exécutés

| Commande | Résultat |
|---|---|
| `npm run test:run -- src/__tests__/production-of-170.routes.test.ts src/module/production/repository/production-receipts.repository.test.ts` | PASS — 2 fichiers, 39 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — OpenAPI 1 077 opérations, contrat et frontière production validés |

PostgreSQL réel, concurrence multi-session, build/image, navigateur et E2E
complet : **NOT TESTED à ce stade**. Ils restent obligatoires avant le verdict
final.

## Migration et rollback provisoire

Aucune migration ni donnée n'est modifiée par la vague A. Le rollback consiste
à revert le commit backend correspondant. Après rollback, un OF déjà `TERMINE`
pourrait à nouveau être clôturé sans réception ; les écritures stock existantes
ne doivent jamais être supprimées.
