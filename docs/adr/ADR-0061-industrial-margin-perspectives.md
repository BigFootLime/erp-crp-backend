# ADR-0061 — Marges industrielles honnêtes et traçables

- Statut : accepté
- Date : 2026-08-11
- Décideur métier : Keenan Martin
- Valorisation matière : CUMP, décision déclarée du 11/08/2026

## Contexte

Le moteur initial opposait `PLANNED` et `ACTUAL`. Cette lecture ne distinguait pas le coût proposé au client, le coût standard daté et la meilleure estimation à terminaison. Une fiche technique reconstruisait en outre une « marge théorique » côté navigateur en remplaçant des valeurs absentes par zéro.

## Décision

`CERP-MARGIN-2.0.0` publie quatre perspectives :

| Base | Définition | Fiabilité maximale |
|---|---|---|
| `QUOTED` | Prix et coûts figés dans le devis | `ESTIMATED` |
| `STANDARD` | Quantités prévues et paramètres applicables à la date | `ESTIMATED` |
| `UPDATED` | Coûts engagés disponibles et temps à terminaison valorisé sur `max(prévu, réel)` | `ESTIMATED` |
| `ACTUAL` | Sources réellement enregistrées et valorisées | `ACTUAL` |

`PARTIAL` est obligatoire dès qu'une entrée requise manque. `ACTUAL` exige un calcul complet et uniquement des sources `VERIFIED`; une donnée déclarée ou estimée ramène le statut à `ESTIMATED`.

Chaque preuve comporte définition, unité, période, fraîcheur, fiabilité, type/référence de source et document métier. Les écritures v2 incomplètes sont rejetées par validation API et contrainte SQL. Les lignes historiques v1 restent lisibles avec `UNKNOWN`; elles ne sont pas réécrites.

## Sources canoniques

- matière constatée : sorties de stock `POSTED` consommées par une réservation d'OF, quantité × `unit_cost` CUMP;
- temps : opérations d'OF et taux figé à leur préparation;
- sous-traitance : quantités réellement réceptionnées × prix/remise/frais de la ligne fournisseur;
- rebuts et retouches : déclarations append-only; une quantité positive sans valorisation reste manquante;
- paramètres : référentiels de taux versionnés et datés;
- frais non connectés : entrée versionnée ou `NOT_APPLICABLE` explicite.

Pour un OF sans rattachement probant au devis, `QUOTED` reste incomplet : le moteur n'utilise jamais les heures réelles comme substitut. L'estimation `UPDATED` est explicitement un proxy à terminaison pour le temps; elle ne prétend pas connaître un avancement physique absent.

Le waterfall serveur est `prix → matière/achats → temps → sous-traitance → rebuts/retouches → autres → marge`. Une étape inconnue reste `null` et ne devient jamais zéro.

## Compatibilité

Les snapshots `PLANNED` historiques restent lisibles. À la lecture, une entrée `PLANNED` sert de repli `STANDARD` seulement en l'absence d'une version `STANDARD` plus récente. Les nouveaux endpoints d'écriture n'acceptent plus `PLANNED`.

Le reporting client agrégé demeure explicitement indisponible : le moteur objet est réel, mais l'allocation multi-objets, les retours, avoirs et frais indirects ne sont pas encore exhaustivement réconciliés.

## Retour arrière

En test/dev, le script SOL-13 retire les colonnes et contraintes uniquement si aucune preuve v2, aucune nouvelle perspective et aucun taux `REWORK` n'existent. En production, le retour arrière impose la restauration du dump pré-migration afin de préserver la cohérence des preuves append-only.
