# SOL-35 — Portail fournisseur minimal — contrôle de précondition

- Date : 2026-08-15
- Propriétaire : Keenan Martin
- Issue : [#534](https://github.com/BigFootLime/erp-crp-backend/issues/534)
- Décision : **No-Go produit — précondition non satisfaite**

## Diagnostic et cause racine

Le dépôt contient déjà le domaine Fournisseurs, les commandes d'achat, les réceptions et les contrôles qualité. Il ne contient volontairement aucun portail fournisseur. La précondition de SOL-35 n'est pas satisfaite dans la source de vérité : `cerp_prod` contient un fournisseur actif mais aucune commande d'achat réelle. Il n'existe donc ni besoin répété démontré, ni fournisseur pilote, ni action externe à financer.

Les 60 commandes et 12 fournisseurs répétés trouvés dans `cerp_test` viennent des fixtures SOL-05. Les utiliser comme justification produit présenterait une donnée synthétique comme réelle.

## Preuve reproductible

La requête a été exécutée sur HYPERBOX2 via `sudo -u postgres psql`, avec `ON_ERROR_STOP` et une transaction `BEGIN READ ONLY`. Elle compte les fournisseurs actifs, les commandes, les fournisseurs ayant au moins deux commandes non annulées et les commandes qui attendraient une réponse.

| Base | Fournisseurs actifs | Commandes | Commandes sur 365 jours | Fournisseurs avec besoin répété | En attente de réponse | Actives sans date promise |
|---|---:|---:|---:|---:|---:|---:|
| `cerp_prod` | 1 | 0 | 0 | 0 | 0 | 0 |
| `cerp_test` | 46 | 60 | 60 | 12 | 0 | 0 |

La seconde ligne est explicitement une fixture de test et ne satisfait pas le gate métier.

## Choix d'architecture

L'ADR [ADR-0080](../adr/ADR-0080-supplier-portal-product-gate.md) interdit toute création anticipée de routes, tables, identités ou documents portail. Elle définit les cinq preuves nécessaires à une réouverture et réserve une architecture isolée inspirée du portail client, sans partage d'identité ou d'audience.

## Fichiers modifiés

- `docs/adr/ADR-0080-supplier-portal-product-gate.md`
- `docs/execution-reports/SOL-35.md`

Aucun fichier runtime, contrat OpenAPI, route, service, repository, validateur ou test produit n'est modifié.

## Migrations et données

Aucune migration ni patch SQL. Les deux requêtes ont été exécutées en lecture seule. Aucune sauvegarde, restauration ou écriture sur `cerp_test` ou `cerp_prod` n'est nécessaire pour cette décision.

## Tests et vérifications

- accès HYPERBOX2 par clé dédiée : réussi ;
- requête `cerp_prod` dans une transaction `READ ONLY` : réussie ;
- même requête sur `cerp_test` : réussie et correctement classée comme fixture ;
- `git diff --check` : réussi ;
- suite runtime : non applicable, aucun code ni schéma n'est modifié.

## Navigateur / E2E

Non applicable. Aucun écran fournisseur externe n'est créé. Lancer un E2E ou une retouche CLAUDE-16 sur une interface fictive contredirait le gate et les règles anti-mock.

## Risques et compatibilité

Le risque évité est élevé : exposition inter-fournisseurs, ambiguïté contractuelle sur les dates proposées, stockage documentaire externe et charge de support sans utilisateur réel. La compatibilité des modules Achats, Fournisseurs, Réceptions et Qualité est totale, puisqu'ils ne changent pas.

Le risque résiduel est l'absence d'autonomie fournisseur. Il est acceptable tant qu'aucune commande réelle répétée ne le justifie ; les échanges restent dans le processus Achats existant.

## Rollback

Rollback runtime et SQL : aucun. Pour révoquer la décision documentaire, créer une ADR de remplacement avec les preuves de réouverture ; ne pas supprimer l'historique.

## Éléments restant réellement à faire

Attendre un besoin réel répondant aux cinq critères de l'ADR-0080. À ce moment seulement : créer une nouvelle issue financée, refaire la mesure production, concevoir l'isolation, puis implémenter SOL-35 avant toute invocation de CLAUDE-16.
