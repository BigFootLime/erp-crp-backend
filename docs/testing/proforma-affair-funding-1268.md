# Proformas, sociétés facturées et couverture des affaires — #1268

## État réel

Développement en cours, WP285 / S07. Douze opérations proforma sont écrites, dont la ventilation et la libération de règlements déjà affectés dans Finance. Le workflow de facture prépare aussi les sources `DEPOSIT` à partir d'un montant HT choisi dans le solde de proforma ; l'unité d'acompte est renseignée automatiquement, sans consommer de pièces. Les mutations gardent Finance/RBAC, idempotence, audit et outbox. Ces routes ne sont pas publiées dans le runtime déployé. Le modèle SQL et les repositories de proforma passent sur PostgreSQL 17 isolé. Les essais de ventilation utilisent des documents fiscaux explicitement synthétiques, sans émission Finance, séquence légale ou paiement externe ; ils ne valident pas le circuit fiscal complet. Rien n'est appliqué sur Test/Prod et les 12 scénarios globaux restent ouverts.

## Règles conservées

- Le client physique de la commande reste distinct des sociétés facturées. Les quantités facturées aux sociétés couvrent exactement la quantité de l'affaire, sans doublon.
- Prix, quantité, remise de ligne, remise globale et TVA viennent de la commande. La requête de création ne peut transmettre aucun prix, statut payé ou instantané faisant autorité.
- La proforma est un document commercial figé, identifié, distinct d'une facture fiscale. Elle n'alloue aucun numéro fiscal.
- La couverture d'une affaire provient de règlements nets déjà affectés à de véritables factures d'acompte. Leur ventilation entre les affaires ne crée pas une seconde entrée d'argent. L'annulation/rejet du paiement, sa libération ou un avoir d'acompte retire la couverture correspondante.
- Les affectations doivent rester dans le montant du règlement et celui de la ligne d'acompte. Les preuves et leurs libérations sont append-only.
- Un BL contient les affaires payées d'une seule proforma ou uniquement les affaires explicitement hors proforma. Les contrôles client/adresse/contrat restent indépendants et obligatoires.
- Les conditions historiques inconnues restent `UNCONFIRMED`. Une décision explicite et motivée doit les régulariser ; aucune reprise silencieuse vers `NOT_REQUIRED`.
- Chaque société facturée doit être couverte. Un excédent chez une société ne compense pas un manque chez l'autre.
- Le contrôle doit être recalculé à la préparation, confirmation et expédition. Le hash commercial change avec quantité, prix, TVA, contrat, adresse ou société facturée ; une modification du planning/stock seule ne le change pas.

## Sources réglementaires pour le circuit des acomptes

