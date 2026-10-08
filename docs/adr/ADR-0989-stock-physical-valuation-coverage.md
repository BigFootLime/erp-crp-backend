# ADR 0989 — Rapprochement physique avant lecture du CUMP

Statut : implémenté, recette métier finale différée. Issue backend #989, WP278.

## Problème

Une projection financière peut être en retard ou incomplète alors qu'un montant
existe déjà. Lire ce montant sans le rapprocher du stock utilisable ferait passer
une information ancienne ou sans preuve pour un CUMP fiable.

## Décision

`GET /stock/articles/:id/valuation` lit article, stock physique, soldes, preuves,
barrière de capture et retard dans **une seule instruction PostgreSQL**. Le
rapprochement travaille en décimales exactes sur article, propriétaire, unité et
devise. Le stock utilisable est `qty_total - qty_depreciated` ; les réservations
n'enlèvent pas de valeur. Les niveaux incluent déjà leurs lots : le stock société
est le niveau utilisable moins les lots appartenant aux clients. Les identifiants
clients sont opaques et leur casse est conservée.

Le montant et le coût unitaire ne sont disponibles que si la projection est
ACTIVE et initialisée, sans retard pour cet article, avec une formule supportée,
une preuve de solde et de journal intacte et une quantité physique identique.
Une source physique invalide masque aussi la quantité partielle calculable. Les
lots clients restent séparés et sans valeur société. Un article négatif, une
capture manquante ou une précision non supportée reste inconnu.

La route utilise l'authentification et la capacité Stock `read` existantes. La
politique `canViewArticleCosts` masque montants, coût unitaire, fiabilité financière
et référence financière pour les utilisateurs sans droit prix. Réponse `no-store`.
Les fenêtres sont bornées (10 000 observations physiques, 1 000 soldes) ; leur
dépassement renvoie une indisponibilité, sans résultat partiel.

## Limites et intégration

Cette lecture ne modifie ni stock ni projection et n'active pas le CUMP. Elle ne
remplace pas les adaptateurs de coûts de fabrication, les corrections de factures
ni la justification de l'ouverture historique. Aucun prix catalogue ou ancien
dernier prix de mouvement ne comble une source inconnue ; aucune conversion de
devise ou d'unité implicite. Le branchement des vues Stock/Marges reste un travail
distinct. Le projecteur conserve son état PREPARED jusqu'à ouverture justifiée et
recette commune. Aucun changement de schéma dans ce lot.

## Vérification et retour arrière

TypeScript, compilation, contrat OpenAPI et PREPARE/EXPLAIN sous `cerp_app` dans
Test et Production. Ces contrôles de structure ne constituent pas la recette
métier. Les scénarios automatisés préparés sont dans `cump-coverage.test.ts` et
la recette est dans `docs/recettes/RECETTE-0989-stock-physical-coverage.md` :
**NON EXÉCUTÉS**, à réunir à la fin du chantier selon la demande utilisateur.

Retour arrière : réinstaller l'artefact backend précédent vérifié. Aucune donnée
physique ou financière n'est écrite par cette route, aucune migration à annuler.
