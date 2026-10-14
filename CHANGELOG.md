# Changelog

## En développement — Avoirs d’acompte monétaires (#1268)

- Sélection HT exacte sur une facture386 qualifiée, TVA cumulative d’origine et aucune consommation physique de pièces. Contrat conservé pour les avoirs par quantité ; brouillons et avoirs émis partagent leurs budgets, preuves et rollback protégés. 8006tests et build strict passent ; trois brouillons/replays PostgreSQL17 isolés totalisent100HT/20TVA, double réservation et quantité physique frauduleuse refusées. États fiscaux initiaux simulés ; recette réelle et reste du lot Finance non terminés.

## 2026-10-14 — Impression après planning (#1320)

- Demande persistante créée au premier engagement d'une opération, y compris externalisée, sans reprise automatique des anciens créneaux ni doublon lors d'un déplacement. Prise en charge par poste, exemplaire lié atomiquement à son intention et accusé audité ; une acceptation OS reste distincte d'une sortie papier.
- Métadonnées PDF issues de la connexion PostgreSQL et de l'acteur authentifié. Qualification PostgreSQL 17 isolée : triggers transactionnels, concurrence, replays, droits et rollback protégé passent. Émission/préparation initiales synthétiques ; publications et recette native réelle suivies séparément.

## En développement — Dossier de fabrication complet (#1320)

- Premier exemplaire OF officiel sans filigrane, puis DUPLICATA ; brouillons marqués BROUILLON. Demandes idempotentes et compteur persistant distinct des téléchargements, variantes archivées séparément en GED, original conservé. Route et bouton d’impression OF raccordés ; compilation stricte, 121 tests backend, 5 tests du bouton et concurrence PostgreSQL 17 qualifiés avant publication.
- Dossier complet raccordé aux plans GED figés et à l’autocontrôle exact de l’OF, avec suivi MD61 et préparation MD38 conditionnelle. Éditions et variantes archivées séparément ; compteur et impression du dossier atomiques. Bouton guidé sur la fiche OF/export, accès direct aux rubriques manquantes. 106 vérifications backend, 9 vérifications web et commandes concurrentes PostgreSQL 17 qualifiées. L’automaticité après planning, la queue A4 Electron et la recette réelle complète restent en cours.

## En développement — Proformas et sociétés facturées (#1268)

- Avoirs sur factures payées : correction distincte de l'encaissement, calcul du crédit client et remboursements avec origines bancaires choisies côté serveur, preuves immuables, replay et export sans double TVA. Paiements reçus après un avoir d'acompte : TVA restante par catégorie, anciennes écritures conservées. 7 945 tests / 721 fichiers, build et commandes PostgreSQL17 isolées passent. Erreur de droit SELECT FOR UPDATE corrigée sans élargir les permissions ; fixtures et remboursement excessif corrigés après reproduction. Avoirs monétaires arbitraires, contrepassations, interface et recette réelle restent ouverts ; lot non déployé.

- Classification fiscale des acomptes, comptes configurés d’avances/TVA en attente et ventilation TVA immuable par paiement. Export complémentaire sans seconde banque ; reprise figée d’acomptes sur facture finale. 7 920 tests / 716 fichiers, build et commandes PostgreSQL17 isolées passent. Migration additive avec rollback protégé, sans backfill historique. Interface, remboursements/contrepassations et recette réelle restent en cours ; lot non déployé.

- Avoirs partiels : prix/remise/TVA d'origine, budgets et dernier centime repris sans double remise ; quantités et montants déjà crédités contrôlés. Deux ambiguïtés de paramètres SQL à la création corrigées après reproduction PostgreSQL. Empreinte d'aperçu stable après stockage des quantités. Motifs PDF en français et exemple relu. 7 907 tests / 713 fichiers, build et repositories natifs isolés passent ; émission réelle, avoirs déjà payés/remboursements, comptabilité des acomptes et écrans restent ouverts avant déploiement.

- Remise globale et TVA : ventilation documentaire commune figée pour PDF, facture électronique et export comptable. Lectures de brouillon exactes et échéanciers conservés ; prix financiers à quatre décimales, anciens exemplaires/lignes figées inchangés. 7 894 tests / 711 fichiers, build strict et exports comptables réels sur PostgreSQL isolé passent. Comptabilité des acomptes, avoirs partiels, écrans et recette fiscale/métier restent ouverts ; aucun déploiement de ce lot. Référence visuelle commune à tous les exports précisée selon l'OF approuvé.

- Factures finales : affectation des acomptes réellement encaissés, net à payer/échéances cohérents et contrôle des budgets dans PostgreSQL ; aucune seconde entrée de trésorerie. Faits figés repris en PDF et facture électronique. Factures/avoirs au dessin structuré commun, précision des prix conservée, exemples fictifs relus. 7 867 tests et build strict passent ; comptabilité, interface et recette fiscale/métier restent ouverts avant déploiement.

- Document proforma : design commun structuré, destinataire/sociétés séparés, précision des prix et quantités, snapshot et bytes exacts conservés au replay, parent GED Finance et quatre transports documentaires sécurisés. Correction du cycle d’aperçu créé par ses métadonnées de liaison.7 842 tests/705 fichiers, build et émission commerciale PostgreSQL isolée passent ; déduction des acomptes, interface et rangement GED/recette live restent en cours. Aucun déploiement de ce lot.

- Factures finales : destinataire physique distinct de la société facturée autorisée, quotas de quantité par affaire/société sur plusieurs BL et brouillons, contributions append-only. Prix de la proforma figés, aperçus cohérents en lecture seule, aucun double comptage des lots ni réouverture automatique après avoir.7836 tests/704 fichiers, build et qualification PostgreSQL17 isolée passent. Déduction des acomptes, interface et recette fiscale/live restent en cours ; ce lot n’est pas déployé.

- BL : couverture proforma par affaire et société facturée, cohérence des sources physiques, refus des sources modifiées et regroupements incompatibles. Aperçus cohérents, ordre de verrous partagé avec Finance et reprise409 après changement concurrent d'encaissement ; aucune livraison autorisée par un instantané périmé.
- Décision structurée de prépaiement à la commande, sans imposer de décision aux anciennes commandes. PostgreSQL17 isolé : concurrence SERIALIZABLE, attentes réelles de verrous et jointures BL passent. Suite complète7782 assertions/700 fichiers et build passent ; écrans, facture finale et déploiement encore en cours.

