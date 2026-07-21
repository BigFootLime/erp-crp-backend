# Nomenclature des codes (ERP)

Ce document décrit les formats de codes utilisés dans l'ERP, leur attribution atomique par le backend et les règles de contrôle d'unicité.

## Principes

- Le code visible n'est jamais une clé primaire ou étrangère et n'est jamais analysé pour retrouver une relation métier.
- Le backend réserve le numéro dans la transaction de création ; un code transmis par l'interface ne devient jamais la référence finale.
- Les codes attribués sont immuables. Les anciennes références restent lisibles pour la compatibilité historique.
- Les factures et autres numéros réglementaires conservent leur séquence légale dédiée jusqu'à validation Finance.

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
- Pièce technique: `001-17025950000-C` (client, référence plan, indice externe)
- Article: `ART-USI-000042` (séquence de six chiffres, famille explicite)
- Devis: `DEV-2026-0001`
- Commande client: `CMD-2026-0001`
- Affaire: `AFF-2026-0001`
- OF: `OF-2026-000001`
- Facture : le numéro légal existant `FT-…` est conservé. `FACT-…` est disponible pour une corrélation interne future, sans remplacer le numéro réglementaire.
- Bon de livraison: `BL-00000001`
- Reception fournisseur: `RF-00000001`
- Qualite:
  - Contrôle: `CQ-2026-000001`
  - NC: `NC-2026-00001`
  - CAPA action: `CAP-2026-00001`

## Base de donnees (patch)

Patch historique:

- `db/patches/20260227_nomenclature_codes.sql`

Il ajoute:

- `public.code_sequences` + `public.fn_next_code_value(key)` (allocation atomique d'un compteur par cle)
- `clients.client_code` + backfill + contrainte UNIQUE `clients_client_code_key`
- `quality_action.reference` + generateur `public.quality_generate_action_reference()` + contrainte UNIQUE

## Generation (backend)

Service centralise:

- `src/shared/codes/code-generator.service.ts`

Points importants:

- Depuis l'issue #141, les nouvelles séquences applicatives
  (CLI/DEV/CMD/AFF/OF/LOT/CQ/ART/...) passent par
  `public.fn_next_issued_code_value(scope)`, une fonction à périmètre
  autorisé qui appelle la séquence PostgreSQL native
  `public.cerp_business_code_issue_seq`. Une allocation consommée lors d'une
  transaction annulée laisse volontairement un trou et ne peut jamais être
  réattribuée.
- Les pièces techniques conservent `pieces_techniques.code_piece` comme
  référence historique de l'agrégat. Le code de travail d'une version est
  calculé uniquement à partir de `client + plan + indice externe` et exposé
  dans `piece_technique_versions.code_metier`; la recherche pièce couvre aussi
  ce code de version.
- BL/RF/NC/CAP reutilisent les generateurs/sequence existants en base (formats deja en prod).

## Smoke

Script de verification rapide:

- `node scripts/nomenclature-smoke.js`

Variables:

- `BASE_URL` (defaut: `http://localhost:5000`)
- `TOKEN` (optionnel): JWT pour les endpoints proteges.
