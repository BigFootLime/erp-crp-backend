# ADR-0084 — Préparation des données pour la prévision de demande

- Statut : accepté ; prévision statistique non activée
- Date : 2026-08-15
- Décideur produit : Keenan Martin
- Périmètre : demande, prévision et consommation MRP

## Contexte

SOL-39 exige un historique propre, stable et représentatif. `cerp_prod` ne contient
encore aucun article, devis, commande client ou fournisseur, facture, OF, pointage
ou mouvement de stock. Il n'existe donc aucune observation de demande, aucun mois
actif et aucun résultat permettant un backtest.

La projection à treize semaines de SOL-19 n'est pas une prévision statistique : elle
propage les commandes, besoins d'OF, réservations, réceptions attendues, délais et
politiques explicitement enregistrés. Elle reste utile et ne doit pas être renommée
« prévision IA ».

## Décision immédiate

Aucun modèle, dataset de démonstration dans le produit, suggestion automatique ou
KPI de précision n'est ajouté. Toute prévision reste `UNAVAILABLE` tant que le gate
ci-dessous n'est pas satisfait sur le segment calculé.

## Gate de qualité par article ou famille

Un segment devient candidat seulement si le rapport daté prouve :

1. au moins 52 semaines consécutives observées ; deux cycles complets sont requis
   avant de tester une saisonnalité annuelle ;
2. une date et une quantité fiables pour commandes, annulations, retours et
   substitutions, avec unités convertibles ;
3. la continuité des références ou un crosswalk versionné pour renommages,
   remplacements et changements de famille ;
4. les périodes de rupture identifiées, afin de ne pas prendre une demande censurée
   pour une absence de besoin ;
5. les changements de prix, client, marché, capacité ou politique marqués comme
   ruptures de régime ;
6. une couverture temporelle, un taux de valeurs manquantes, de doublons et
   d'événements tardifs publiés avec un seuil approuvé ;
7. suffisamment de périodes non nulles pour distinguer demande régulière et
   intermittente ; le minimum dépend du segment et reste visible.

Le nombre de semaines ne suffit jamais seul : une série complète mais non
représentative reste refusée.

## Baselines et backtesting futur

La première version compare, par validation chronologique à origine glissante :

- naïf dernière période ;
- naïf saisonnier uniquement avec deux cycles qualifiés ;
- moyenne mobile simple ;
- méthode intermittente de type Croston seulement pour le segment correspondant.

Une méthode plus complexe n'est admise que si elle améliore durablement une baseline
sur plusieurs fenêtres. Le rapport expose MAE, WAPE, MASE et biais, plus un coût
métier paramétré des surstocks et ruptures. Les intervalles d'incertitude proviennent
des erreurs hors échantillon, pas d'un pourcentage arbitraire.

## Frontière MRP et validation humaine

Une prévision approuvée porte version, période d'apprentissage, date de calcul,
méthode, segment, unité, source, fraîcheur, intervalle et fiabilité. MRP la consomme
comme une source séparée des commandes fermes et des OF ; il ne double compte jamais
les deux. Une proposition automatique est interdite si le gate, les unités, délais,
lots, stock de sécurité ou capacités sont incomplets.

L'utilisateur valide ou refuse chaque version avec motif. Le rejeu conserve les
entrées et l'empreinte. Un suivi mesure dérive de distribution, biais, couverture des
intervalles et coût d'erreur ; un seuil franchi désactive la proposition automatique
mais ne réécrit pas les décisions historiques.

## Tests futurs

Les données synthétiques seront réservées aux tests et marquées comme telles. Elles
couvriront saisonnalité, intermittence, rupture de stock, référence remplacée,
retour, annulation et changement de régime. Elles ne seront jamais importables ni
affichées par le build de production.

## Compatibilité et rollback

Cette décision ne modifie ni runtime ni schéma. SOL-19 continue de calculer sa
projection explicable à partir des besoins enregistrés. Le rollback documentaire
retire l'ADR ; une future version de prévision devra être désactivable sans supprimer
ses preuves et sans interrompre le MRP déterministe.
