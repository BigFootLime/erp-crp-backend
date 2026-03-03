# Nomenclature des codes (ERP)

Ce document decrit les formats de codes utilises dans l'ERP, la generation automatique (quand le champ est vide), et les regles de validation/controle d'unicite.

## Principes

- Si le champ code/reference/numero est vide a la creation: le backend genere automatiquement un code conforme.
- Si un code est fourni par l'utilisateur: le backend le valide via une regex stricte (pas de "presque bon"), puis verifie l'unicite (si contrainte UNIQUE en base).
- Compatibilite legacy: certains formats historiques restent acceptes pour les donnees deja existantes (ex: `DV-<id>`), mais les nouveaux codes generes suivent le format "nomenclature".

## Endpoint des formats (UI)

- `GET /api/v1/codes/formats`
- Reponse:

```json
{
  "items": [
    { "key": "client", "regex": "^CLI-\\d{3}$", "example": "CLI-001", "hintText": "Format attendu: CLI-001" }
  ]
}
```

Le frontend peut afficher `hintText` + `example` et valider le champ cote client en se basant sur `regex`.

## Formats (principaux)

Les formats sont declares dans `src/shared/codes/code-validator.ts`.

- Client: `CLI-001`
- Devis: `DEV-CLI-001-2026-0001` (legacy accepte: `DV-<id>`)
- Commande client: `CC-CLI-001-2026-0001` (legacy accepte: `CC-<id>`)
- Affaire:
  - Livraison: `AFF-LIV-CLI-001-2026-0001`
  - Production: `AFF-PROD-CLI-001-2026-0001`
  - (legacy accepte: `AFF-<id>`)
- OF: `OF-2026-00001` (legacy accepte: `OF-<id>`)
- Bon de livraison: `BL-00000001`
- Reception fournisseur: `RF-00000001`
- Qualite:
  - NC: `NC-2026-00001`
  - CAPA action: `CAP-2026-00001`

## Base de donnees (patch)

Patch idempotent:

- `db/patches/20260227_nomenclature_codes.sql`

Il ajoute:

- `public.code_sequences` + `public.fn_next_code_value(key)` (allocation atomique d'un compteur par cle)
- `clients.client_code` + backfill + contrainte UNIQUE `clients_client_code_key`
- `quality_action.reference` + generateur `public.quality_generate_action_reference()` + contrainte UNIQUE

## Generation (backend)

Service centralise:

- `src/shared/codes/code-generator.service.ts`

Points importants:

- Les sequences applicatives (CLI/DEV/CC/AFF/OF/PCT/...) sont gerees via `public.fn_next_code_value`.
- BL/RF/NC/CAP reutilisent les generateurs/sequence existants en base (formats deja en prod).

## Smoke

Script de verification rapide:

- `node scripts/nomenclature-smoke.js`

Variables:

- `BASE_URL` (defaut: `http://localhost:5000`)
- `TOKEN` (optionnel): JWT pour les endpoints proteges.
