# OF dossier completion and material coverage

Delivery in progress: backend #767, frontend #1025–1032, Project Office WP-254. The governing decision is frontend ADR-0072; activation defaults to off.

## Current interfaces

- GET /production/workbench/config includes material_workflow_enabled.
- GET /production/ofs/:id/dossier reads preparation, committed operations, customer/internal/committed/forecast/actual dates and validation blockers.
- POST /production/ofs/:id/complete validates the frozen technical definition and actual committed planning, retaining actor/version evidence. It never starts production.
- GET /production/ofs/:id/material reads frozen purchase needs, their operation configuration, canonical reservations and purchase allocations, FIFO candidates and net shortage.
- POST /production/ofs/:id/material/:sourceRef/configure records the reviewed material specification and debit rule. Changes require dossier revalidation; existing commitments remain.
- POST /production/ofs/:id/material/confirm applies the reviewed selection and creates supplier/currency/destination-compatible purchase drafts for the uncovered quantity.

Writes require expectedVersion and idempotencyKey. Replayed commands validate actor and payload. Coverage uses a locked OF and canonical stock quality/availability gates; drafts use existing purchase numbering, line insertion, creation documents and audit. Failed transactions roll back reservations and purchases together. Prices are removed from the public read model when purchase-price rights are absent.

## Canonical ledgers

of_material_needs attaches specifications to an OF technical version and consuming operation. stock_reservations retains physical quantities, consumed quantities and source identity. commande_fournisseur_ligne_besoin retains future promises; OF_MATERIAL permits separately traced partial promises while the unique-link policy remains for legacy source types. of_material_receipt_transfers links an incoming stock receipt to its resulting reservation and deduplicates reconciliation; it must never be counted as extra physical stock.

The dossier source fingerprint excludes slot dates/resources so ordinary moves do not invalidate the prepared product. Deferred planning triggers see the transaction's final schedule and invalidate only after withdrawal. Definitions and quantities trigger revalidation immediately.

## Rollout and verification

Both additive migrations have preflight/verify files and a recovery guide under db/patches/support. Test first, retain application ownership and migration UTF-8 hashes. Do not remove ledgers for rollback. A disabled UI is not permission to bypass persisted allocations through legacy routes.

Policy tests cover net 40/15, FIFO rejection, shared pool depletion, repeated confirmation, transfer to physical/consumed, quarantine, supplier surplus and explicit bar/sheet conversion. Read probes use cerp_test under cerp_app; trigger checks roll back all their test writes. Business recipe is exclusively through the UI. Full receipt reconciliation, customer calls, supplier consultations and operation start/partial consumption are still being implemented; the presence of a schema or pure function does not imply their delivery.

Point intermédiaire : vérification des caractéristiques des lots réservée à la qualité, preuves liées au besoin et au contexte du lot, certificats provenant des documents actifs de sa réception. Les propositions respectent aussi le disponible commun de l’emplacement. 17 tests de politique réussis. Recette UI sur cerp_test : validation Complet puis revalidation après modification matière vérifiées ; réservation et achat encore en cours de recette.

8 septembre, contrôle matière : les propositions lisent désormais le même contrôle Qualité 360 que la réservation, sans verrou d’écriture en lecture. La quantité libérée est partagée entre les emplacements et les besoins du même lot. Un recontrôle LOT/RECHECK vérifie côté serveur article, unité et population physique ; le circuit de libération des BL reste contrôlé par son périmètre propre. 42 tests ciblés passent. Recette réelle : le lot 892 portait le statut LIBERE sans contrôle quantitatif ; réservation refusée sans création d’achat. Le parcours correctif est en cours de recette sur cerp_test.

Le 8 septembre, l’ouverture du premier contrôle LOT a révélé la contrainte historique quality_control_context_chk, limitée aux OF/pièces/affaires. La migration 20260908_quality_lot_context ajoute un contexte LOT exact avec article, plan figé et population positive, valide la contrainte élargie puis retire uniquement la contrainte obsolète. Aucune ligne métier modifiée. Sauvegarde test avant intervention : 869e5e2ffb8988d5f573e2522e50cc246c42b32519a17058fdab99e7cecd3dde. Vérification cerp_app réussie ; production non modifiée. Récupération : désactiver le nouveau parcours en conservant cette contrainte compatible ; ne pas réinstaller une contrainte rejetant les contrôles LOT créés depuis.

