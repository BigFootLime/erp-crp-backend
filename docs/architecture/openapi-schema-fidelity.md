# Fidélité des schémas OpenAPI

L’inventaire généré atteste que chaque opération Express découverte est présente
dans `/api/v1/openapi.json`. Il ne prouve pas à lui seul que chaque entrée ou
sortie métier est décrite : les anciens wrappers `ApiRequest` et `ApiResponse`
restent volontairement génériques pendant la migration documentaire.

Le document expose donc deux mesures indépendantes :

- `x-cerp-route-coverage` mesure uniquement l’inventaire structurel des routes.
- `x-cerp-schema-fidelity` partage le même dénominateur mais classe, pour chaque
  opération, le schéma de requête et de réponse `2xx` en `precise`, `partial`,
  `generic`, `unknown`, ou `not_applicable` pour une opération sans corps de
  requête.

La classification résout récursivement les `$ref`. Une référence, un alias ou
une branche qui atteint `ApiRequest`/`ApiResponse` ne peut donc pas être
comptée comme précise. Une structure typée contenant une branche ouverte reste
`partial`; un objet nu ou un tableau sans `items` reste `generic`. Une absence
de schéma inspectable, une référence non résolue ou un cycle reste `unknown`,
qui prévaut sur `generic`. Les compteurs sont des catégories, non un score de
conformité API.

Le premier lot prioritaire couvre les dix routes du référentiel matière (capacité,
nuances, états et sous-états) et les quatre opérations de préparation
technique d’OF. Les corps sont dérivés des validateurs backend; les enveloppes
de réponse sont dérivées des contrôleurs et des consommateurs de l’interface.
Les sections de préparation et certains items d’évaluation restent ouverts par
conception, ce qui rend leur réponse `partial` plutôt que faussement précise.
La création et la modification de nuance sont également `partial` côté requête : la présence d’au
moins un champ de norme est exprimée par OpenAPI, tandis que le trim, le
caractère significatif et la cohérence avec la désignation principale sont
normalisés et validés à l’exécution. Le contrat ne rejette donc pas une valeur
brute que le validateur peut accepter après normalisation.

Ce document ne modifie aucune route, règle de rôle, accès de module, visa
Qualité, SQL ou comportement de service. Les erreurs décrites correspondent
aux branches des contrôleurs et validateurs concernés; elles ne remplacent pas
le format transversal d’erreur.
