# Couverture des composants avant montage — #902 / WP-284

`GET /production/ofs/:id/component-coverage` est protégé par la capacité OF `read`. Il expose les besoins de composants non annulés, leur sous-OF éventuel, les réservations actives non expirées, les quantités physiquement utilisables et les motifs qualité. Un achat ou un sous-OF attendu ne vaut jamais stock réservé.

Le lecteur `readOfComponentCoverageTx` est partagé par cette projection et la disponibilité opérationnelle des phases ASSEMBLAGE. Il conserve les règles de démarrage : besoins définis, quantités réservées suffisantes, stock physique libéré et contrôle qualité canonique ; un besoin déjà consommé reste couvert. Au démarrage, le contrôle existant verrouille les lots avant la relecture. La projection est une transaction répétable en lecture seule ; elle ne réserve et ne consomme rien. Son empreinte inclut les besoins, réservations et décisions qualité sans horodatage de consultation.

Les OF sources d’un regroupement exposent leur OF producteur ; la préparation dirige l’utilisateur vers cette fabrication. Cette projection n’ajoute aucun champ libre ni nouvelle règle de planification. La donnée vient des besoins synchronisés et du stock.

Aucune migration. Compilation TypeScript, inventaire OpenAPI et compilation SQL en lecture seule prévus avant déploiement. Recette métier différée, à exécuter avec celle de l’ensemble du chantier : montage sans besoins, besoin couvert, lot en quarantaine, réservation expirée, composant consommé, sous-OF prévu et retour du lot vers les composants.