## Réception et qualité — implémentation du 8 septembre

La mise en stock, le mouvement comptabilisé, le reçu de commande, les affectations aux besoins destinataires et l’audit partagent maintenant une transaction. Les fonctions stock acceptent la transaction propriétaire ; elles ne la valident ni ne la ferment. Une erreur d’affectation annule l’ensemble. La répétition d’une commande réussie relit son résultat avant de consulter les quantités ou unités qui auraient changé depuis.

`20260908_receipt_unit_snapshot.sql` capture unité de stock et coefficient à la réception, protège leur immutabilité et ajoute l’identité de commande au reçu canonique. Les réceptions anciennes ne sont pas converties rétroactivement : une unité identique reste utilisable ; une conversion ambiguë est refusée. Cette migration doit précéder l’activation du code de réception.

Le contrôle LOT/RECEPTION résout sa ligne, son fournisseur, son article et sa population dans l’unité figée, avant toute entrée physique. Les décisions Qualité alimentent le registre existant et le statut du lot. Une libération partielle conserve la quantité retenue ; un refus ne crée ni retour fournisseur ni achat. La mise en stock compare le cumul des entrées à la quantité libérée sur cette ligne, sans compter ses réservations une seconde fois. L’ancienne décision entrante « LIBERE » renvoie vers le contrôle quantitatif canonique ; ses mesures restent lisibles. La politique indépendante des BL n’est pas modifiée.

50 contrôles techniques ciblés réussis : contexte, unités, décision partielle/refus, éligibilité, transaction et répétition. Les tests de transaction utilisent des doubles pour les registres périphériques ; ils ne constituent pas une preuve de concurrence PostgreSQL ni une recette utilisateur. La recette réelle reste à réaliser après activation test. La décision sur l’auto-approbation qualité des superutilisateurs reste en attente ; aucun assouplissement n’est appliqué.

## Consultations fournisseur — L4 en cours

`GET /commandes-fournisseurs/:id/consultations` lit la consultation courante et son historique ; `round` permet d’ouvrir un tour précédent. `POST /commandes-fournisseurs/:id/consultations/commands` accepte OPEN, INVITE, RECORD_OFFER, SELECT et CLOSE. Lecture et écritures exigent les capacités achats et prix ; toute commande porte une clé d’idempotence et la version exacte du brouillon, puis la version de consultation pour ses modifications.

La consultation fige quantités, unités, exigences et dates d’un brouillon existant. Les demandes sont des textes préparés pour relecture, jamais des mails envoyés. Les réponses sont ajoutées avec révision et motif de correction ; les précédentes restent lisibles. La comparaison expose les totaux calculés par le moteur d’achat existant, les devises séparées, les surplus et retards. Prix et dates fournisseur ne sont pas inventés par le formulaire.

Un choix explicite et motivé applique fournisseur/conditions/prix/quantités à ce même brouillon, en transaction. Il conserve les liens vers les besoins et les réservations, ne crée pas un autre achat, ne valide pas la commande et ne transforme pas la date d’offre en AR. Il refuse une offre expirée, corrigée depuis, étrangère, insuffisante ou dont la conformité reste à vérifier. Le réordonnancement des clés jsonb est neutralisé lors de la comparaison du contenu figé. Une commande ou une exigence modifiée impose une nouvelle consultation ; aucune offre existante n’est réécrite silencieusement. Les changements sont publiés via l’outbox et les invalidations achats/OF existantes.

Migration additive `20260908_supplier_consultations.sql`, avec précontrôle, vérification cerp_app et récupération conservant les historiques. Les contrôles techniques ont couvert calcul, contenu figé, refus, répétition, rollback et conservation des affectations avec doubles SQL. Une recette UI réelle et une mesure de concurrence PostgreSQL restent requises avant clôture. Les pièces jointes GED des consultations, les appels de bruts client et le démarrage/débit par opération sont encore à terminer.