- Règles exactes de couverture des affaires, répartition de quantité entre sociétés, paiements partiels/annulés, libérations et avoirs d'acompte. Prix/remises/TVA lus dans la commande ; aucun champ « payé » ne fait autorité.
- Modèle SQL additif et commandes réelles éprouvés sur PostgreSQL 17 isolé : permissions, répartition entre sociétés, reprise des brouillons, annulation sans encaissement, audit/replay et concurrence de double création. Un retrait d'affaire ne dispense pas silencieusement du paiement ; l'historique et le rollback restent protégés. Aucun changement de schéma Test/Prod. Dix opérations API écrites avec Finance/RBAC ;246 tests ciblés et build vert. Écrans, PDF/GED, BL, acomptes, factures finales et budgets financiers encore en cours ; aucun déploiement ni parcours métier complet revendiqué pour ce lot.
- Ventilation/libération de règlements déjà affectés, aperçus/brouillons d'acompte monétaires plafonnés par société et filiation fiscale obligatoire. Distinction386/380 dans les documents PDF/électroniques, sans seconde remise de commande ni consommation de pièces. Douze opérations proforma,330 tests et build verts ; SQL et repositories de ventilation éprouvés avec fixtures fiscales synthétiques sur base isolée. Émission Finance complète, comptabilité, factures finales, BL, écrans et recette live restent en cours.
## 2026-10-14 — Fiche papier d’autocontrôle

- Nouvelle fiche vierge avec grille cotes/tolérances, première et dernière pièce, instrument, surveillance, opération et visa. Logo CRP, titre centré, numéro rouge et zones encadrées selon la référence approuvée. Mesures et signatures jamais préremplies.
- Code client, définition figée et affaires exactes capturés ; fabrication interne identifiée. Date Europe/Paris, pagination répétée et consignes longues conservées ; anciennes fiches stockées inchangées.
- Six cas dédiés, build strict, suite complète et lecture des sources réelles sous cerp_app validés. Saisie tablette, dépôt du scan, fiche jaune et impression du dossier complet restent en cours.

## 2026-10-14 — Calendrier et nombres Finance

- Factures et avoirs utilisent la date Europe/Paris lors de leur émission. Après minuit en France, la date UTC de la veille ne fuit plus dans le numéro et le document. Les exemplaires déjà émis restent immuables.
- Les PDF financiers affichent les quantités et taux sans les zéros de stockage, en conservant chaque décimale significative. Aucun montant ni instantané recalculé.
-136 tests ciblés,7653 tests/688 fichiers et build strict passent ; aperçu compilé inspecté.

## 2026-10-14 — Provenance des lots produits

- Stock et BL affichent les lots matière débités et les lots revenus d'un traitement à partir des preuves de fabrication enregistrées. Projection commune à douze lectures, références historiques conservées, débits compensés exclus et traitement distingué d'une sous-traitance quelconque.
- 7 651 tests / 688 fichiers, build strict et lecture réelle READ ONLY de LOT1310 passent. Aucune ressaisie de traçabilité ni nouvelle écriture de stock ; les validations qualité et d'expédition restent actives.

## 2026-10-14 — Stock déjà réservé à la commande

- L'aperçu de relance reconnaît la couverture physique propre des lignes.12 déjà réservées et8 libres ne produisent plus une fausse proposition de fabrication de4 pièces. Aucune réservation supplémentaire ni planning fictif ; provenance OLD/NEW et contrôles physiques conservés.
- Lecteur réel vérifié en lecture seule sur Base Test, suite complète7641 tests/687 fichiers et build strict passent. Les commandes de reprise, qualité et expédition gardent leurs garde-fous et leur audit.

## 2026-10-13 — Reprise stock et annulation explicite de brouillon (#1305)

- La reprise stock seul vérifie tous les OF actifs, y compris hors génération. Aucun planning ou démarrage n'est simulé.
- Une annulation avant fabrication refuse les pointages, débits, réservations physiques, créneaux, regroupements et sous-OF actifs à traiter. Les affectations d'achat non engagées sont annulées avec audit et notification fournisseur ; achat, réception, prix, quantités, lots et documents restent inchangés. Un brouillon incomplet peut être annulé sous ces contrôles.

## 2026-10-13 — OF atelier au-dessus du pli A4 (#1300)

- Cartouches essentiels resserrés, délai et quantités accentués ; libellés Dimensions mini et Débit par brut. Repère de pli imprimé en pointillés gris fins, détails en dessous. Nomenclature et gamme complètes avec leur typographie inchangée.
- Gabarit 1.7, réimpressions 1.4/1.5/1.6 conservées à l'identique. Vérification géométrique du pli à 148,5 mm sur le boîtier complet et les OF de recette ; aucun changement de données métier.

## 2026-10-13 — OF atelier compact et échéance interne (#1297)

- Bandeaux de zones moins hauts, retrait des deux informations redondantes du cartouche matière/pièce, tableaux de synthèse courts conservés sur une page.
- Échéance AR ou cible interne originale visible dans l'en-tête ; les anciens PDF1.4/1.5 conservent leurs rendus.113 tests ciblés, compilation stricte et toutes les pages des trois exemples vérifiées. Aucune migration ; recette globale toujours en cours.

## 2026-10-13 — Stocks de versions mineures interchangeables (#1294)

- Autoriser les deux sens d’une chaîne approuvée de révisions mineures sans impact d’interchangeabilité, à PT/indice identiques. Les limites majeures et les versions non approuvées restent exclues ; le lot conserve sa version réelle et tous les contrôles qualité/réservation.
- Migration de vue avec supports de préflight/vérification/reprise ; 20 assertions PostgreSQL sur la requête réelle et reproduction en lecture seule du lot de recette. Validation métier et déploiement suivis séparément.

## 2026-10-13 — OF atelier : nomenclature et sources (#1285)

