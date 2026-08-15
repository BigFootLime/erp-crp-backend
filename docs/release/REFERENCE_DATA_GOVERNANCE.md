# Gouvernance des données de référence CERP+

- Version : 1.0
- Date : 2026-08-15
- Propriétaire du processus : Direction — Keenan Martin
- Implémentation : SOL-33 / ADR-0079

## Inventaire et autorité

| Référentiel | Autorité canonique | Propriétaire | Unité | Modules consommateurs | Mode de changement |
|---|---|---|---|---|---|
| Taux horaires | `production_cost_center_rates` | Méthodes + Direction | EUR/heure | Méthodes, devis, marges, production | Centre, quatre yeux |
| Calendriers | `programmation_calendars` | Planification | minutes ouvrées/jour | planning, production, délais | Centre, quatre yeux |
| Coûts matière | `fournisseur_catalogue` + historique | Achats + contrôle de gestion | devise/unité d'achat | achats, devis, marges, réapprovisionnement | Centre, quatre yeux |
| Unités/conversions | `units` + `fournisseur_catalogue` | Méthodes + magasin | unité stock/unité achat | stock, achats, production, MRP | Centre, quatre yeux |
| Délais fournisseurs | `fournisseur_catalogue` + historique | Achats | jours calendaires | achats, planning, stock, MRP | Centre, quatre yeux |
| Valorisation stock | `erp_settings[stock.valuation_method]` | Direction + finance | méthode | stock, marges, finance, direction | Centre, quatre yeux |
| Cartes de taux marge | tables SOL-13 | Contrôle de gestion | EUR/h, EUR/u ou % | devis, marges, direction | workflow SOL-13 |
| Politiques stock | tables SOL-19 | Responsable stock | jours, semaines, % | stock, MRP, direction | workflow SOL-19 |

La décision de valorisation active est le CUMP (`WEIGHTED_AVERAGE`), déclarée
par Keenan Martin le 11/08/2026. Une évolution reste techniquement possible,
mais exige une proposition sourcée, une approbation distincte et une date
d'effet non rétroactive.

## Valeurs dispersées recensées

| Emplacement | Classification | Décision |
|---|---|---|
| Gammes et OF : `taux_horaire`, `hourly_rate_applied` | snapshot historique, pas une source | conserver ; la source et la date sont figées avec l'opération |
| Ancien éditeur de pièce : champs numériques initialisés à `0` | valeur de brouillon locale | ne pas traiter comme référence ni comme coût fiable ; la publication moderne résout le taux centre et marque `ABSENT` lorsqu'il manque |
| `methodes-policy` : zéro technique avec `taux_horaire_source=ABSENT` | contrainte de stockage héritée | conserver tant que la colonne est non nulle ; les DTO exposent `null`, jamais un faux `0 €/h` |
| Coût/TVA saisis sur une ligne d'achat/devis | donnée transactionnelle | hors référentiel ; chaque document garde son snapshot |
| Paramètres ABC/couverture/dormance | politique versionnée SOL-19 | lecture dans le centre, modification dans son workflow spécialisé |
| Cartes de taux marge | politique versionnée SOL-13 | lecture dans le centre, modification dans son workflow spécialisé |
| `Europe/Paris` | limite d'instance actuelle | explicite et validée ; évolution via SOL-37/SOL-40 uniquement |
| constantes de protocole, limites de taille et seuils de sécurité | configuration technique | hors données métier ; changement par release/configuration contrôlée |

Les recherches de contrôle couvrent les usages de `taux_horaire`,
`production_cost_center_rates`, `working_days`, `delai_jours`,
`coef_conversion`, `prix_unitaire`, `valuation_method` et les politiques SOL-13/
SOL-19 dans les deux dépôts. Aucun générateur aléatoire ni fixture de
démonstration n'alimente le centre en production.

## Règles opérateur

1. Corriger d'abord les dépendances (unité, centre, ligne catalogue) dans leur
   module propriétaire.
2. Charger ou saisir un document JSON borné à 1 Mo.
3. Examiner la comparaison avant/après, les avertissements et tous les modules
   affectés.
4. Soumettre une justification, une source et une fiabilité. La date d'effet ne
   peut pas être passée.
5. Faire approuver par un second acteur autorisé.
6. Appliquer uniquement lorsque la date est atteinte. Une divergence de source
   oblige à refaire la comparaison.
7. Vérifier la version créée et les valeurs canoniques dans le module concerné.

Une même clé d'idempotence rejouée avec le même contenu retourne le résultat
initial ; avec un autre contenu elle est refusée. Les unités doivent exister
dans `units`, une conversion identité doit valoir exactement 1, les codes
calendrier sont uniques, les plages horaires cohérentes et les taux datés
strictement croissants.

## Import, export et conservation

Le format d'export est `CERP_REFERENCE_DATA_EXPORT` version 1 et porte son
SHA-256. Il contient les valeurs, dates, sources, fraîcheur, fiabilité et
versions visibles, sans secret. L'import réutilise le contrat de proposition :
il ne contourne ni les validations, ni le RBAC, ni les quatre yeux.

Les décisions et versions sont append-only. Les audits CERP+ enregistrent
l'acteur et l'action sans contenu sensible. Ne jamais modifier directement les
tables SOL-33 pour « corriger » une décision ; conserver la preuve et créer une
nouvelle proposition datée.

## Contrôles et escalade

- Valeur absente : flux métier bloqué ou fiabilité `UNAVAILABLE`, avec lien vers
  le module propriétaire.
- Source ancienne : vérifier avec le propriétaire avant proposition.
- Conflit d'empreinte : ne pas forcer ; recharger et comparer.
- Chevauchement/date non monotone : corriger la période, ne pas réécrire
  l'histoire.
- Patch non installé : appliquer le runbook migration SOL-06 après dump et
  preflight ; aucun fallback silencieux.
