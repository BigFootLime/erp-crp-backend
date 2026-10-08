# ADR-1016 — Transport des commandes matière

Statut : développement ; WP-278, issue #1016. Valorisation PREPARED, recette commune NON EXÉCUTÉE.

Une réception #980 conserve le transport global mais pas toutes les lignes nécessaires à son allocation. La migration #1016 ajoute une nouvelle fonction de capture et réutilise le nom du trigger existant ; l’ancienne fonction et tous les snapshots restent conservés. Le format principal reste compatible, avec une base transport optionnelle versionnée. Seules les réceptions futures capturent cette base. Le rollback restaure le trigger précédent et conserve les preuves produites.

Les lignes actives de la commande sont lues dans le même snapshot de requête que sa réception, sans verrou tardif sur les achats. Le JSON est limité à 501 lignes pour détecter une source au-delà de 500 : elle reste financièrement inconnue. Les identifiants, devise, prix, quantité, remise, forfait et transport sont des faits serveur, pas une nouvelle saisie utilisateur. La source demeure DECLARED, distincte d’une facture approuvée.

Le transport se répartit proportionnellement au montant HT net de chaque ligne (quantité × prix avec remise, plus forfait). Les quantités d’unités différentes ne sont jamais additionnées. Une différence d’allocations cumulées sur les lignes triées par UUID conserve le total à douze décimales et donne un résidu déterministe. Une autre différence cumulée, plafonnée à la quantité commandée, attribue à chaque réception son transport et son forfait sans dépassement en sur-réception.

L’empreinte de la base normalisée inclut toutes les lignes monétaires, commande, fournisseur et devise ; elle exclut dates et statuts qui évoluent lors des réceptions. Le curseur transactionnel incorpore cette empreinte et le montant de transport de ligne. Toute modification, disparition d’un transport auparavant positif, preuve invalide ou trou d’historique empoisonne l’allocation. Les curseurs sans transport gardent la compatibilité antérieure. L’ancienne capture avec transport positif reste UNKNOWN ; aucun backfill n’est permis.

Une preuve financière manquante ne bloque jamais la réception physique. Il n’y a ni changement de montant des commandes, ni approbation de facture, ni activation du projecteur. Les corrections financières de factures tardives restent un chantier séparé.

Validation : strict TypeScript/build/OpenAPI et compilation DDL/SELECT sous cerp_app avec ROLLBACK ; backup, vérification et rejeu de migration avant publication. Fixtures et scénarios métier/concurrence à exécuter dans la recette finale groupée.
