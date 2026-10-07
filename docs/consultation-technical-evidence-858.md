# Preuve technique des consultations — N17A

Backend #858, frontend #1140, Project Office WP-275. Les contrats ouverts et leurs appels restent la tâche suivante de N17.

À l'ouverture, chaque consultation conserve les références plan/PT/indice/version et exigences documentaires de tous les OF sources, ainsi qu'une empreinte déterministe. Le résolveur partagé couvre la ligne, ses besoins, la sous-traitance et les sources d'un regroupement. La projection inclut le producteur et ses destinataires : changer une affectation rend aussi la demande obsolète. Les données de coût du dossier de fabrication ne sont pas retournées.

Un OF engagé utilise son dossier figé, indépendamment de la PT actuellement applicable. Pour un OF en préparation, le plan et la version sélectionnée sont identifiés comme prospectifs ; l'empreinte inclut la version, la préparation et les références GED disponibles. Une progression vers un dossier figé ou une modification exige une nouvelle consultation. Les exigences propres à la ligne restent figées dans le snapshot existant.

Avant invitation ou sélection d'offre, le serveur recompare les besoins et les références sous la transaction achats existante, avec verrou partagé des OF et versions après le verrou planning. Le diagnostic est également affiché lors de la lecture. Les changements ne réécrivent ni demandes ni offres précédentes. Un ancien tour de consultation lié à la production, sans preuve technique, doit être clôturé puis rouvert ; un ancien tour de consommables sans OF reste compatible.

Les pièces jointes restent sélectionnées explicitement et téléchargées par GED, avec contrôle de rôle, parent, applicabilité et antivirus. Aucune pièce technique ne reçoit un deuxième parent. Les versions utilisées par une invitation sont placées sous rétention qualité avec référence consultation/version et acteur. Les droits achats/prix/GED restent ceux du parcours existant ; aucun message fournisseur n'est envoyé.

Aucune migration de schéma : le snapshot JSON existant porte cette extension optionnelle, sans réécriture de l'historique. Retour applicatif possible vers la release précédente ; les références ajoutées restent conservées en base.

Vérifications immédiates : compilation backend/frontend, analyse ESLint ciblée, compilation des sept requêtes sous `cerp_app` dans une transaction annulée. Tests de logique préparés dans `consultation-technical.test.ts` ; exécution, recette navigateur et captures métier différées à la fin du chantier global sur instruction de Keenan. Cas de recette : plan remplacé, changement d'indice/version, modification du second OF regroupé, OF en préparation puis figé, consultation historique, refus GED, conservation de l'ancienne demande et de ses documents.
