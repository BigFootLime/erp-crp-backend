# RETOURS-METIER-1089

Suivi : BigFootLime/crp-systems-web#1089.

- Badge physique : horaires obligatoires, réparation append-only au prochain badge, idempotence sous verrou salarié, recalcul des deux journées. Les périodes clôturées ne sont pas modifiées. La distinction du premier badge arrivée/départ utilise le milieu des horaires configurés, sans heure codée en dur.
- Préparation livraison : indice et date AR dans le contrat du panier. La correction MP/TR synchronise les références courantes avec le lot et conserve les anciennes dans l’audit. Les BL ouverts concernés perdent leur vérification ; les expédiés restent immuables.
- Commande : la séparation stock/fabrication dépend explicitement de SHIP_AVAILABLE_NOW. SHIP_ALL_TOGETHER conserve une affaire de livraison commune.
- Préparation OF : la sélection d’une révision actualise la version effective de l’OF non figé. Le clonage conserve les achats en plus de la gamme et de la nomenclature.

Aucune modification de schéma n’est nécessaire. Le cas signalé du lot de l’article 175 00320 000 A doit être repris par une correction contrôlée et auditable, sans modifier les instantanés historiques.
