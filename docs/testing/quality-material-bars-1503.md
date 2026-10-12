# Qualité : quantité physique et réessai — frontend #1503 / backend #1246

## Changement

Les soldes stock exposent l'identifiant de stock_batch et l'obligation de renseigner les barres physiques. Le détail d'une NC expose le reliquat pré-stock lorsqu'il est identifié par le parcours réception existant, avec unité et limite de quantité.

La création d'une décision accepte une clé UUID optionnelle. Une transaction verrouille acteur/clé, vérifie l'empreinte de la requête et conserve le résultat dans `quality_command_receipts`. Un réessai identique restitue la décision existante sans mouvement ni audit supplémentaires ; une réutilisation avec un autre contenu est rejetée. Le service partagé reste utilisé par les commandes Qualité 360.

Un SCRAP ou RETURN_SUPPLIER de quantité définie ajuste cette quantité sans remplacer systématiquement le verdict du lot entier par BLOQUE. Le verdict préalable est conservé, y compris s'il est déjà bloqué. HOLD/RELEASE restent des décisions explicites.

## Vérifications

Tests ciblés : commande rejouée, conflit de clé, validation UUID, contexte réception ambigu, quantité partielle conservant le reste libéré, maintien d'un blocage existant et quarantaine explicite. Les adaptateurs de mouvement matière et les routes Qualité restent couverts par leurs tests existants.

Aucune migration additionnelle dans ce lot. Les migrations physiques de #1246 restent nécessaires et ne sont pas déclarées déployées. Avant intégration : vérifier le parcours PostgreSQL complet avec une réception partiellement stockée, puis la recette via HTTP sur Base Test. La garde pré-stock partagée reprend encore la détection historique des mouvements de lignes ; ne pas assimiler sa couverture unitaire à une validation de tous les cas mixtes.
