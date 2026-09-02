# Commande client — rapprochement métier ligne par ligne (#698)

## Décision

La commande client reste l'agrégat commercial autoritaire. Le nouveau parcours ne crée ni moteur de commande, ni Article parallèle : il enrichit chaque `commande_ligne` avec la version technique retenue et la preuve structurée de l'arbitrage entre les sources disponibles.

Les sources présentées sont :

- la commande reçue, saisie par l'opérateur ;
- le devis accepté, lorsqu'il existe ;
- le référentiel CERP de l'Article et de sa Pièce technique.

Une différence visible doit être arbitrée explicitement. La valeur choisie est celle persistée sur la ligne ; la décision et les instantanés des sources sont conservés séparément pour l'audit.

## Invariants

- Un Article conserve son identité entre les indices.
- `piece_technique_version_id` porte l'indice/révision choisi pour la ligne.
- Un flux v2 ne peut être enregistré qu'avec des lignes rapprochées.
- Le lancement d'un OF exige une version `APPLICABLE` et transmet cette version au moteur récursif existant.
- L'analyse et la réservation de stock utilisent uniquement les lots du même Article et de la même version. Un lot sans version n'est jamais consommé automatiquement par une ligne versionnée.
- Les commandes historiques restent lisibles et continuent à utiliser le comportement antérieur tant qu'elles n'ont pas été créées par le flux v2.
- Le prix retenu modifie la ligne de commande. La mise à jour éventuelle du prix de référence Article conserve son mécanisme séparé existant.

## Contrat HTTP

Le contrat de création/mise à jour accepte :

- `creation_flow_version: 2` au niveau de la commande ;
- `piece_technique_version_id`, `source_devis_ligne_id` et `reconciliation` sur chaque ligne.

`reconciliation` contient un statut, les instantanés affichés et les décisions champ par champ. Le serveur vérifie l'appartenance de la version à la Pièce de l'Article et la cohérence entre les valeurs retenues et la ligne persistée.

## Compatibilité aval

La génération d'affaires, les réservations, la création récursive des OF, les BL, les sorties de stock, les PDF et la facturation restent portés par leurs services existants. Cette évolution ajoute des gardes et transmet la version sélectionnée ; elle ne duplique aucun de ces moteurs.