- Nomenclature avant gamme, titre et numéro centrés, durées en minutes/heures-minutes. Lecture cohérente des sources figées, sorties matière, compteurs nets, BL réellement expédiés et parts des regroupements. Réimpression et essais idempotents retournent l’édition enregistrée. La fiche de gamme affiche uniquement le code client.
- 103 tests ciblés, 13 cas SQL PostgreSQL en lecture seule et producteur réel des PDF Test OF95/101. Build strict/contrat 1 479 opérations. Aucune migration ; recette globale et visuels automatiques du chantier parent restent ouverts.

## 2026-10-13 — PDF OF lisible en atelier (#1282)

- Nouveau gabarit OF1.3 : zones opaques, opérations regroupant temps et visas, références répétées et durée par pièce précise.
- Socle éditorial versionné et panneaux PNG/JPEG complets ; conservation des rendus classiques et des archives existantes.
- La migration des autres exports et le gel des logos/plans/outils restent dans le chantier PDF.

## 2026-10-13 — Reprise qualité après annulation (#1279)

- Exclure un contrôle annulé avant la sélection de la dernière décision qualité, sans cumuler les autorisations ni retirer les garde-fous.

## 2026-10-13 — Annulation d’un contrôle vide (#1276)

- Annuler avec motif et audit un contrôle ouvert sans mesure ni décision ; conserver sa source, sa population et son plan figé.
- Reprendre avec le plan applicable corrigé, sans libérer ni modifier le stock lors de l’annulation.
- Protéger la concurrence et les preuves annulées dans PostgreSQL ; qualifier le parcours jusqu’à la libération normale du lot.


## 2026-10-13 — PDF du bon fournisseur approuvé (#1270)

- Archiver le PDF approuvé dans la même transaction que le gel commercial, avec reprises sans doublon et historique du brouillon conservé.
- Réémettre depuis les données et CGA figées ; dater explicitement les régularisations anciennes et expliquer les compléments de prix.
- Qualifier PostgreSQL, coffre GED, annulation transactionnelle et rendu PDF sur une copie isolée de Base Test.


## 2026-10-13 — Clôture canonique d’un traitement complet (#1273)

- Terminer la phase externe quand tous ses dossiers sont clos et que toute la population est retournée, libérée et transférée, avec preuve immuable par origine.
- Fournir les quantités de l’opération au planning et à la disponibilité sans inventer de pointage interne, de stock ou d’OF de récupération.
- Conserver les contrôles qualité actuels, refus de double comptage et revue explicite des anciens pointages ; réparation des dossiers déjà clos par le même service, avec simulation transactionnelle par défaut.

## 2026-10-13 — Dossiers de traitement par origine (#1269)

- Autoriser plusieurs dossiers pour une même opération, avec un dossier immuable par ligne fournisseur et origine matière ; conserver les registres existants.
- Rejouer la création sur une même ligne sans doublon ni erreur serveur ; refuser les paramètres incompatibles et les quantités annulées.
- Contrôler les pièces expédiées cumulées sur l'opération, tout en conservant les limites par dossier, la qualité, les origines et les habilitations.

## 2026-10-13 — Minimum fournisseur et origines matière (#1265)

- Contrôler le minimum sur la quantité de la référence dans la commande, sans regrouper les lignes de traçabilité par lot ni changer leur tarification.
- Recontrôler après modification/annulation et avant soumission, approbation ou envoi ; isoler commande, article, catalogue et unité.
- Recette PostgreSQL sur une copie isolée : origines 18+2 et 2+18, concurrence, replay, modification et refus du total insuffisant.

## 2026-10-13 — Échéances calendrier du poste opérateur (#1262)

- Projeter explicitement les dates PostgreSQL en ISO et conserver le jour/année du pilote DATE, sans conversion UTC ou chaîne locale incomplète.
- Éviter l’affichage erroné en 2001 dans Atelier/Découpe ; conserver intégralement les échéances métier et le tri.

## 2026-10-13 — Complément d’une réservation matière (#1259)

- Compléter atomiquement la réservation du même besoin/lot et son affectation sur la barre existante, avec identité, consommations et historique conservés.
- Affecter le besoin dès la création ; conserver les contraintes d’unicité, contrôles de stock/qualité, expiration et rejouabilité.
- Reproduction sur une copie isolée de Base Test avec les repositories et les contraintes PostgreSQL réels.

## 2026-10-13 — Identité et transferts des barres (#1256)

- Migration additive conservant le numéro scanné immuable et les transferts physiques prouvés après identification.
- Validation de la succession complète des migrations et des transferts, avec les contrôles de stock au commit.

## 2026-10-12 — Décisions qualité et barres (#1246)

- Source physique et contexte réception pour les décisions guidées.
- Réessai idempotent ; un rebut partiel conserve le verdict du reliquat du lot.


## 2026-10-12 — Comptage matière guidé (#1246)

- Les lignes d’inventaire indiquent leur unité et l’obligation de compter les barres, sans divulguer les longueurs théoriques en mode aveugle.


## 2026-10-12 — Annulation revue avant prélèvement (#1033, en préparation)

- Présenter les engagements avant annulation et permettre au planificateur de conserver la fabrication pour le stock libre.
- Garder les réservations donneuses, décisions antérieures et historiques ; réconcilier les conflits et reprises réseau.
- Lot Urgences toujours non déployé ; retour après prélèvement à terminer.


## 2026-10-12 — Reprise après ajout de récupération (#1034, en préparation)

- Prévoir explicitement le réglage et la reprise des phases clôturées hors découpe, en conservant leur historique.
- Conserver le refus définitif après découpe et les engagements clients.
- PR Urgences en cours, non déployée.


## 2026-10-12 — Compléments de récupération (#1034, en préparation)

- Enregistrer les compléments fournisseur et créneaux du regroupement dans la même transaction ; corriger le comptage par prestation.
- Branche Urgences non déployée ; recette globale et annulation en cours.


## 2026-10-12 — Prévisions fournisseur (#1034, en préparation)

- Prévoir le retour des prestations avec les préparations fournisseur enregistrées, sans inventer d’envoi ni contourner la qualité.
- Lot Urgences encore en brouillon ; ajout externe transactionnel et recette globale à terminer.


