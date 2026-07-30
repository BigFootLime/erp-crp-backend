# #244 — Commentaire automatique par famille de finition

## Objectif

Une famille de finition peut désormais porter un `commentaire_template`. Il est
ajouté par le serveur avant le modèle de commentaire de la révision lors de
l'aperçu et de la confirmation d'un article de traitement.

## Contrat

- `POST /api/v1/finitions/familles` exige `library_draft_write`.
- Charge : `code`, `label`, `description?`, `commentaire_template?`, `sort_order?`.
- Le commentaire accepte la même liste blanche de variables que les modèles de
  révision ; le serveur refuse toute variable inconnue.
- Le code article demeure `ART-TRT-NNNNNN` et le code finition `FIN-NNNNNN`.
- Une finition et sa révision restent brouillon jusqu'à leur validation : ce
  paramétrage n'affaiblit aucune règle Qualité.

## Migration

`db/patches/20260730_surface_finish_family_comment_244.sql` est additive,
idempotente et non exécutée. Les scripts `preflight` et `verify` associés sont
en lecture seule.
