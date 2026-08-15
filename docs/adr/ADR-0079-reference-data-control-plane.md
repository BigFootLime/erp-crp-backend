# ADR-0079 — Centre de contrôle des données de référence

- Statut : accepté
- Date : 2026-08-15
- Décisionnaire : Keenan Martin
- Portée : SOL-33

## Contexte

Les paramètres qui pilotent les coûts, les délais et la disponibilité existent
déjà dans plusieurs domaines CERP+. Les recopier dans une nouvelle table
« maître » créerait deux vérités et casserait les snapshots historiques des
gammes, OF, marges et mouvements. En revanche, leur modification n'avait pas
une frontière commune de comparaison, d'approbation et de traçabilité.

## Décision

Le centre de données de référence est un **plan de contrôle**, pas une seconde
base métier. Les tables propriétaires restent canoniques :

- `production_cost_center_rates` pour les taux horaires ;
- `programmation_calendars` pour les calendriers ;
- `fournisseur_catalogue` et son historique pour coûts matière, conversions et
  délais fournisseurs ;
- `erp_settings[stock.valuation_method]` pour la règle de valorisation ;
- les workflows spécialisés SOL-13 et SOL-19 pour les cartes de taux de marge
  et les politiques de décision stock.

Toute écriture depuis le centre suit : prévisualisation → proposition
idempotente → approbation par un autre acteur → application à date d'effet.
La prévisualisation compare les valeurs canoniques, affiche les modules touchés
et produit une empreinte SHA-256. L'application verrouille la proposition,
recalcule cette empreinte et refuse une source modifiée entre-temps.

Les versions de gouvernance sont ajoutées sans mutation ni suppression. Une
date d'effet antérieure au jour courant est refusée ; une correction historique
doit utiliser un traitement explicite et audité distinct. Les périodes bornées
ne peuvent pas se chevaucher et une nouvelle version doit être postérieure à la
dernière. Les snapshots métier déjà produits ne sont jamais recalculés.

## Sécurité et responsabilités

La lecture/export est limitée aux rôles de gestion concernés. La proposition
et l'import demandent une capacité métier explicite. L'approbation et
l'application sont réservées à Direction/Administration et l'auto-approbation
est interdite en API et par contrainte SQL. L'authentification, le contrôle de
module et le MFA renforcé des mutations administratives restent appliqués en
amont.

Le propriétaire métier, la définition, l'unité, la source, la fraîcheur, la
fiabilité et le chemin d'action sont servis avec chaque référentiel. Une valeur
absente reste `null`/`UNAVAILABLE` et n'est jamais présentée comme zéro.

## Conséquences

Le centre fournit une vue et une gouvernance communes sans déplacer les règles
de calcul hors de leur domaine. Les consommateurs continuent de lire les
sources historiques existantes. Les exports JSON sont bornés, versionnés et
signés par empreinte ; les imports sont validés et comparés avant toute
proposition.

Le fuseau de calendrier est actuellement limité à `Europe/Paris`, cohérent avec
le périmètre mono-site français déployé. Son ouverture dépendra de SOL-37/SOL-40
et ne doit pas être anticipée sans besoin contractuel.

## Retour arrière

Avant toute donnée SOL-33, le script de rollback peut supprimer les objets
ajoutés. Dès qu'une proposition, décision ou version existe, il refuse : le
retour arrière réaliste est alors le redéploiement de l'application précédente
en conservant les tables, ou la restauration cohérente du dump pré-migration
dans une base neuve.
