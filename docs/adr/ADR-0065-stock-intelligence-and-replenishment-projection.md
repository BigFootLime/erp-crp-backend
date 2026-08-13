# ADR-0065 — Frontière de fiabilité stock et projection de réapprovisionnement

- Statut : accepté
- Date : 2026-08-13
- Décideur technique : CERP+
- Contrat : `CERP-STOCK-INTELLIGENCE-1.0.0`
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/436

## Contexte

Le stock physique, les réservations, la quarantaine, les réceptions fournisseurs,
les inventaires et les propositions de réapprovisionnement existent dans des
modèles distincts. Les écrans savaient proposer un achat, mais ne pouvaient pas
expliquer de façon homogène la valeur, la rotation, la couverture, la dormance,
l'exactitude d'inventaire ou la date de rupture. Deux preuves indispensables ne
sont pas encore complètement matérialisées : les besoins OF non réservés et les
couches de coût CUMP par lot. Les remplacer par zéro donnerait une fausse
disponibilité et une fausse précision financière.

## Décision

Le backend reste la source autoritaire et expose un contrat de lecture versionné.
Chaque métrique transporte définition, unité, période, sources, fraîcheur,
fiabilité (`ACTUAL`, `PARTIAL`, `ESTIMATED`, `UNAVAILABLE`) et éléments manquants.
Une valeur inconnue reste `null`.

La politique est datée et append-only. En l'absence de décision enregistrée, le
serveur utilise une politique par défaut explicitement marquée `SYSTEM_DEFAULT` :

- ABC sur 365 jours ; A jusqu'à 80 % de valeur cumulée, B jusqu'à 95 %, C au-delà ;
- stock dormant après 180 jours sans sortie comptabilisée ;
- consommation historique sur 91 jours ;
- projection limitée à 13 semaines ;
- inventaire exact dans la tolérance `max(0,001 unité, théorique × 0,5 %)`.

Les formules retenues sont :

- valeur de stock : quantité physique hors dépréciation × dernier coût unitaire
  CUMP appliqué et traçable ; statut au mieux `ESTIMATED` tant que les couches de
  coût par lot ne sont pas matérialisées ;
- rotation : sorties annualisées ÷ stock physique utilisable courant ;
- couverture historique : stock disponible ÷ consommation hebdomadaire moyenne ;
- exactitude d'inventaire : lignes comptées dans la tolérance ÷ lignes comptées ;
- projection : stock initial utilisable + réceptions fermes convertibles et datées
  − réservations OF actives datables, par tranches glissantes de sept jours ;
- simulation : même projection avec une réception hypothétique en mémoire. Elle
  n'écrit ni mouvement, ni proposition, ni commande fournisseur.

Toutes les preuves d'une lecture ou d'une simulation sont prises dans un même
snapshot PostgreSQL `REPEATABLE READ READ ONLY`. Une échéance active déjà dépassée
est reportée au premier jour de projection et dégrade la fiabilité. Des valeurs
exprimées dans plusieurs devises ne sont jamais additionnées.

Quarantaine, blocage et dépréciation sont exclus du stock utilisable. Les unités ne
sont converties qu'avec un coefficient explicite. Les quantités non convertibles,
les demandes non datées et les réceptions non fermes dégradent la fiabilité ou
rendent le calcul indisponible. La classification ABC et les coûts sont masqués
sans permission financière.

## API et sécurité

- `GET /api/v1/stock/intelligence/overview` : permission stock en lecture ;
- `POST /api/v1/stock/intelligence/simulate` : permission stock en lecture,
  opération strictement sans écriture ;
- `POST /api/v1/stock/intelligence/policies` : permission de gestion des
  référentiels, clé `Idempotency-Key`, transaction `SERIALIZABLE`, reçu et audit.

L'isolation suit la base CERP sélectionnée. Les propositions existantes conservent
leurs verrous de niveaux de stock et leur contrôle optimiste de version.

## Conséquences

Le workbench peut expliquer la rupture, la quantité et la date proposées, puis
montrer les stocks avec et sans hypothèse. Il ne présente jamais un coût, un besoin
OF ou une couverture inconnus comme zéro. En contrepartie, certaines métriques
restent volontairement partielles jusqu'à la persistance des besoins OF non
réservés et des couches CUMP par lot.

## Migration et retour arrière

Le patch ajoute uniquement deux journaux append-only : versions de politique et
reçus d'idempotence. Le rollback est autorisé tant qu'aucune preuve n'existe ; dès
qu'une politique ou un reçu a été créé, il refuse la suppression. Le retour
applicatif consiste alors à redéployer la version précédente, qui ignore ces tables
additives. Un retour de schéma exige gel des écritures et restauration du dump
pré-migration dans une nouvelle base.
