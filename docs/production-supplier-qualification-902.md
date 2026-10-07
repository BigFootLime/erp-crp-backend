# Qualification fournisseur dès préparation OF — WP-284

La lecture `GET /production/ofs/:id/supplier-qualification` prend un article et un fournisseur existants, plus le catalogue sélectionné lorsqu’il est connu. L’article doit appartenir aux achats de la version applicable de l’OF : snapshot figé prioritaire, puis version sélectionnée pour les dossiers en préparation. Le catalogue doit appartenir à ce couple, être actif et applicable à la date de Paris.

Les homologations globales/par domaine et les agréments client utilisent le même lecteur que la commande fournisseur. Les catégories structurées restent prioritaires. Un producteur regroupé reprend les clients et articles produits de ses OF sources actifs. L’absence de décision reste explicitement non renseignée ; aucune homologation n’est fabriquée. Les dates sont inclusives et évaluées à Paris.

Cette projection exige les droits de lecture OF et de préparation des achats. Elle utilise une transaction répétable en lecture seule ; elle ne crée aucune commande, réservation ou décision. L’engagement fournisseur conserve la résolution de toutes ses origines et le verrouillage client puis fournisseur ; le diagnostic ne remplace pas cette validation, notamment pour les commandes regroupant d’autres OF ou les consommables communs.

L’interface partage la présentation des décisions avec la commande fournisseur et actualise le diagnostic lors du changement article/fournisseur/catalogue. Un contrôle indisponible ou une décision bloquante est affiché avant la préparation de la commande. Les saisies et décisions prévisionnelles restent conservables sans constituer un engagement.

Aucune migration. TypeScript, inventaire OpenAPI et compilation SQL sont les contrôles techniques de ce lot. La recette métier commune reste à exécuter à la fin du chantier : fournisseur expiré/non configuré, couple imposé, regroupement multi-clients, changement de catalogue/dossier et droits insuffisants.