La ventilation des paiements s'appuie sur les documents fiscaux de Finance et doit conserver leur traçabilité. Elle ne transforme pas la proforma en facture. Consulter les versions courantes des [opérations donnant lieu à facturation, BOFiP](https://bofip.impots.gouv.fr/bofip/13242-PGP.html) et de [l'exigibilité de TVA sur les acomptes de biens](https://bofip.impots.gouv.fr/bofip/13758-PGP.html/ACTU-2022-00148) lors de la qualification du circuit fiscal. Les choix de régime/territorialité restent ceux du contrat réglementaire Finance.

## Travail de raccordement obligatoire avant livraison du lot

1. Finir et éprouver le patch SQL : cohérence des instantanés, budgets fiscaux, échelonnement des acomptes, avoirs, transferts au solde, préflight/verify/rollback et concurrence.
2. Finir l'émission PDF/GED des proformas et éprouver le cycle avec de vrais acomptes/encaissements. Création, reprise du brouillon, annulation sans encaissement, références, versions, audit, outbox et concurrence d'une double création sont qualifiés sur PostgreSQL isolé.
3. Éprouver le circuit Finance complet des sources `DEPOSIT`, maintenant raccordées aux aperçus/brouillons : validation et émission réelles, séquence légale, PDF/GED, annulation de brouillon, avoirs/remboursements, cas de TVA/arrondis et réglementation électronique. Le guard spécialisé préserve la branche BL et les guards existants de paiements/avoirs ; un acompte est plafonné par société en HT/TTC et sa filiation est obligatoire au commit. Aucune émission fiscale synthétique ne doit être utilisée dans le parcours live.
4. Les ventilations/libérations sont écrites et qualifiées avec les repositories réels sur des données fiscales synthétiques isolées. Rester à qualifier avec les factures émises par Finance, les paiements enregistrés par son workflow et les corrections fiscales. Les writers modernes de factures/paiements sérialisent leurs décisions avec la couverture de proforma avant les verrous de parents.
5. Présenter couverture, solde et action manquante dès la liste des affaires. Ajouter le contrôle aux aperçus puis aux transactions BL ; conserver les preuves de termes dans le document expédié.
6. Autoriser la facturation finale aux sociétés du plan de répartition, avec caps de quantité et déduction des acomptes par société. Ne jamais réallouer le paiement initial une seconde fois sur la facture finale.
7. Créer les écrans guidés et documents PDF CERP, puis les parcours Test payé/non payé/partiel/annulé/avoir, mélanges de périmètres, plusieurs sociétés, BL partiels, retry et concurrence.
8. Sauvegarder avant changement live ; publier branche dédiée → dev → main et déployer BDD/backend/frontend sur Test/Prod, VPS/HYPERBOX2. Rejouer les parcours UI et inscrire leurs preuves avant fermeture de #1268.

## Vérifications locales acquises le 13 octobre

330 tests ciblés passent dans vingt fichiers : proforma, ventilation, acomptes partiels, types de documents fiscaux, autorisations, politique Finance, TVA, workflows de paiements, forfait urgence, rendu PDF réel et format EN16931. TypeScript strict et build complet passent ;1491 opérations OpenAPI sont inventoriées et le contrat est valide. Ces tests ne constituent pas une recette UI. Le code `386` identifie l'acompte dans son instantané et le format électronique ; PDF et brouillon l'intitulent « Facture d'acompte ». Les anciens instantanés sans métadonnée restent des factures standard (`380`) ; un type inconnu est refusé.

Le modèle financier synthétique qualifie affectations 60+60 sur un règlement de120, refus du dépassement, libération10 puis réutilisation10, refus d'une libération excessive et du réemploi d'un paiement annulé. Deux défauts ont été corrigés avant publication : variable SQL ambiguë avec `source_id`, et lecture `FOR UPDATE` d'une preuve append-only sans droit UPDATE. Le mutex de couverture suffit pour lire cette preuve immuable ; aucun droit de réécriture n'a été accordé.

Les repositories réels sont aussi exercés : création de proforma, lecture d'un solde d'acompte, ventilation100, replay, libération20 et couverture nette80, puis dépassement40,01 refusé. La facture et le règlement utilisés ici sont des **fixtures fiscales synthétiques** dans la base jetable, pas des documents émis par Finance. Ce périmètre reste distinct de la vraie émission, de l'archivage et de la recette Test.

Sources de la distinction fiscale : [code386 d'acompte, OpenPeppol](https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL1001-inv/) et [montants prépayés BT-113](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/cac-LegalMonetaryTotal/cbc-PrepaidAmount/). Déduction du solde, références d'acompte et traitement comptable restent à terminer et qualifier ; aucun nouveau paiement ne doit être créé pour imputer l'acompte sur la facture finale.

La qualification PostgreSQL restaure uniquement le schéma de Test, avec ses propriétaires et permissions, dans une base dédiée `cerp_qualify_1268_*`. Aucune ligne métier n'est copiée. Une sauvegarde récente Test/Prod a été relue intégralement et vérifiée sur le VPS avant les essais. Application, réapplication, vérification avec `cerp_app`, rollback à vide avec acquittement et refus du rollback sans acquittement passent. La base temporaire est supprimée après chaque essai.

Le [jeu synthétique](fixtures/proforma-affair-model-1268.sql), limité par une garde au nom de la base isolée, prouve la répartition de 100 pièces entre deux sociétés (30/70, 1 200 € TTC), le refus des quantités excessives et des répartitions incomplètes, le gel des lignes après émission, le refus des suppressions d'historique, puis l'annulation sans encaissement et une nouvelle répartition 25/75 conservant l'ancienne. Tous les triggers restent activés. Le test a révélé et corrigé une référence à un champ d'une autre table dans le trigger commun de protection. Les autorisations de `cerp_app` sont maintenant explicites dans le patch. Les budgets d'acompte, encaissements réels, concurrence et factures finales restent à qualifier.

Le [second jeu](fixtures/proforma-command-rehearsal-1268.cjs) exécute les repositories compilés réels avec `cerp_app` : création de deux affaires et répartition entre sociétés, replay, refus d'émission après changement du prix source, reprise confirmée avec nouveau prix et retrait de la seconde affaire, refus d'une version périmée, annulation et replay. L'affaire retirée devient `UNCONFIRMED`, sans autorisation silencieuse de livrer impayé ; le lien de la ligne conservée reste stable. Une double création simultanée avec deux clés distinctes produit une seule proforma, l'autre transaction reçoit le conflit de rattachement attendu. Lecture du détail, couverture impayée par société et liste passent. Les cinq commandes confirmées ont chacune leur reçu et événement Finance et des événements outbox ; zéro facture fiscale est créée. Un rollback, même acquitté, refuse alors de supprimer les preuves enregistrées. Ce test exige une base dédiée et un socket PostgreSQL local avant d'importer le code ; aucun serveur, worker, mail ou interface n'est démarré.

La reprise conserve client et devise, recalcule les prix depuis la commande et confirme un nouvel aperçu. Une proforma émise ne peut pas être reprise. L'annulation conserve les instantanés, les lignes et les conditions de paiement ; des BL, factures d'acompte actives ou ventilations non libérées demandent une régularisation explicite. Les contrôles SQL et API se complètent. Les cas avec de vrais documents fiscaux et paiements restent à éprouver avant déploiement du lot.

Le modèle conserve les versions précédentes de répartition lorsqu'une proforma annulée est remplacée. La devise de commande est explicite, avec la base EUR déjà utilisée par Finance pour les données existantes ; le rollback ne supprime pas cette preuve commerciale additive. Les mutations prennent le verrou de commande avant le verrou de contrat, conformément au rattachement historique explicite.

## Contrôle des BL et concurrence Finance — 14 octobre

Les aperçus de préparation et d'expédition lisent la couverture proforma dans leur propre transaction cohérente. Les lignes physiques de plusieurs lots d'une même affaire ne multiplient pas le montant dû. Les sources de réservation et d'allocation doivent désigner la même ligne de commande. Une affaire sans origine identifiable, une répartition partiellement encaissée, un reçu libéré ou annulé, une société non couverte et une révision de prix non confirmée bloquent la préparation ou la sortie. Une commande interne n'exige pas de proforma client.

Les mutations prennent le verrou Finance avant les commandes, contrats, affaires et BL. Un compteur transactionnel protège aussi les instantanés SERIALIZABLE déjà ouverts : un encaissement modifié avant la prise du verrou exige un nouvel aperçu HTTP409 au lieu d'autoriser la livraison depuis l'ancienne preuve. Les voies de paiement, factures, avoirs et ventilations partagent cette protection ; les reprises idempotentes ne changent pas le compteur. Les brouillons de BL restent réparables ; les expéditions engagées conservent leurs protections.

La qualification PostgreSQL17 du 13 octobre à 22:03 UTC a exécuté les repositories réels et leurs jointures BL dans une base sans données métier copiées, sous les permissions cerp_app. Elle confirme le conflit40001 d'un ancien instantané et l'attente réelle d'une écriture Finance pendant le verrou du BL. Les fixtures DRAFT sont annulées par rollback : aucun BL expédié, mouvement de stock, émission fiscale ou paiement réel n'est revendiqué. Les erreurs initiales de seed d'article (racine/version obligatoires) ont été corrigées dans le jeu de qualification, sans assouplir le schéma.

Suite backend complète : 700 fichiers, 7782 tests passent ;31 fichiers/254 assertions sont explicitement ignorés par la suite existante. Build strict et couverture1491 opérations API passent. Le mock d'audit qualité a été corrigé pour produire un reçu explicite ; un test supplémentaire confirme le refus d'un audit absent. La protection de production reste inchangée.

Le choix structuré NOT_REQUIRED/PROFORMA est prévu dans la création de commande ; l'absence de champ lors d'une modification conserve la décision. Les commandes historiques restent sans décision automatique. Les écrans guidés, l'émission fiscale complète, la comptabilité et les déductions sur facture finale restent en cours avant intégration dev/main et déploiement.

Le défaut de reprise de la commande109 a depuis été corrigé dans main : les12 réservées propres et8 libres ne relancent plus4 pièces inutiles. Le parcours hors proforma a atteint AR26, BL57 expédié après contrôle documentaire simulé, puis facture2 émise et reliquat8 libre. Ces preuves ne qualifient pas le parcours proforma.


## Reprise sur le code déployé — 14 octobre,02:20

La branche proformas intègre dev90ed8027 (même arbre que main05c0d05a) : reprise des réservations propres, origine matière/traitement des lots, calendrier et nombres Finance, nouvelle fiche papier. Deux conflits de changelog/tests sont résolus en conservant les deux suites.7820 tests sur703 fichiers et build strict passent. La copie des3788 fichiers de source est vérifiée par les objets Git ; le checkout principal et son index restent inchangés, sans nouveau worktree.

Restent obligatoires avant livraison : facture finale multi-sociétés, déduction exacte des acomptes, filiation urgente, vraie émission/archivage/comptabilité des acomptes, écrans guidés et recettes de paiements/corrections. Le lot est sauvegardé sur sa branche de travail ; aucun schéma Test/Prod ni runtime live n’est modifié par ce rapprochement.


## Facture finale : sociétés et quantités — 14 octobre

Les sources de BL proposées à une société suivent la répartition de la proforma émise, même si le destinataire physique est différent. Une part figée de 30 pièces ne peut pas être dépassée entre plusieurs BL ou brouillons. Les lots physiques sont regroupés par affaire avant le calcul : deux lots livrant 8 et 4 pièces donnent 12, sans multiplication du quota. Les contributions exactes sont conservées dans un lien append-only ; le retrait d’un brouillon libère le budget sans supprimer son historique. Les avoirs ne rendent pas silencieusement une quantité livrée refacturable. Les prix/remises/TVA figés de la proforma gouvernent la facture, et non une modification ultérieure de la commande. L’aperçu utilise une transaction REPEATABLE READ READ ONLY ; l’enregistrement recontrôle sous les verrous Finance.

7836 tests sur 704 fichiers et build strict passent. PostgreSQL 17 isolé : application, réapplication, permissions applicatives, rollback vide et refus de rollback avec preuves, lecteurs et aperçus réels, quotas partiels, mauvais destinataire, omission du lien, double demande concurrente, retrait et conservation de l’historique passent. La base temporaire est supprimée ; aucun changement Test/Prod, aucune expédition réelle ni émission fiscale n’est revendiquée. Sauvegarde Test/Prod vérifiée sur VPS, datée 00:43:06 UTC.

Toujours requis avant déploiement du lot : déduction des acomptes et restes à payer, comptabilité/fiscalité complètes, PDF/GED proforma, interface guidée, filiation urgente, émission légale et recette live. Ces protections de quantité ne terminent pas le flux financier.
