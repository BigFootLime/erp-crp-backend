# Préparer le manque avant fournisseur

WP-284, issue #902. Prolongement du contrôle en amont de `material-preflight-902.md`.

Le registre `production_purchase_preparations` enregistre une intention d’achat sans fournisseur ni tarif obligatoire. Son périmètre est une source de la version technique de l’OF (MP/consommable) ou l’article partagé GLOBAL_PACK. La clé ne dépend jamais des quantités, du stock ou du fournisseur. Le besoin ne devient ni réservation ni approvisionnement attendu : seuls les registres canoniques de stock et de commandes établissent ces engagements.

La lecture est sans écriture. À l’ouverture des vues de préparation, un utilisateur habilité aux achats déclenche automatiquement la commande idempotente `prepare-purchases`, avec la version de couverture lue. Le serveur reprend planning puis OF, recontrôle cette version, rafraîchit les manques et conserve l’événement. Un double écran ou une réouverture ne crée pas deux demandes pour la même source. Les utilisateurs sans droit achats voient le besoin sans pouvoir l’enregistrer. Une erreur reste visible et récupérable. Les quantités impossibles à calculer sont NULL et les actions à compléter restent explicites.

Les propositions reprennent FIFO, qualité, exigences et limites d’origines de la lecture canonique. Les achats déjà affectés protègent le besoin ; les achats attendus compatibles encore libres imposent un examen avant un nouvel achat. La matière client conserve son appel de bruts. GLOBAL_PACK garde un seul réapprovisionnement commun, sans affectation fictive à un OF.

Le choix fournisseur/destination dispose d’une commande distincte : il ne réécrit pas les exigences ni la règle de débit et n’invalide pas artificiellement la validation technique. Le fournisseur est contrôlé avant ce choix et à la création du brouillon. Un tarif d’un ancien fournisseur n’est jamais réutilisé pour un autre fournisseur. Le tarif inconnu reste NULL dans le brouillon, puis doit être confirmé pour sa validation. La confirmation de couverture conserve `createMaterialDraftsTx` comme propriétaire de la commande et des allocations ; aucune seconde implémentation de commande fournisseur.

La demande GLOBAL_PACK contient le conditionnement de l’article en unités de stock, sans fournisseur propre à un OF. Le choix fournisseur et la conversion commerciale sont conservés dans le parcours de confirmation existant. Une définition non fiable garde une demande propre à l’OF à compléter et ne remplace jamais la demande partagée. Les sources disparues ou passées en matière client sont périmées même lorsque la nouvelle liste de demandes est vide.

La préparation est recalculée sur les lectures et confirmations, sans modifier silencieusement les commandes existantes. Un changement de version laisse l’ancienne demande périmée avec son histoire. Les contenus inchangés ne génèrent pas de nouvel événement. Le schéma reste additive au retour sur un ancien binaire.

Recette différée : réouverture, double écran/concurrence, manque partiel, prix inconnu, achat attendu partiellement affectable, changement de fournisseur, changement de version, global commun entre plusieurs OF et MP client. Tests de domaine ajoutés, non exécutés selon instruction ; compilation, lint et vérification du schéma restent requis avant release.
