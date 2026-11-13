# Reconfiguration des articles

Développement local du 12 novembre 2026, non déployé. Tâche de référence : STOCK-ARTICLE-CONFIG, proposition d'issue et recette dans le dépôt frontend (`docs/testing/article-reconfiguration.md`).

`POST /api/v1/stock/articles/:id/reconfigure`, authentifié, avec `Idempotency-Key` obligatoire (8 à 200 caractères). Réponse 201 : fiche `StockArticleDetail` du nouvel article, ou de la matière existante si sa référence canonique ne change pas. Coûts masqués selon les droits habituels.

Corps JSON :

```json
{
  "expected_row_version": 7,
  "action": "KEEP_BOTH",
  "article": {
    "article_category": "matiere",
    "article_categories": ["matiere_premiere"],
    "family_code": "PL",
    "unite": "mm",
    "stock_managed": true,
    "lot_tracking": true,
    "article_matiere": {
      "nuance_id": 10,
      "etat_id": 20,
      "barre_a_decouper": true,
      "largeur_mm": 95,
      "epaisseur_mm": 25
    }
  }
}
```

`article` réutilise exactement le contrat de création `createArticleSchema.shape.body`. Pour un traitement, envoyer à sa place `finish`, conforme à `stockArticleFinishConfirmBodySchema` : contexte PT/version, révision de finition, décision CREATE/REUSE, empreinte d'aperçu et empreinte technique. Ces deux propriétés sont exclusives. La catégorie primaire doit rester identique ; les pièces fabriquées utilisent leur parcours existant.

Actions :

| Valeur | Effet |
| --- | --- |
| `REPLACE_ALL` | Créer/résoudre l'article, remplacer les liens techniques modifiables et préparer une copie des versions applicables en brouillon. Ancien article conservé actif. |
| `ARCHIVE_OLD` | Créer/résoudre le nouvel article puis archiver l'ancien sans modifier ses références historiques, y compris lorsqu'il est utilisé par des pièces. |
| `KEEP_BOTH` | Créer/résoudre le nouvel article sans remplacer les liens ni archiver l'ancien. |

Une seule transaction porte création, snapshots de création, copies de versions, liens, archivage, audit et reçu d'idempotence. Les commandes concurrentes sont sérialisées par clé, puis par verrou sur l'article source. Le même contenu rejoué retrouve le même article ; une clé réutilisée avec un autre contenu renvoie 409. Une version périmée renvoie également 409 avant toute création.

Les liens visés sont `pieces_techniques_achats.article_id`, `pieces_techniques_nomenclature.child_article_id` et `gamme_operation_finitions.article_id`, avec remplacement cohérent des spécifications de finition. Les versions obsolètes, documents commerciaux, OF, lots et mouvements ne sont pas réécrits. Un changement d'unité avec des liens techniques existants est refusé (422) : aucune conversion de quantité n'est inventée. La duplication d'une référence matière canonique existante est refusée ; la correction sur place exige `REPLACE_ALL`.

Autorisations : droits de modification article ; droits d'archivage supplémentaires pour `ARCHIVE_OLD`, droits fournisseur si des conditions fournisseur sont transmises, capacité `article_resolve` pour une finition. Audit `stock.articles.reconfigure` et, en cas d'archivage, `stock.articles.archive`. Aucun changement de schéma ni migration nécessaire.
