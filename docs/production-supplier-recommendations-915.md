# WP278 — Propositions fournisseur pour un achat OF

Issue #915, frontend #1195. Ce premier incrément de WP278 couvre les achats matière, consommables et prestations de l’OF. Il ne termine pas PIC/PDP, les coûts de revient ou l’apprentissage des affectations machine.

## Sources et règles

`GET /production/ofs/:id/supplier-recommendations` est authentifié, exige la lecture OF et le droit achat OF. Les montants ne sont calculés et exposés qu’avec le droit de lecture des prix. La réponse contrôle que l’article appartient aux achats de la version PT applicable, en privilégiant le dossier figé de l’OF. Transaction cohérente en lecture seule ; aucun fournisseur, engagement, agrément, réservation ou dossier n’est modifié.

- Historique : commandes réellement envoyées de cet article exact dans les 24 derniers mois, lignes actives non annulées. Les brouillons ne créent pas de préférence.
- Délai réel : médiane en jours calendaires entre envoi et dernière réception clôturée, uniquement lorsque les réceptions physiques couvrent toutes les lignes actives de cet article dans la commande. Ce délai n’est pas une mesure OTD par rapport à l’AR fournisseur.
- Prix : catalogue actif à la date de Paris, même devise, conversion stock/achat connue, minimum de commande et conditionnement. Le calcul canonique inclut paliers, forfait et minimum HT. Prix ancien, conversion incertaine, prix par multiple non pris en charge et transport ne sont pas inventés. Une estimation couvre une seule ligne ; aucune quantité par lot matière n’est supposée pour les prestations.
- Qualité : dernière évaluation non remplacée dans chaque périmètre global/domaine applicable, en cours de validité. Une évaluation non satisfaisante exclut le fournisseur de la recommandation, sans créer une nouvelle décision d’homologation.
- Homologation/agréments client : évaluateur canonique partagé avec la commande fournisseur, clients sources d’un regroupement compris. Les blocages sont prioritaires ; les décisions inconnues sont signalées. Le préchargement batch est réservé au diagnostic ; un engagement réel relit et verrouille ses décisions et politiques.

Le score exploite les critères disponibles : prix 40, fréquence réelle 30, délai réel 15, qualité 15. Sans droit prix, le score est ramené sur les 60 points accessibles. Les homologations connues passent avant celles à compléter. Une donnée absente apporte zéro point, sans recevoir une note fictive. Maximum 40 fournisseurs et 400 conditions catalogue, avec avertissement si la sélection est tronquée.

## Interface et limites

Une suggestion principale, alternatives à la demande, raisons et dernière commande consultables. Le clic « Choisir » remplit le fournisseur dans le formulaire ; aucun choix enregistré n’est écrasé automatiquement. Les aides utilisent les infobulles CERP. Les écrans matière client ne proposent pas d’achat. Quantité/coût peuvent rester inconnus avant confirmation du débit ou de la quantité réelle de la prestation ; le choix manuel reste accessible.

Pas de migration. La recette métier commune est préparée dans le frontend et sera exécutée à la fin des modifications, conformément à l’instruction utilisateur. Compilation SQL en lecture seule et compilation des artefacts ne valent pas validation métier.