Recette UI du 8 septembre, 02 h 22 : BCF-2026-0924, deux demandes fictives, réponse Rhône 108 € HT corrigée de v1 à v2 avec raison, réponse Alpes 93 € HT / 50 u / surplus 10 u retenue avec motif. Même BCF toujours brouillon, fournisseur Alpes, total 111,60 € TTC, aucune promesse AR créée. Ce dossier distinct ne possède pas d’affectation OF : la conservation d’une affectation réelle reste à exercer. API test ebfe61f2 ; production 37684605 inchangée. Voir le journal frontend pour sauvegarde et empreintes.

Correction suivante : la date de besoin du brouillon est reprise si celle de ligne est absente, pour ne pas masquer un délai tardif. Les consultations déjà figées restent inchangées ; une différence de contenu réclame un nouveau tour. L’édition générique d’une ligne acquiert le verrou planning puis protège les affectations : identité article/type/unités/conversion conservée et quantité nette suffisante pour les destinataires, avec conversion vers l’unité canonique des allocations OF_MATERIAL. Quatre tests de cette garde réussis, plus les 48 tests consultation/HTTP ; activation test de cette correction encore à faire.

## Disponibilité par opération — 8 septembre, 03 h 05, L5 en cours

La lecture `GET /production/ofs/:id/operation-readiness` distingue dossier, créneau engagé, programme applicable, quantités physiques compatibles et transferts réellement libérés. Une matière réservée de 60 bruts sur 100 ouvre un plafond de 60 uniquement si sa règle autorise le partiel. Le programme TASK provient de la tâche de version terminée avec référence ; une ligne de calendrier programmation ne prouve pas sa réalisation. Les lots et documents applicables restent soumis à leur autorité qualité/GED.

Les démarrages canoniques et anciens acquièrent les verrous planning → OF → lots qualité, relisent les conditions et enregistrent le premier démarrage effectif de l’OF. L’ancienne libération globale ne peut pas démarrer ce parcours. Les écritures libres du cumul OF et des états RUNNING/DONE d’opération renvoient aux commandes de production. Après déclaration, le cumul bon de l’OF provient de sa dernière opération active, les étapes précédentes restant des encours ; les rebuts sont suivis à leur opération.

Une déclaration tient compte des quantités bonnes, rebutées, à contrôler et à reprendre dans le plafond. Sur l’opération matière, la consommation effective doit précéder la déclaration de bruts. Cette protection est prête ; le formulaire et la transaction de débit partiel/chutes sont encore à livrer, il ne s’agit pas d’un parcours matière terminé. Les corrections de quantités et transferts devront conserver cette même cohérence.

La reprise d’un pointage clôturé par Pause ouvre un segment à la date de reprise et conserve le segment précédent. Un successeur déjà créé interdit un deuxième effet. L’aperçu de quantité utilise une transaction de lecture cohérente et le contrôle de confirmation relit son état. 108 tests ciblés passent : politiques quantité/disponibilité, autorisations et routes OF/exécution, dont reprise sans durée de pause. Les lectures SQL opérations/dépendances ont été exercées sans écriture sur OF 852 ; aucune autorisation de démarrage réel n’est encore prouvée par la recette UI. Les compteurs de matière consommée restent conservés après expiration d’une réserve ; seul son reliquat expiré cesse de couvrir le besoin.

Activation test 1d7ccba6 : sauvegarde 485a66febffacbbab2eb02115f36dc1e192ebeba1289840e6633cfc13cfc444d, archive bfa1f007dac47646de6dce5e91bee537c5d6aa9358f3a15a541db08c9bc49f3a. Santé test et production vérifiée ; production 37684605 conservée. La recette UI a confirmé dossier Complet non démarré, découpe sans quantité utilisable et tournage en attente de programme/transfert. Un défaut de durée au poste a été trouvé : lecture du temps de gamme à la place de la charge pour l’OF. Le poste reprend maintenant la formule canonique existante et expose les pauses sans successeur pour proposer Reprendre. 53 tests routes/charge passent ; ces deux corrections attendent leur prochaine activation test.
