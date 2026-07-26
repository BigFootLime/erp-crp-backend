# Traçabilité industrielle 360 — backend (#142)

Frontend lié : `crp-systems-web#276`.
Décision cadre et architecture détaillée :
`crp-systems-web/docs/adr/ADR-0028-traceability-read-only-projection.md` et
`crp-systems-web/docs/architecture/tracabilite-industrielle-360.md`.

## Ce qui existe

```
src/module/traceability/
  domain/traceability-model.ts        types de nœuds, relations, libellés FR, preuve
  domain/traceability-policy.ts       12 capacités, visibilité par type, plafonds
  domain/traceability-graph.ts        moteur pur : BFS par niveau, cycles, budgets
  repository/traceability-neighbors   expansion BATCHÉE par type et par niveau
  repository/traceability-hydrate     hydratation batchée, code métier, masquage RGPD
  repository/traceability-search      recherche universelle UNION ALL bornée
  repository/traceability-quality     détection d'anomalies de données
  services/traceability-360.service   service unique (chain / expand / impact / legacy)
  services/material-consumption.automation.ts
  controllers, routes, validators, middlewares
```

## Routes

| Route | Capacité |
|---|---|
| `GET /api/v1/traceability/v2/capabilities` | `read` |
| `GET /api/v1/traceability/v2/search` | `search` |
| `GET /api/v1/traceability/v2/chain` | `read` |
| `GET /api/v1/traceability/v2/expand` | `read` |
| `GET /api/v1/traceability/v2/impact` | `impact` |
| `GET /api/v1/traceability/chain` | `read` — **contrat historique inchangé** |
| `GET /api/v1/asbuilt/lots/:id/preview` | `read` |
| `POST /api/v1/asbuilt/lots/:id/generate` | `asbuilt_generate` |
| `GET /api/v1/asbuilt/lots/:id/download/:docId` | `asbuilt_download` |

Aucune route n'écrit de donnée industrielle.

## Point d'attention pour la maintenance

**Convention d'arête.** `from` est toujours l'amont industriel, `to` l'aval, quel que soit le
sens de découverte. Le nœud d'ancrage (celui qu'on déplie) est donc `to` en parcours amont et
`from` sinon — voir `anchorOf` / `neighborOf` dans `traceability-graph.ts`. Toute nouvelle
requête d'expansion doit sélectionner `from_id` et `to_id` **dans le sens du flux**, et filtrer
dans son `WHERE` sur le côté qui se trouve dans la frontière.

Se tromper de sens produit un symptôme discret : le voisin n'est jamais ajouté au graphe, et la
branche apparaît vide au lieu d'échouer.

## Automatisation de la consommation matière

`recordMaterialConsumptionOnPost(client, …)` est appelée **dans la transaction** de
`repoPostMovement` (`src/module/stock/repository/stock.repository.ts`), juste après le passage
du mouvement à `POSTED`.

- Idempotente (`ON CONFLICT (stock_movement_line_id) DO NOTHING`).
- Bornée aux sorties `OUT` / `SCRAP` déclarant un OF **existant**.
- Compense sans effacer : les consommations du mouvement inversé passent en `COMPENSATED`.
- Une table absente (`42P01`) ou un droit refusé (`42501`) ne fait **jamais** échouer la
  comptabilisation de stock.

## Migration

`db/patches/20260726_tracabilite_360_142.sql` — additif, idempotent, transactionnel.
Support : `.preflight.sql`, `.verify.sql`, `.rollback.sql` (gardé : refuse de s'exécuter dès
qu'une consommation existe).

Appliqué et vérifié sur **`cerp_test` uniquement** le 2026-07-26, enregistré dans
`cerp_schema_migrations`. **`cerp_prod` non modifié** — l'application en production exige une
validation humaine explicite.

Rappel du runbook HYPERBOX2 : le patch réassigne explicitement
`of_material_consumptions` à `cerp_app`, sans quoi le rôle applicatif reçoit un `42501` qui
devient un 500 côté API.