## 2026-10-12 — Application transactionnelle des récupérations regroupées (#1034, en préparation)

- Ajouter la découverte des producteurs compatibles et la confirmation atomique : allocation, quantité, matière, composants, créneaux et dossier actualisé.
- Préserver les temps et quantités déjà pointés, protéger les affaires donneuses et retrouver le producteur lors de l’approbation.
- Refuser les propositions périmées ; conserver le rejeu exact et les preuves immuables. Aucun prélèvement autorisé par cet ajout seul.
- Lot toujours en brouillon : prestations externes, phases clôturées, réconciliation après engagement et recette S06 restent à terminer avant déploiement.


## 2026-10-12 — Réservations matière des ajouts de récupération (#1034, en préparation)

- Ajouter un transfert transactionnel interne vers un regroupement ayant déjà consommé de la matière : conserver les consommations, les quantités préparées, les lots et les compteurs de stock.
- Conserver le journal initial du regroupement et enregistrer les compléments dans un journal immuable. Restituer les quantités exactes lors d'une dissolution encore autorisée, sans doubler les nouveaux lots.
- Recontrôler les exigences, la qualité et les origines après verrouillage ; refuser un transfert sans allocation exacte de récupération dans la même transaction.
- Fonction interne seulement : le raccordement à la validation du planning reste à terminer. Aucun nouveau bouton, activation ou déploiement.

## 2026-10-12 — Aperçu d’ajout avant fin de découpe (#1034, en préparation)

- Calculer la charge supplémentaire d’un OF de récupération sur un regroupement compatible, sans modifier les quantités pointées, les réservations ni les créneaux.
- Contrôler les matières et sous-pièces physiques, les origines matière, les calendriers et capacités partagées, l’AR initial et les délais courants de chaque affaire.
- Refuser une découpe clôturée, une autre PT, un autre client ou une fin trop tardive ; proposer de garder l’OF séparé. Lecture réservée au planificateur, sans cache ni action d’application à ce stade.
- Lot toujours en brouillon : aucun déploiement ni validation de recette complète.

## 2026-10-12 — Récupérations dans les producteurs regroupés (#1033/#1034, en préparation)

- Maintenir le blocage de démarrage des récupérations en attente ou annulées à travers les regroupements actifs et leurs sous-pièces.
- Protéger le planning des autres clients après le prélèvement également ; retrouver le client des OF sources et protéger les enfants d'un producteur partagé.
- Contrôler les chemins multiples, les groupes dissous et les cycles de généalogie avec le SQL réel sous le rôle applicatif, sans modification des données métier. Aucun changement de schéma ni activation du parcours d'ajout avant découpe.

## 2026-10-12 — Réceptions des récupérations urgentes (#1033, en préparation)

- Réserver les pièces conformes à l’affaire donneuse d’origine, dans la limite du prélèvement urgent ; conserver le surplus libre.
- Conserver une preuve immuable par réception, lot et réservation, y compris après libération qualité partielle et depuis un OF regroupé.
- Exposer les quantités réaffectées et restantes ; protéger contre les doubles attributions, les changements d’identité de l’OF et le dépassement de sa part de production.
- Migration additive avec verify et rollback protégé. Lot #1033/#1034 toujours en brouillon, sans déploiement.

- #1209 — Sous-traitance : clôture après réception complète, sans autoriser de nouveaux mouvements.


## 2026-10-12 — Couleurs clients et maintenance annuelle (#1169 / #888)

- Palette client commune sans rouge ; rouge réservé aux problèmes.
- Une heure le jeudi, toutes les machines actives proposées ; un jour annuel par défaut, règles existantes préservées.


- #1209 — Sous-traitance : clôture après réception complète, sans autoriser de nouveaux mouvements.

## 2026-10-11 — Client dans le snapshot de planning (#1206)

- La lecture centrale joint la fiche client existante et expose le nom et la couleur en complément du code. Ces métadonnées participent à la version de l’opération. Aucun changement de droits, de calcul, de ressource ou de schéma.

## 2026-10-11 — Canonical routing type in planning (#1203 / WP-287)

- Expose the frozen operation type alongside the existing canonical phase. Machine planning distinguishes machining operations without parsing free-text designations.
- Include the qualification-derived type in internal task versions. Resource eligibility, calendars, permissions and atomic simulation/apply guards remain authoritative. No database migration.

## 2026-10-11 — Subcontract documentary evidence ownership (#1200)

- Keep the work package's immutable evidence reference without adding an unsupported GED parent to the source document. Creating a package from a sent supplier order now preserves the plan's canonical ownership and private read policy.
- Retain canonical line/operation/evidence prerequisites and atomic audit/outbox rollback. Reproduce the deployed registry rejection and cover successful creation and prerequisite refusal. No migration or historical-data change.

## 2026-10-11 — Exact central planning timestamps (#1197)

- Preserve PostgreSQL Date milliseconds when mapping occupied, forecast and actual intervals. Adjacent cuts now start at the full persisted end instead of overlapping its final fraction of a second and failing the database exclusion constraint.
- Keep existing slots, capacity rules and transaction protections unchanged. No migration or historical rewrite. Reproduce the observed 600 ms overlap with mapped PostgreSQL dates and verify exact adjacency.

## 2026-10-11 — Ready upstream planning and pending future steps (#1194)

- Allow ready cutting/turning commitments while an unrequested, uncommitted and never-started downstream step awaits preparation. Keep its warning visible and leave it undated; no external availability or OF completion is invented.
- Explicit requests, existing commitments, locks, real production and supplier departures remain blocking. Preserve canonical recomputation, qualification, capacity, dependency-cycle and client-urgency guards. No migration or historical-data change.
- Add the canonical operation phase to the central task DTO for guided backlog ordering; no label parsing.

## 2026-10-11 — Receipt context version timestamp (#1191)

- Return the OF receipt context version as ISO 8601 UTC with PostgreSQL microsecond precision, so its unchanged optimistic-version token satisfies the strict receipt validator. Fix the observed HTTP400 before lot or stock creation.
- Preserve version comparisons, authorization, idempotence, quality and lane routing. Verify the actual context SELECT and validator under multiple database time zones; no migration or historical-data rewrite.

