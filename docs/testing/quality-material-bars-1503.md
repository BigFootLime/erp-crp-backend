# Qualité : quantité physique et réessai — frontend #1503 / backend #1246

## Changement

Les soldes stock exposent l'identifiant de stock_batch et l'obligation de renseigner les barres physiques. Le détail d'une NC expose le reliquat pré-stock lorsqu'il est identifié par le parcours réception existant, avec unité et limite de quantité.

La création d'une décision accepte une clé UUID optionnelle. Une transaction verrouille acteur/clé, vérifie l'empreinte de la requête et conserve le résultat dans `quality_command_receipts`. Un réessai identique restitue la décision existante sans mouvement ni audit supplémentaires ; une réutilisation avec un autre contenu est rejetée. Le service partagé reste utilisé par les commandes Qualité 360.

Un SCRAP ou RETURN_SUPPLIER de quantité définie ajuste cette quantité sans remplacer systématiquement le verdict du lot entier par BLOQUE. Le verdict préalable est conservé, y compris s'il est déjà bloqué. HOLD/RELEASE restent des décisions explicites.

## Vérifications

Tests ciblés : commande rejouée, conflit de clé, validation UUID, contexte réception ambigu, quantité partielle conservant le reste libéré, maintien d'un blocage existant et quarantaine explicite. Les adaptateurs de mouvement matière et les routes Qualité restent couverts par leurs tests existants.

Aucune migration additionnelle dans ce lot. Les migrations physiques de #1246 restent nécessaires et ne sont pas déclarées déployées.

Le 12 octobre 2026, le test PostgreSQL `closes a partial receipt only after its rejected quantity has a closed disposition` passe sur le schéma complet migré dans un conteneur éphémère sans accès réseau extérieur. Il vérifie 100 pièces reçues, 60 acceptées et mises en stock, puis 40 retournées au fournisseur : le stock accepté reste identique, le reliquat qualité passe de 40 à 0, et le rejeu de la même commande rend la même décision sans double effet. Un retour supplémentaire et une libération excessive sont refusés ; la réception ne se clôture qu'après clôture de sa NC. Un test exécuté, dix-sept autres volontairement exclus de cette exécution ciblée.

Cette preuve concerne le service métier avec PostgreSQL réel. Le parcours HTTP/interface sur Base Test, les étiquettes et les autres variantes restent à qualifier. Les bases Test/Prod n'ont pas été modifiées par cette vérification.
