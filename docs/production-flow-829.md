# L5 — Consommables et achats sous-traités

## Flux livré

L’épuisement d’un consommable global solde tous les emplacements de cet article. Le scan, la version lue et la quantité physique totale sont vérifiés. Toute quantité réservée, bloquée ou indisponible empêche la sortie ; aucun stock protégé n’est consommé. Si l’utilisateur a les droits achats et choisit un fournisseur, le brouillon de réapprovisionnement de taille fixe est créé dans la même transaction. Les minimums et conditionnements du fournisseur restent applicables. Sans préparation achat autorisée, l’épuisement est enregistré et le besoin d’approvisionnement est signalé explicitement. Un consommable de production conserve son calcul au besoin manquant.

L’OF dispose d’une préparation de sous-traitance issue de son dossier technique figé. La répartition en pièces par origine matière crée des lignes distinctes, regroupées dans une commande pour un même fournisseur, devise et magasin. Les nouvelles pièces ne sont jamais inférées d’une longueur de barre. Les tarifs suivent le moteur existant : maximum du total quantité × prix unitaire + forfait et du minimum de facturation monétaire. Le minimum de commande en quantité est une autre contrainte.

Une commande de sous-traitance issue d’un OF reste non validable avant clôture de chaque prédécesseur. La somme des lignes actives ne peut dépasser ni l’OF ni les quantités réellement conformes de ces prédécesseurs. La ligne conserve OF, opération, article, unité et origine. Les quantités, prix et délais restent modifiables en brouillon ; la suppression de ce brouillon annule la ligne en conservant sa preuve d’origine. Les anciens brouillons sans cette preuve doivent être annulés et préparés depuis l’OF. Les commandes historiques envoyées sont conservées.

Le dossier d’expédition doit correspondre à la ligne, son opération et son unité et ne peut dépasser sa quantité. Le lot expédié doit être libéré et descendre de l’origine de la ligne. Les pièces conformes d’un retour peuvent poursuivre le flux pendant que les autres restent en Qualité.

## Validation et reprise

Migration additive `20261007_subcontract_purchase_origins_829.sql`, préflight et vérification associés. Les preuves d’origine sont immuables. Le retour aux binaires précédents conserve cette table et toutes les transactions ; aucune suppression de données métier dans le rollback.

Compilation et préparation SQL sur schéma isolé avant déploiement. Les tests de domaine et la recette transversale sont réservés à la fin des lots L1–L7, à la demande de l’utilisateur. Vérifier alors épuisement multi-emplacements, refus de stock réservé, reprise idempotente, deux origines et deux lignes, précédent ouvert puis clôturé avec 97 conformes / 100 prévus, modification d’un brouillon, annulation et nouvelle préparation, origine erronée à l’expédition, réception physique entière puis libération qualité partielle. Aucun e-mail réel envoyé par cette préparation.

Une prestation tarifée en poids ou en longueur demande une conversion métier distincte : ce flux refuse cette conversion implicite et invite à choisir un tarif par pièce.