## 2026-10-11 — OF quality pending execution SQL (#1188)

- Compare the source identifier as text when the same SQL parameter also denotes the operation UUID. Fix the observed PostgreSQL42883/HTTP500 when opening an operation control and the same lookup during creation.
- Reproduce the original error and execute both corrected SELECTs with PostgreSQL-inferred parameter types in a READ ONLY transaction as cerp_app. No migration or historical-data change.

## 2026-10-11 — Frozen OF operation quality context (#1185)

- Prepare session quality controls from the owning OF, active operation, physical population and frozen plan; use the READY self-inspection provenance for a plan attached after the initial dossier freeze.
- Preserve the operation link in canonical executions, reject conflicting scope and concurrent duplicate pending controls, and keep newer published revisions from silently replacing the captured plan. Existing measurements and snapshots remain immutable; no database migration or permission change.

## 2026-10-11 — Cutting station execution provenance (#1182)

- Start cutting time with the existing ADAPTER provenance accepted by the canonical pointage constraint, fixing the observed HTTP500/23514 at the first station start. No schema or historical-data change.
- Preserve identified-operator audit, transaction authorization, idempotence, material/readiness guards and machine-independent cutting. Add an adapter/SQL source-contract regression that fails on the original value.

## 2026-10-11 — Single authorized metrology validator (#1179)

- Apply the requested ordinary workflow: an authorized user may record measurements and validate that execution's verdict. Keep verdict-validation permissions, measurement/certificate requirements, fresh previews, frozen records and actor audit.
- Preserve explicit stricter policies, exceptional due-date approval and return-from-quarantine rules. No authentication/MFA change, migration or historical validation rewrite.
- Cover same-author verification/calibration/intervention, a different validator and explicit separation alongside existing metrology guards.

## 2026-10-11 — Exact supplier PDF unit prices (#1176)

- Preserve sub-cent prices such as 0.025 EUR/mm and show exact quantities without database decimal padding in newly rendered official supplier purchase orders.
- Keep monetary totals rounded to cents, immutable snapshots and previously archived PDF bytes unchanged; no schema migration or business-data rewrite.
- Add precise-decimal, invalid-value and real-PDF rendering regressions, including the 3000 mm / 75 EUR HT / 90 EUR TTC recipe case.


## 2026-10-11 — Availability of incomplete quality executions (#1173)

- Detail and verdict preview report zero releasable quantity while mandatory checks are incomplete, including old positive ledgers. New measurement recalculations no longer mark partially checked units as conforming.
- Preserve completed conforming/partial controls, approved sampling, existing measurement history and the authenticated incomplete-verdict release gate. No migration or stock movement.
- Add recipe-based domain regression cases for missing dimensions, completed and partial controls, pending values and historical ledgers.

## 2026-10-11 — Assembly quantities on manufacturing documents (#1170)

- Other active-order coverage counts the same technical piece/version, customer and assembly/BOM branch. Assembly components no longer count as deliverable finished assemblies; child demand does not inherit finished-assembly stock allocations.
- A justified frozen assembly exemption prints material as non-applicable instead of warning about an impossible missing cut length. Unverified, machining and material-consuming definitions retain the warning.
- Add isolated PostgreSQL coverage and document regression checks. Preserve archived documents, internal integrity checks, API authorization and business records. No schema migration.

## 2026-10-11 — Présentation simplifiée des documents (#1167)

- Retire les empreintes des futurs PDF métier et des motifs GED générés. Conserve les empreintes stockées, les contrôles d'intégrité, l'audit et les alertes de provenance manquante ; aucune réécriture des archives ni migration.

## 2026-10-11 — Applicable assembly BOM scope (#1161)

- Generation, frozen-source preparation, child reconciliation, commercial component preview and technical sheets share one applicable BOM scope. Preserve legacy-only occurrences; exclude other indices once a piece has version-scoped definitions. Keep frozen/engaged orders and stock guards intact. No migration or historical rewrite.
- Add isolated PostgreSQL regression coverage for the observed cancellation of both assembly sub-orders, repeated synchronization, revision selection, distinct occurrences and refusal guards. Actual recipe replay remains pending.

## 2026-10-11 — Exact assembly enum regression (#1162)

- Keep the exact operation enum assertion aligned with the canonical ASSEMBLAGE type delivered by #1146; explicitly verify its accepted payload. No runtime, timeout, retry or skip changes.

## Current draft preparation policy — #1158 — 2026-10-11

- Generate root/child/incomplete/deferred orders and batch metadata with the shared policy version. Re-evaluate only unfrozen drafts under current mandatory rubrics; retain frozen and historical policy, normal review/audit and execution gates. No migration or historical data rewrite.
- Add regression coverage for policy lifecycle, generated quantities, deferred children and durable replay/conflict. Actual Test replay and the full ERP recipe remain pending.


## 2026-10-11 — Canonical plan handoff (#1155)

- Document dossiers recognise the same published, scan-released revision plans as OF preparation. Archives retain their type/revision metadata and remain preserved.

## 2026-10-11 — Assembly purchased requirements (#1152)

- Assembly supply analysis uses purchases from each selected technical version. Historical unversioned purchases remain a fallback, without counting obsolete revisions or merging distinct requirements.

## 2026-10-11 — Définition de fabrication des assemblages (#1149)

- Le premier indice reprend le type de pièce choisi. Un indice brouillon peut corriger son mode de fabrication depuis la fiche, avec contrôle de concurrence et audit ; les versions publiées restent figées. La recette complète reste en cours.

## 2026-10-11 — Montage canonique (#1146)

- Le type Assemblage est reconnu dans la gamme et le parcours OF. Le montage sans machine CN utilise uniquement son poste autonome actif, explicitement affecté. Les contrôles composants/qualité et dossiers figés sont conservés ; recette complète encore en cours.

