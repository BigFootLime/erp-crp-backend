# Flux articles, achats et réception — 21 septembre 2026

Référence de travail : FLUX-ARTICLES-ACHATS-RECEPTION-20260921 (demande utilisateur, dossier local). Suivi : [crp-systems-web#1086](https://github.com/BigFootLime/crp-systems-web/issues/1086).

## Contrat métier

- Les profils TUBERECT, HEXA et L complètent les profils matière existants. Le client propriétaire est indépendant du profil. Une nouvelle référence matière client intègre son code client ; aucune référence historique n’est recalculée par la migration.
- `subcontract_definition` décrit la pièce technique, sa version, la famille de prestation, la description, la fourniture de matière (`CRP` ou `SUPPLIER`), le plan et le commentaire. Le serveur vérifie la catégorie sous-traitance et l’appartenance de la version à la pièce. Les anciennes fiches peuvent être complétées progressivement ; le contrat existant reste compatible lorsqu’aucune définition n’est envoyée.
- `supplier_conditions` utilise le catalogue fournisseur existant pour les matières, prestations, consommables et autres achats. Les champs ajoutés sont `forfait_ht`, `minimum_facturation_ht`, `price_tiers` (`qty_min`, `qty_max`, `unit_price`). Les bornes basses sont inclusives, les bornes hautes exclusives ; les paliers ne se chevauchent pas. Hors palier, le prix de base s’applique.
- Règle confirmée par l’utilisateur : **total HT = max(quantité × prix applicable + forfait, minimum de facturation)**, arrondi au centime. Les frais de ligne comprennent le forfait et le complément éventuel jusqu’au minimum. Une quantité inférieure au minimum de commande ou un prix absent est refusé en calcul catalogue.
- Une ligne avec `apply_catalogue_pricing: true` est tarifée par le serveur : fournisseur, article, unité, devise, validité et base de prix doivent correspondre. La copie des conditions est figée dans `catalogue_pricing_snapshot`. Une modification de quantité seule recalcule cette copie ; un prix négocié manuellement quitte ce mode.
- Les confirmations d’AR peuvent corriger prix et frais sur la commande et, par choix explicite, le prix de base ou le palier applicable du catalogue. Forfaits et minimums ne sont pas déduits d’un AR. Verrous, versions attendues et audit avant/après empêchent les écrasements silencieux. Les formulaires article transmettent aussi la version du catalogue qu’ils ont ouverte.
- Les lignes attendues et lignes à traiter exposent `flowContext` à CERP RÉCEPTION : profil/cotes/propriétaire, pièce/indice/plan et fourniture matière des prestations. La version de la file attendue tient compte de ce contexte. Le lot matière hérite du propriétaire client ; une contradiction avec le propriétaire de la réception bloque sa création.

## Mise en service, dans cet ordre

1. Faire relire les trois branches `feature/flux-articles-achats-reception-20260921` et enregistrer les révisions retenues. La publication et le déploiement ont été autorisés par l’utilisateur le 21 septembre 2026 ; les gates de release TEST puis PRODUCTION restent obligatoires.
2. Sur une copie de recette de la base cible : exécuter `db/patches/support/20260921_articles_purchase_flow.preflight.sql`. Toutes les lignes doivent être `ready = true`. Conserver les nombres de lignes et une empreinte des références d’articles existantes. Vérifier que le parcours Réception #1069 est déjà présent.
3. Sauvegarder la base cible suivant le runbook existant. Exécuter le runner canonique `node scripts/db-patches.js up --only 20260921_articles_purchase_flow.sql` sur la base explicitement choisie. Le sélecteur est enregistré avec son SHA-256 ; le runner contrôle l’inventaire complet et enregistre la migration. Exécuter une seconde fois pour vérifier le no-op. Le fichier possède sa transaction ; ne pas lui ajouter une transaction englobante.
4. Exécuter `db/patches/support/20260921_articles_purchase_flow.verify.sql`, comparer références et compteurs avant/après. Le patch ajoute trois profils, quatre colonnes et une table ; il ne modifie ni articles, ni lots, ni commandes historiques.
5. Déployer l’API après le patch, puis le frontend associé. Le nouveau code lit la table de sous-traitance : **ne pas le démarrer sur un schéma non migré**. Aucune option d’activation nouvelle n’est nécessaire.
6. Recetter : matière CRP et même forme client ; sous-traitance CRP puis fournisseur ; traitement existant ; tarifs avec paliers/forfait/minimum ; AR sans puis avec mise à jour catalogue ; formulaire ancien refusé après changement concurrent.
7. Construire et signer l’APK Réception selon la chaîne existante, l’installer sur une tablette pilote. Recetter BL, réception partielle, contrôle, emballage et stock ; rejouer une confirmation pour vérifier l’absence de double entrée. Un export JavaScript Android ne remplace pas cet essai.

## Retour arrière

Revenir aux versions précédentes de l’API, du web et de l’application mobile en conservant le schéma additif. Ne pas supprimer les colonnes ou la table : elles peuvent déjà contenir des conditions ou définitions saisies. Les nouvelles références matière et les montants de commande enregistrés restent des données métier. Toute restauration complète exige une décision distincte et une sauvegarde vérifiée.

## Vérification et limites

Build API, tests ciblés des codes matière, calculs, validations, routes achats, AR, concurrence catalogue et propriété des lots. La migration a été exécutée deux fois sur PostgreSQL embarqué PGlite avec un schéma minimal synthétique : contraintes, conservation des références et requêtes de contexte matière/sous-traitance/traitement vérifiées. Il ne s’agit pas d’une copie complète de la base de production.

Le nouveau calcul est activé par la sélection explicite des conditions dans la commande guidée et par le contrat API ci-dessus. Les propositions automatiques historiques conservent leur préparation de brouillons ; elles ne deviennent pas automatiquement des commandes tarifées avec cette nouvelle option. Les prix en kg/m face à une unité commandée différente, et les prix par multiples, demandent une conversion explicite ; aucune conversion monétaire ou géométrique implicite n’est inventée.

Les annotations source encore ambiguës (composition exacte du code traitement, règles manuscrites de débit, suivi global particulier des matières) restent à confirmer. Le référentiel de traitement de surface, les états Devis/Validé/Actif et les commandes de contrôle/emballage/stock existants sont réutilisés. Cette livraison ne réécrit pas tout le flux Commercial/Production.
