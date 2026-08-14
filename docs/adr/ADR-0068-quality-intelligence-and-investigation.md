# ADR-0068 — Mesure qualité, SPC et enquête de traçabilité

- Statut : accepté
- Date : 2026-08-14
- Décideur technique : CERP+
- Contrat : `CERP-QUALITY-INTELLIGENCE-1.0.0`
- Issues : frontend #646, backend #450

## Contexte

Les contrôles, non-conformités, actions, instruments de mesure et liens de
traçabilité existaient, mais sans contrat décisionnel commun. Une moyenne ou un
coût pouvait donc être affiché sans dénominateur, une cause restait en texte libre
et l'absence de preuve pouvait être confondue avec zéro. Le temps réel d'une
enquête n'est par ailleurs pas historisé par des événements de début et de clôture.

## Décision

- Le FPY est la quantité conforme du premier contrôle validé d'une source divisée
  par sa quantité contrôlée. Le premier passage est identifié par
  `source_type + source_id`, puis par date de validation, création et identifiant.
- Le PPM est `(quantité contrôlée - quantité conforme) / quantité contrôlée ×
  1 000 000`. Le délai de clôture est la moyenne calendaire entre détection et
  clôture des NC closes pendant la période.
- Rebuts, retouches et autres coûts de non-qualité proviennent exclusivement du
  ledger append-only `quality_cost_entry`. Une entrée porte devise, date,
  catégorie, source, preuve éventuelle, acteur et clé d'idempotence. Plusieurs
  devises sans politique de conversion rendent la consolidation indisponible.
- Toute métrique expose formule, unité, période, source, fraîcheur, numérateur,
  dénominateur, manquants et fiabilité `CONFIRMED`, `PARTIAL` ou `UNAVAILABLE`.
  Une absence n'est jamais convertie en zéro. Un COPQ incomplet est une borne
  inférieure `PARTIAL`, avec les catégories manquantes visibles.
- Les causes sont choisies dans `quality_cause_catalog`. Leur affectation est
  auditée, idempotente et protégée par verrou optimiste ; l'historique n'est pas
  réécrit silencieusement.
- Une action CAPA qui exige une preuve ne peut passer à `VERIFIED` sans
  vérificateur, date, verdict d'efficacité et document actif lié.
- Le SPC est fermé par défaut. Une politique versionnée doit préciser
  caractéristique, unité, règle, taille de sous-groupe, nombre minimal et cadence.
  Seuls des sous-groupes complets, dans la période d'effet de la version et avec
  au moins 90 % de respect de cadence autorisent l'état `enabled`.
- Le moteur métrologie existant reste l'autorité d'emploi : quarantaine et états
  bloquants interdisent la mesure ; une échéance suit la stratégie versionnée
  `BLOCK`, `WARN` ou `NONE`. Le centre existant fournit calendrier, instruments
  critiques échus, quarantaine et échéances proches.
- L'enquête réutilise le graphe de traçabilité canonique, de la matière à la
  livraison. Elle mesure nœuds matière/livraison, arêtes prouvées, liens manquants
  et couverture. La durée de génération technique est distincte du temps métier.
  Faute d'événements `investigation_started_at` et `investigation_closed_at`, ce
  dernier reste explicitement `UNAVAILABLE`.
- `analytics_read`, `nc_manage` et `capa_manage` sont contrôlés côté API. Un accès
  ordinaire au module n'élève pas le rôle ; seul un override de compte explicitement
  élevé ou un rôle autorisé peut franchir le gate.

## Conséquences

Le cockpit fonctionnel peut présenter un Pareto, une tendance, les CAPA à traiter,
le calendrier métrologique et le graphe d'enquête sans fabriquer de valeur. Les
anciennes NC sans cause structurée et les anciens contrôles sans source restent
visibles comme données partielles. Aucune politique SPC n'est créée par migration :
la Qualité doit déclarer les règles réelles avant activation.

## Migration et retour arrière

La migration ajoute le catalogue de causes, le ledger de coûts et les politiques
SPC, ainsi que les contraintes d'audit et de preuve CAPA. Elle amorce uniquement
un vocabulaire de causes générique ; elle ne crée aucun coût, aucune observation
ni politique SPC.

L'ancien backend ignore ces objets additifs. Après utilisation réelle, le retour
sûr consiste à redéployer le SHA précédent en conservant le schéma. Le rollback
destructif est limité à `cerp_test` et refuse de supprimer une cause affectée, une
écriture de coût ou une politique SPC. Une restauration se fait dans une nouvelle
base à partir du dump vérifié, jamais en écrasant la base active.