- NC liée à un contrôle : héritage des liens lot/réception/fournisseur connus avant verrou qualité, refus des contradictions (#1143).

## OBS080 — #1140 (2026-10-11)

- Filtre UUID du BL dans le comptage et les sources paginées de facturation ; intersection des filtres et éligibilité existantes conservées. Aucune migration.

## 2026-10-11 — Qualité : protéger les contrôles à plan figé (#1137)

- Les routes historiques refusent les contrôles liés à un plan avant toute écriture et conservent les vrais contrôles historiques.
- Verrou transactionnel partagé avec le poste Qualité ; aucune migration ni modification des permissions.

## 2026-10-11 — reprise de réservation et statut commande (#1123)

- Lire le statut réel depuis le dernier événement de commande_historique, ordonné par date puis identifiant. La table commande_client ne contient aucun statut de workflow : sa lecture provoquait une erreur500.
- Retirer la colonne inventée des fixtures PostgreSQL et vérifier le refus des commandes annulées, les événements hors ordre et une annulation entre contrôle et réservation. Aucun changement de schéma ou de données métier.

## Delivery quantity projections — #1132 — 2026-10-10

- Read reserved quantity as the unconsumed remainder, including any current preparation. Preserve historical reservation totals and all stock writers.
- Project a draft/ready BL's remainder from requested minus actually delivered minus the whole preparation for that order-affair allocation on this BL, including multiple lots/lines. Shipped and cancelled BLs report the current real remainder; an unbound demand stays unknown.
- Cover the canonical SQL projections under isolated PostgreSQL. No migration or business-data repair. Actual Base Test replay, light/dark visual acceptance and the whole ERP recipe remain pending.

## 2026-10-10 — annulation après expédition partielle (#1129)

- Libérer uniquement le restant non consommé, conserver les traces déjà expédiées et vider la préparation annulée dans la même transaction.
- Refuser une réservation partagée avec un autre BL ouvert et actualiser les quantités de l’affaire depuis les engagements actifs.
- Régression PostgreSQL réelle : réserver3, expédier1, annuler2, puis reprendre le restant sur la même affaire. Rejeu Base Test encore requis.

## Delivery stock recovery — #1123 — 2026-10-10

- Preview the existing affair remainder and reserve eligible free physical stock through the canonical transaction. Retain cancelled BLs, released reservations, OLD documents and initial AR promises; create no duplicate affair, OF, shipment or email.
- Require a fresh stock/quality/version preview and a durable idempotency key. Bound shared batch, location and lot entitlement; reject stale, cross-client, blocked or committed-lane stock. Audit and module notifications commit with the reservation. Actual Test UI replay and the overall industrial recipe remain pending.

## Reservation-cart shipment promises — 2026-10-10

- Allow verified partial reservation-cart preparation and retain the consumed/restant quantities. Keep legacy preparation and shipment exact by default. Backend #1110 / OBS061.

- Capture immutable delivery promise quantities/dates in the reservation-cart shipment transaction, alongside stock and receipt/outbox writes. Preserve shipment retry idempotency and proof-based OTD. Backend #1109 / OBS060.
- Append documented reconciliation for proven historical unchanged promises only; revised, partial or unsupported evidence remains flagged for explicit review. Original AR and stock/movement records are retained.


## Independent fixed-lot replenishment roots — #1032 — 2026-10-10

- Create one canonical draft OF per fixed contract lot, with distinct stable identities, original targets and all root links in the workspace. Validate the full selection before generation and return every root on durable replay.
- Add an immutable per-lot identity and deferred completeness guard; preserve legacy acknowledgements and forbid partial or mixed launches. PostgreSQL and common business acceptance remain under validation.

## Contract replenishment preparation — 2026-10-10

- Save immutable fixed-lot proposal snapshots, original targets and applicable technical identities. Recompute the shared coverage in the caller transaction, require freshness proofs and preserve idempotent replies, audit and outbox. No OF, stock, reservation or purchase is created.
- Add guarded PostgreSQL preparation evidence, one current plan per contract and unused-only rollback. WP-286 / #1032 generation and full business recipe remain in progress.

## Invoice reference catalogue — 2026-10-10

- Return qualified billing-frame code/category/French-label records expected by the published invoice workflow, preserving the canonical catalogue and Finance read permissions. Backend #1105 / OBS059. No migration or legal/provider configuration.


## Delivery document routes and subcontract audit — 2026-10-10

- Validate BL and document UUID parameters together so archived pack PDFs and linked documents can be viewed and downloaded. Preserve document linkage, bounded storage, authentication and deletion conflicts. Backend #1102 / OBS058.
- Use the canonical transactional ACTION audit writer for subcontract custody actions and RELEASE/RETURN, preserving actor, quality gates, transaction and outbox delivery. Backend #1099 / OBS057. No migration.


## Historical stock and packaging audit — 2026-10-10

- Use the shared transactional ACTION audit writer when adding an OLD document reference or creating finished packaging. Preserve idempotency, quality checks and rollback; retain durable audit delivery. Backend #1098 / WP-285 / OBS056. No migration.


## Quality delivery policy audit events — 2026-10-10

- Persist activation as ACTIVATED and return to draft as UPDATED, matching the existing audit constraint. Preserve signed policy contents, release gates and transactional rollback. Backend #1095 / WP-285 / OBS054. No migration.


## Delivery calendar dates — 2026-10-10

- Return delivery-line due dates as calendar text from PostgreSQL in detail, line edit and both preparation paths. A 16 October promise stays 16 October in every timezone, without rewriting stock, orders, promises or existing official documents. WP-285 / OBS051. No migration.


## Recipe email routing — 2026-10-10

- Base Test redirects all outgoing mail exclusively to the recipe owner’s authorized mailbox; other internal and external recipients are excluded. Production routing and the isolated E2E sink retain their existing behavior. OBS050 / WP-285. No schema or authentication change.



## Stock valuation verifier successor — #1087 — 2026-10-10

- Verify the exact six-column #1007 key before #1022 and its seven-column successor afterward, retaining valid `NULLS NOT DISTINCT` uniqueness and the validated invoice correction identity.
- Add seven transactional negative cases to the disposable migration rehearsal. No migration, application runtime, route or permission change. Native publication remains pending complete qualification.
- Test the documented legacy shape with retained archives, prove that the old supplier rollback refuses current financial dependencies, and run the original SOL-06 rollback on its restored source prefix. Preserve immutable-patch validation, current-schema integrity, backup fingerprint checks and failure evidence.

## Customer-facing acknowledgement notes — 2026-10-10

- New AR editions exclude the form’s internal operational markers and priority, while preserving public notes and customer requirements. The snapshot and its exact PDF use one public projection.
- Previously archived editions and raw source fingerprints remain unchanged. OBS048 / WP-285 / #1084. No schema or email-delivery change. Runtime and full business recipe remain pending.

## Customer order v2 fully reserved from stock — 2026-10-10

- Prepare the AR without a fictitious planning gate when the launch reserves the complete order from OLD/NEW and generates no OF. Production, technical preparation and contract supply keep their existing gates.
- Explicit replay repairs only an invalid v2 planning state with exact existing allocation and reservation coverage, no OF/BL/sent AR/pending contract supply. Reservations and delivery affairs are reused unchanged; history and audit remain transactional.
- OBS-046 / WP-285 / #1081. No migration. Full industrial recipe remains in progress.

## Persist OF planning notifications — 2026-10-10

- Persist planning submissions, time variance proposals and AR follow-ups with their realtime outbox in the owning OF transaction. Configured active recipients can open the OF directly. Distinct decisions have distinct dedupe keys; a replay emits no second event.
- OBS-043 / WP-285 / #1032. No migration. Full industrial recipe remains in progress.

## Contract fixed-lot projection — 2026-10-10

- Calculate fixed replenishment lots from authoritative monthly shortages, with exact decimals and surplus carried once into later months. Expose a read-only projection without treating it as stock or creating OFs. Seven targeted regressions; no migration.
- Project Office WP-286 / #1032. Persistence, canonical OF generation and common business acceptance remain in progress.

## Metrology measurement persistence — 2026-10-10

- Persist the computed verdict and deviation with each reading or motivated correction, without a second unversioned update rejected by the canonical history trigger. Preserve the trigger, audit, idempotency and validated execution immutability.
- Regression reproduces initial and corrected reading failures. 120 targeted tests pass. No migration; WP-285 full recipe remains in progress.

## Supplier recommendation context — 2026-10-10

- Return the validated numeric OF identity in supplier recommendation evidence when PostgreSQL bigint identifiers arrive as strings. Preserve permissions, ranking and coherent read scope.
- Regression reproduces the browser contract failure with default bigint driver values. No migration. WP-285 full recipe remains in progress.

## Preserve purchases in technical revisions — 2026-10-10

- Preserve purchase dimensions, cutting coefficient, supplier details, price basis, VAT and totals when copying a technical version. Source rows and frozen dossiers remain unchanged.
- PostgreSQL 17 regression fixture verifies values, nulls, zero prices and source scope. WP-285 full business recipe remains in progress.

## Recipe conditional trigger precision — 2026-10-10

- Preserve the conditional OF dossier invalidation trigger while widening numeric precision. Restore its definition, enabled mode and comment inside the same transaction.
- Isolated PostgreSQL application/replay and history/permission checks passed. WP-285 business acceptance remains in progress.

## Recipe decimal precision — 2026-10-10

- Retain fractional technical unit prices and method/OF times with six decimal places. Preserve historical values and the active-execution view permissions; monetary totals remain in cents.
- Isolated PostgreSQL application/replay and history/permission checks passed. WP-285 business acceptance remains in progress.

## Complete backend acceptance fixtures — 2026-10-10

- Register seven CUMP suites in Vitest; refresh contract, lane and scope fixtures without weakening runtime guards (#1059).
- Baseline failures reproduced; affected replay passed (15 files / 149 assertions). Full frozen run required before merge.

## Contract recipe corrections — 2026-10-10

- Create manufactured client articles as sellable, lot-tracked units. Preserve existing links and historical articles; no schema migration.
- Targeted tests passed; full business acceptance remains in progress (WP-285).

## Cumulative client demand coverage — 2026-10-09

- Project remaining firm/forecast demand against shared quality-released stock and committed on-time producers.
- Preserve dedicated stock/producer shares, consume each source once, retain monthly targets and expose a read-only CERP panel.
- Common métier/UI acceptance prepared NOT RUN; fixed-batch OF proposals/generation and historical CADRE release mapping follow separately.

## Explicit forecast conversion — 2026-10-09

- Convert monthly estimates into the canonical firm order aggregate with explicit retained allocations.
- Preserve estimate/firm quantities, versions and immutable links; enforce exact replay, guards and atomic outbox.
- Common métier/UI acceptance prepared NOT RUN; cumulative coverage and fixed-batch OF proposals follow separately.

## Monthly customer estimates — 2026-10-09

- Record monthly customer estimates on contract article families with quantity, due date and customer estimate date.
- Preserve historical article/unit/month identities and audited revisions; enforce versions and exact actor/key replay with atomic outbox.
- Common métier/UI acceptance prepared NOT RUN; firm conversion, cumulative coverage and fixed-batch OF proposals follow separately.

## Historical CADRE association — 2026-10-09

- Explicitly associate historical CADRE with same-client contracts using actual family/unit identities and immutable source snapshots.
- Preserve ordered indices, AR/OLD/stock evidence; enforce canonical composition and BL scope, audit and exact request replay.
- Common métier/UI acceptance prepared NOT RUN; dedicated proforma payment isolation remains pending.

## Delivery affair backlog — 2026-10-09

- Show article affairs before stock reservation; retain client/PO/technical identity and initial sent-AR evidence.
- Separate reserved/prepared/shipped counters and partial/complete states; scope the canonical BL cart to the selected affairs.
- Common métier/UI acceptance prepared NOT RUN; proforma and historical reprise remain pending.

## BL contract compatibility — 2026-10-09

- Resolve canonical contract identities across all BL source orders; reject ambiguous mixtures before commit or stock consumption.
- Guide selections with opt-in contract metadata while preserving legacy strict cart responses.
- Common métier/UI acceptance prepared NOT RUN; proforma/payment isolation and affair backlog remain pending #1030 work.

## Client contract calls — 2026-10-09

- Bind firm calls to client master contracts through the canonical order aggregate.
- Preserve initial article/index, quantity/date and actual canonical line identity, with atomic replay, audit and outbox.
- Use CERP source fields, historical call tables, scoped retries and proactive identity/retention guards.
- Combined business/UI acceptance prepared NOT RUN; explicit legacy CADRE migration remains pending.

## Client contract catalog — 2026-10-09

- Add client-owned contracts, validated article-family selection and explicit replenishment batches.
- Keep recorded technical definitions immutable; resolve future proposals without changing historical orders.
- Enforce role, active client, optimistic version and actor-scoped idempotency with atomic audit/realtime.
- Combined business/UI acceptance prepared NOT RUN; firm-order calls remain pending.

## Reservation-backed lane routing — 2026-10-09

- Configure one explicit physical receipt destination per lane; activate only when all three are valid.
- Route new released output using canonical transfers; preserve receipt, lot and reservation evidence without consuming prepared BLs.
- Serialize topology and Quality/receipt mutations before stock access; retain historical positions unchanged.
- Combined business/UI acceptance prepared NOT RUN by user instruction.

## Released production attribution — 2026-10-09

- Reserve actual affair remainders in current AR order without counting prepared BLs twice.
- Attribute new simple, component, assembly, internal-contract and grouped receipts after real Quality release, with immutable deltas and no duplicate stock entry.
- Restore the receipt response fields required by the existing UI; reject stock quantities exceeding numeric(18,3).
- Physical lane transfers are still inactive. Combined business/UI acceptance remains prepared NOT RUN.

## Physical stock lane foundation — 2026-10-09

- Add versioned physical lane roles and immutable configuration evidence without moving stock or creating another balance.
- Expose canonical per-lot positions, reservation purposes and explicit physical-only availability scope.
- Preserve historical zones, OLD/NEW, quality and occupied reservations; automatic routing remains inactive pending #1029.
- Compile/OpenAPI checks pass; combined business acceptance is prepared NOT RUN.

## Sourced supplier recommendations — #1025

- Add exact OF/version/comparison context, displayed-evidence SHA, current order/catalogue/review references and existing ranking contributions.
- Preserve ranking and price permissions; separate confidence, qualify first and never engage an order automatically.
- Bound coherent PG17 read-only transaction to nine seconds, SQL to two seconds and quality evidence volume; Cache-Control no-store.
- Four fixtures and twelve common acceptance scenarios prepared NOT RUN; local generative service remains to be confirmed.

## Explicit sourced material invoice confirmation — #1022

- Protected Finance/financial Stock intent, full source SHA and actor-scoped UUID replay; no amount input.
- Exact signed Stock/consumed allocation, quantity-neutral balance, proved physical OF attribution and visible unassigned consumption.
- Immutable ledger/guards/audit committed atomically; additive zero-stock candidate, original guard bodies and historic costs preserved.
- Only future explicit margin versions include proved corrections; subsequent return remains unresolved pending policy.
- CUMP PREPARED, no actual financial posting; five fixtures and fifteen common acceptance scenarios prepared NOT RUN.

## Sourced material invoice reconciliation preview — #1019

- Protected Finance read-only receipt/lot proposal, approved invoice and immutable booked acquisition evidence.
- Exact variance split between traced remaining Stock and consumed material, original reliability preserved.
- Shared/old/mixed/partial/credit sources stay explained UNKNOWN; bounded repeatable-read snapshot and full source SHA.
- No financial posting, activation, schema or historical cost change; seven fixtures and combined acceptance prepared NOT RUN.

## Material order transport evidence — #1016

- Freeze complete active purchase-line monetary facts on future receipts; preserve historical proofs and previous capture function.
- Allocate transport by net HT including discount/line flat fees, exact cumulative residuals and capped partial/overreceipt amounts.
- Cursor hash includes the complete monetary basis; changed/removed transport, incomplete evidence and history gaps remain explained UNKNOWN.
- Add reversible capture migration; physical stock unchanged and CUMP PREPARED. Five fixtures and common acceptance prepared NOT RUN.

## Documented invoice header allocations — #1013

- Finance read-only exact-cent proposal for HT amounts outside fiscal lines; no caller amount input.
- Explicit source-checked approval freezes complete invoice/match/archive proof; no historical backfill.
- Subcontract margin source uses documented line allocations; serialized approval intentions and fresh archive checks.
- No physical stock, old margin, schema or CUMP activation change. Combined fixtures/acceptance prepared NOT RUN.

## Supplier receipt fee completeness — #1010

- Cap declared subcontract receipt flat fees by cumulative rounded allocation; exact six-decimal residual across partial/overreceipts.
- Unallocated transport and invalid/unsupported price facts remain explained UNKNOWN amounts; approved invoice evidence stays distinct.
- No physical, historical snapshot, Stock journal or CUMP change. Combined acceptance fixtures/scenarios prepared NOT RUN.

## Valeur actuelle du stock documentée — #1007

- Correction financière entreprise EUR, justificatif article et empreinte du solde, quantité physique inchangée. Historique immuable, idempotence et contrôle financier existant.
- Écriture DECLARED et solde atomiques sous verrou global CUMP ; valeur historique inconnue conservée. Aucune ventilation de facture tardive ni activation.
- Migration/requêtes/retour arrière compilés dans ROLLBACK sur Test/Prod, gardes #983 conservées ; recette commune préparée NON EXÉCUTÉE.

## Dossier replenishment objective — #1113

- Read the original anticipated contract target in the OF dossier instead of requiring the planner to type it again. Preserve customer promises, earlier internal dates, committed slots, and dossier completeness.

## 2026-10-10 — #1116

- Commande client : conserver les dates civiles lors de la duplication ; éviter HTTP500 dû au passage DATE PostgreSQL vers String(Date). Lecture ISO dédiée, sans mutation des délais sources ni reprise des réservations/AR.

## 2026-10-10 — #1119

- Accusé de réception : afficher et archiver le délai de livraison de chaque ligne, sans décalage de jour ni réécriture des anciens AR.

- #1121 : mesurer les libellés du bandeau PDF pour éviter le chevauchement des références longues.

## 2026-10-10 — #1124

- Livraison : permettre plusieurs BL partiels successifs sur une réservation existante ; conserver les allocations historiques et l’unicité par ligne, sans modifier les limites ou mouvements de stock. Migration transactionnelle avec préflight, vérification et retour arrière protégé.
