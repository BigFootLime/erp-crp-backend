# Dossier de fabrication et exemplaires papier — #1320

## Règle confirmée

Le premier exemplaire officiel de l'OF ne porte aucun filigrane ; les suivants portent DUPLICATA. Un document brouillon reste BROUILLON et ne consomme pas un exemplaire officiel. Les aperçus, téléchargements et déplacements de planning sont distincts d'une intention d'impression. Le rejeu d'une intention doit conserver son exemplaire, jamais incrémenter le compteur une deuxième fois. Une définition obsolète reste signalée.

L'ordinal représente une intention acceptée, pas une preuve physique que le papier est sorti. Les demandes sont persistantes et sérialisées par OF/révision, y compris lorsqu'une annexe sera ajoutée à un dossier déjà imprimé. La reprise du spooler natif reste à raccorder.

## Moteur documentaire

Les PDF sources sont vérifiés par leur empreinte et assemblés dans l'ordre du dossier. Les pages et notes des plans sont conservées ; les actions interactives des annotations ne le sont pas. Les formulaires remplis sont aplatis seulement dans la copie d'impression. Les octets de l'original GED restent inchangés et le DUPLICATA est ajouté sur les seules pages de l'OF, sans régénérer les opérations depuis les données courantes.

Les plans PNG/JPEG sont convertis automatiquement en PDF avec orientation EXIF, ajustement sans recadrage et conservation de l'image source. Les bornes sont40 documents,200 pages,50Mo de sources et40M pixels par image. Une source non imprimable ou altérée produit une erreur métier, sans consommer d'original. Une indisponibilité de rendu est distincte d'un plan invalide.

Les références de plans viennent de l'instantané OF : identifiant de document, version et empreinte. Les rôles historiques reconnus par la préparation sont conservés avec leur rôle de lien d'origine. Il n'existe aucun repli implicite sur le dernier plan de la PT. La vérification serveur des liens, droits, scan et appartenance à l'OF reste à raccorder à ces références.

Les fiches de préparation et d'informations techniques/suivi reprennent les rubriques des modèles source MD38-D et MD61-A lus sur Z:\Qualité. Elles utilisent la grammaire CERP/Helvetica, le logo CRP et uniquement le code client. Les identités sont préremplies ; les commentaires, constatations, mesures et signatures restent vierges. Le modèle source reste inchangé ; le rendu adapté porte CERP support/1.0.

PDF-LIB 1.17.1 est épinglé pour l’assemblage. Les lockfiles pnpm et npm conservent toutes les versions et entrées préexistantes ; quatre entrées pnpm et sept entrées npm nécessaires sont ajoutées. Le Dockerfile utilisant npm ci, son lockfile est synchronisé avant publication. Le runtime PDFKit déjà présent assure la conversion des images.

## Vérification locale

121 tests backend ciblés et de non-régression passent, ainsi que 5 tests du bouton : marques, provenance figée, notes et actions, formulaires, images, rejet des copies altérées, première impression, brouillon, duplicata, doubles clics et reprise réseau. Compilation stricte backend : 1480 opérations et 1382 fichiers runtime. Typecheck et build web passent. Aucune recette métier complète n’est revendiquée.

La nouvelle commande POST `/:ofId/documents/:documentId/print-intents` exige la capacité document et une clé d’idempotence. Elle fige son exemplaire dans la même transaction que l’audit. Le premier original est restitué à l’octet ; les variantes sont archivées dans des documents GED distincts. Après perte de l’ACK COMMIT, la demande est rapprochée par sa clé sans compensation prématurée. Une clé réutilisée pour un autre acteur/document/OF est refusée. Les GET PDF continuent à conserver l’original et l’audit d’accès, mais n’incrémentent plus l’ancien compteur de téléchargements.

Le modèle additif `20261014_of_document_print_intents_1320.sql` est qualifié sur une restauration du schéma Test, sans données métier, dans une base PostgreSQL 17 jetable : application, réapplication, rollback à vide avec accord explicite, refus du rollback après preuve sauvegardée, privilèges SELECT/INSERT uniquement. Trois commandes de production exécutées sous cerp_app, dont deux concurrentes, donnent les ordinaux 1/2/3 et une seule variante DUPLICATA. Deux rejeux conservent les octets et le compteur. L’émission initiale du document est une fixture synthétique explicite ; aucune impression physique n’a eu lieu. Les erreurs initiales de fixture ont été corrigées en renseignant identité racine/version de PT et en laissant sa famille facultative vide, sans modifier les contraintes.

Trois dossiers fictifs de9 pages sont produits et contrôlés : OF/gamme/nomenclature4 pages, plans fictifs2 pages, autocontrôle1 page, amélioration1 page, préparation1 page. Extraction des textes : code client seul, marque limitée aux4 pages OF, aucun préremplissage de mesure ou visa. La gamme d'essai issue de l'ancien papier avait une base de40 déjà appliquée ; son adaptation utilise la base unitaire1 et la quantité lancée40, pour retrouver59h de fabrication +12h de réglage =71h. Aucun calcul de production existant n'est modifié par cet exemple.

La revue visuelle a corrigé des fonds noirs sur les dessins fictifs, les mots coupés et lignes de remplissage inutiles, et les feuilles presque vides causées par des zones d'écriture trop grandes. Les erreurs de typage du nouveau rendu ont été corrigées ; le test utilisant la fixture commune est placé dans src/__tests__, hors compilation runtime. Le fichier JS émis hors dist lors de l'erreur rootDir a été supprimé après vérification de son origine.

## État et travail restant

Moteur, exemples, API d’impression OF et bouton codés et qualifiés avant publication. Le compteur durable représente les demandes acceptées ; il n’invente pas un historique physique depuis les anciens téléchargements. L’utilisateur peut toujours imprimer un fichier téléchargé hors de l’ERP, ce que ce compteur ne mesure pas. Aucun dossier n’est imprimé physiquement.

Restent : sélection des annexes réelles et disponibilité guidée, registre/archivage du dossier complet, automaticité après planning validé, fiches conditionnelles nouvelle pièce/indice, bouton du dossier depuis l’OF/planning, queue A4 Electron et essais réels Test/natif/imprimante. La publication et le déploiement du lot d’impression OF sont suivis séparément dans le journal de recette. Le dossier complet et la recette globale restent ouverts dans l’issue 1320 et le chantier parent.
