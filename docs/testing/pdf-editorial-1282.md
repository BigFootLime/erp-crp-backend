# Documents lisibles en atelier — premier lot de la refonte PDF

## Référence approuvée courante — 14 octobre 2026

La capture OF-EXEMPLE-23149 fournie par Keenan est la référence commune pour **toutes** les familles d'exports, avec adaptation des seules rubriques métier : logo CRP complet, Helvetica/Helvetica-Bold, titre centré, numéro rouge lisible, cartouches anthracite compacts, fond blanc opaque, filets fins et tableaux entièrement cadrés. Ne pas reproduire le filigrane EXEMPLE sur un document réel. Les UUID/SHA techniques restent internes. La date de génération au pied suffit, sans doublon « Édité le » dans l'en-tête.

Pour les OF/gammes : code client seul, sans nom ni logo client. Affaire de livraison distincte du code client. Commande/délai (AR ou interne toujours identifié)/quantités, matière et débit, client/documents, puis pièce occupent la moitié supérieure de la première page. Traitements et autres composants figurent dans la nomenclature **avant** la gamme. La ligne pointillée repère le pli A4 ; plusieurs pages sont autorisées, sans couper une opération ou ses visas inutilement. Les temps sont affichés en minutes ou heures/minutes, sans heures décimales. Les références sont conservées et mesurées pour éviter les retours de ligne arbitraires ; aucune valeur ou exigence n'est tronquée pour gagner de la place.

Les documents commerciaux conservent les identités nécessaires du destinataire/sociétés facturées et leurs montants exacts. La densité est adaptée à chaque document : pas de bloc, texte d'aide ou échéance répétés sans nécessité. Contrôler les cas simples, longs et multipages en rendu A4, avec pieds, en-têtes et signatures lisibles. Ne jamais régénérer les bytes d'une édition déjà émise.

L'OF 1.7 et la fiche papier d'autocontrôle 2.0 sont déjà livrés. Les exemples proforma, facture et avoir utilisent le dessin structuré commun sur la branche #1268 ; ils ne constituent pas encore une livraison de ce lot. PT/gamme séparée, BL, devis/ARC, commandes fournisseurs, certificats et étiquettes restent à harmoniser/rejouer dans WP-289. Aucune famille ne doit être déclarée terminée sur la seule base d'une maquette.

## Historique du premier lot

Le gabarit `of-ordre-fabrication/1.3` remplace les onze colonnes serrées de la gamme par des cartes d’opération. Chaque carte porte son numéro, sa machine, son programme, ses temps, ses quantités et les visas effectivement enregistrés. Les petites durées unitaires conservent leurs heures décimales : une durée sous une minute n’est plus présentée comme « 0 min » dans la nouvelle carte.

Le socle `editorial-v2` apporte des bandeaux opaques numérotés, des champs mesurés, des en-têtes de tableau adaptés au texte, des références répétées sur les pages suivantes et une pagination tenant compte des zones de signature. La palette CERP, le logo officiel complet et la géométrie A4 sont conservés. Les grilles de plus de trois identifiants prennent plusieurs lignes lisibles.

Les anciennes versions de gabarit gardent leur branche classique. Les fichiers déjà archivés ne sont pas réécrits. Les identifiants et empreintes restent dans l’instantané ; les UUID techniques ne sont plus ajoutés au pied imprimé du nouveau gabarit. Aucune règle de fabrication, de réservation ou de validation n’est modifiée.

Le support de visuels accepte uniquement des buffers PNG/JPEG résolus par l’appelant autorisé. Il conserve l’image complète, sa légende et sa référence. Une image facultative corrompue ou dépassant les limites est omise. Il n’effectue aucune requête réseau et n’accepte aucun chemin d’image externe.

## Validation de ce lot

- Build strict et contrat des 1 479 routes validés.
- 90 tests ciblés : nouveau socle, OF, archivage/émission, régressions des rendus existants et précision des quantités/prix fournisseur.
- Six maquettes fictives : OF opérateur, gamme, BL, commande fournisseur, facture et dossier dense multipage.
- Un exemple supplémentaire produit par le véritable `renderOfDocument`, avec client et références fictifs : trois phases, dont un visa enregistré.
- PNG de toutes les pages produits avec Poppler puis relus avec PDFium. Le premier prototype isolait la signature sur une page ; la version corrigée tient sur deux pages sans perdre la signature. Les en-têtes et pieds sont également vérifiés dans le texte extrait et les détails raster à taille réelle.

Les artefacts et journaux sont conservés dans `cerp-audit-flux-20261006/recette-20261009/output/pdf/editorial1282`, `evidence/editorial1282-r2` et `evidence/editorial1282-r2-pdfium`, avec les preuves JSON dans le dossier d’audit.

## Suite, encore ouverte

Ce lot ne termine pas la refonte de tous les documents. Les autres familles ont des maquettes mais leurs producteurs ne sont pas encore migrés. L’intégration automatique des logos clients, du plan applicable et des esquisses d’outils exige encore leur sélection autorisée et leur gel dans chaque édition. Les champs de consigne qui ne sont pas présents dans le payload OF historique ne sont pas inventés. Les gabarits PT/gamme, BL, commerce, finance, étiquettes et aperçus web/natifs restent dans le chantier #1282 / frontend #1547, suivi par WP-289.

La recette métier globale, les cas complexes et l’impression physique restent des validations distinctes. Les données de démonstration ne prouvent aucune fabrication réelle ni aucune installation native.
