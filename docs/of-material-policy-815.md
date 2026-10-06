# #815 — Matière physique et regroupement

Règles confirmées par Keenan : deux lots matière d’origine maximum sur toute la
fabrication d’un OF, un seul pour une pièce critique. Un achat attendu ou une
réception en attente de libération ne permet aucun début d’OF, y compris découpe.

L’API de disponibilité vérifie chaque besoin de tout l’OF avec les réservations
physiques utilisables et les quantités déjà consommées. Les opérations gardent
leurs propres plafonds de production. Le transfert partiel entre opérations
ne dispense pas de la couverture initiale de toute la matière.

La réservation canonique contrôle les origines sous verrou OF. Les lots consommés
restent comptés à travers les révisions ; seules les filiations attestées par une
chute matière remontent à l’origine de la barre. Un lot client reste sa propriété.
La limite d’un OF critique est figée : retirer ensuite la criticité de la PT ne
permet pas de lui ajouter un deuxième lot. Les réceptions physiques sont conservées
même lorsque leur troisième origine empêche l’affectation à l’OF ; l’événement est
audité et la portion reste à affecter.

Un regroupement physique exige la même définition et des besoins matière préparés,
compatibles et intégralement réservés sur les sources. Son surplus doit également
être disponible dans les origines autorisées. La création recontrôle sous verrous
planning, OF puis lots ; son aperçu inclut les versions matière. Elle transfère les
réservations existantes sans nouveau mouvement de stock et sans double engagement.
Une table immuable conserve source OF, source besoin et réservation. La dissolution
avant engagement restitue ces références. Un OF source couvert ne peut pas créer
un second engagement matière. Les groupes d’organisation du planning sont inchangés.

## Recette commune à exécuter après tous les lots

- Achat attendu couvrant tout le manque : aucun début de découpe ou d’usinage.
- Un besoin couvert et un autre incomplet : toutes les opérations attendent.
- Réception libérée et réservation complète : démarrage accessible selon les autres prérequis.
- Deux origines ordinaires autorisées ; troisième refusée, y compris confirmations concurrentes.
- Critique : seconde origine refusée ; retrait ultérieur de criticité sans relâcher l’OF.
- Chute issue d’une barre engagée : même origine, preuves conservées.
- Réception d’un troisième lot : quantité physique reçue, affectation refusée et auditable.
- Regroupement de deux sources avec trois origines : refus ; sources intactes.
- Regroupement compatible : réservations transférées une seule fois ; dissolution non engagée restitue les sources.
- Surplus sans matière suffisante dans la limite : refus intégral du regroupement.

Tests métier ajoutés ; exécution des suites et recette navigateur différée à la fin
de l’ensemble L1–L7 sur instruction utilisateur du 7 octobre 2026. Compilation,
préflight/migration et santé des services restent requis à chaque livraison.
