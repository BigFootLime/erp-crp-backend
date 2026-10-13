# OF atelier 1.4 — nomenclature et sources vérifiables

## Édition atelier 1.6 — 13/10/2026

Les bandeaux des zones passent de30 à24points sans réduire la police. Le cartouche matière ne répète plus l'opération consommatrice ; la pièce ne répète plus la gamme, qui conserve sa table complète. L'échéance connue figure au premier rang : AR client, sinon cible interne lue sur la même transaction (ligne ou réapprovisionnement contractuel). Une cible passée est conservée et une date inconnue reste À définir ; aucune fin prévisionnelle ne se transforme en promesse. Les fichiers1.4 et1.5 gardent leurs primitives et renderers figés, vérifiés par empreinte.

Exemple demandé : les valeurs lisibles du boîtier45252966B des photos sont transcrites dans un PDF illustratif, sans insertion dans l'ERP ni validation électronique de ses signatures papier. Matière6061/T651, débit57mm,40bruts, documents, argenture et opérations20→120 sont conservés ; temps en minutes ou heures/minutes. Les noms d'opérateurs et les dates de visa non présents dans les photos ne sont pas inventés. Issue1297/WP289, recette globale ouverte.

La nouvelle édition place les composants, matières, traitements, sous-traitances et achats avant la gamme. Le titre et le numéro d’OF sont centrés. Les zones sont opaques et les tableaux poursuivent leurs lignes sur autant de pages que nécessaire. Les temps sont exprimés en minutes ou heures/minutes, avec des fractions de minute pour les temps unitaires très courts. La fiche technique contenant la gamme présente uniquement le code client, sans son nom ni son logo.

La première ligne oppose Commande (référence et AR, puis quantités demandée/lancée côte à côte) à Matière et débit. La matière essentielle apparaît dans la moitié supérieure de la première page. La deuxième ligne oppose Client/affaires et documents à Pièce. Les cadences détaillées restent intégrales pour les commandes comportant plusieurs AR ; l’en-tête met en évidence le plus proche. Les longues références sont conservées et les données matière ne sont pas répétées dans un deuxième grand panneau.

## Sources

- Une révision complète utilise son propre dossier figé. Une ancienne révision initiale ne peut emprunter le dossier courant que si elle est encore active. Les révisions obsolètes restent indépendantes.
- La nomenclature conserve la quantité par ensemble figée et calcule le besoin pour la quantité lancée. Pour les anciens dossiers ne contenant que les identifiants, les références proviennent de la structure générée et de la version enfant épinglée ; aucune dernière version de PT n’est substituée. Une donnée absente reste explicitement à compléter.
- Les nouveaux dossiers figent aussi les références lisibles des composants. Les instantanés existants ne sont pas réécrits.
- Les besoins matière doivent correspondre à la version technique, à son empreinte et à l’opération de la révision sélectionnée. Les débits annulés ou corrigés sont exclus du solde affiché. Un pas de débit ne devient pas implicitement une longueur de brut.
- La quantité expédiée provient exclusivement des allocations de BL expédiés ou livrés. Le stock réservé restant, la production attendue et les sorties qualifiées sont distincts. Un producteur regroupé plafonne les parts des OF sources ; il n’est pas compté une seconde fois.
- Les compteurs de production terminée ne créent aucun visa. Les productions internes ou de sous-pièces ne sont pas présentées comme une livraison client.

## Cohérence et réimpression

L’aperçu est lu dans une transaction PostgreSQL répétable en lecture seule. L’empreinte des faits approuvés ignore la date d’édition, l’auteur et le filigrane. Elle est vérifiée avant l’émission puis après verrouillage de l’OF. Une modification renvoie une erreur 409 avec action d’actualisation. Un nouvel essai idempotent vérifie OF, révision et faits attendus avant de retourner les octets archivés. Le repli utilise exclusivement le payload enregistré et refuse toute différence de contenu ou de taille. Aucun droit ni audit n’est affaibli.

## Vérification

Tests ciblés : charges communes au planning, séparation des anciennes éditions, pagination longue, ordre nomenclature/gamme, temps courts, résolution des dossiers, réimpression et clés idempotentes. Treize cas de couverture exécutent la requête de projection dans PostgreSQL sur des relations VALUES, sans écriture dans les bases métier : livraison partielle, réservations, réceptions qualifiées/quarantaine, pertes, annulations, autre client/version, sous-pièces, AR initial et plafonnement d’un regroupement.

Le véritable producteur de payload et le moteur PDF sont aussi exécutés en lecture seule sur les OF fictifs 95 et 101 de Base Test. Ils montrent respectivement 0 et 4 pièces expédiées, deux barres pour l’axe et deux composants pour le montage. Ces preuves techniques ne clôturent pas la recette métier complète. Les logos, plans et esquisses d’outils automatiques, les autres familles PDF et l’impression physique restent dans le chantier parent.

Aucune migration pour ce lot. Sauvegardes Test/Prod vérifiées sur le VPS avant déploiement. Le statut de publication et de déploiement est tenu séparément dans le journal de recette.

## Édition atelier 1.5

La date de génération est conservée uniquement au pied. La police reste Helvetica/Helvetica-Bold comme le document de référence. Le code client et l’affaire de livraison sont deux champs distincts ; le nom client n’est pas imprimé. Références matière et documents utilisent la largeur complète de leur bloc. La commande réserve davantage de largeur à la référence, tout en maintenant l’AR à côté. La nomenclature matière, les sorties de barres et les prestations précèdent les opérations. Les minutes restent exactes pour les temps unitaires courts et la charge possède une colonne assez large pour « 1 h 20 min ».

Les éditions 1.4 déjà enregistrées conservent leur renderer et leurs primitives figés : un cas de référence vérifie les octets à l’identique du commit déployé cb998c54. Cette conservation ne remet aucune ancienne quantité à jour. Validation : 107 tests ciblés, build strict, coordonnées et polices des deux OF de recette, inspection des six pages. Les PDF de démonstration sont des brouillons issus d’une lecture répétable de Base Test, sans émission officielle.

## A4 fold clearance — follow-up #1300

Template 1.7 uses compact spacing only for the four essential first-page cartouches. Helvetica values remain at 10 pt, deadlines and quantities at 13 pt; labels at 8 pt. Routing and nomenclature retain the existing full-size typography. Material need/debit calculations are unchanged; only labels are shortened.

The full paper boîtier example (40 pieces, 6061/T651, 11 phases, treatment and four documents) ends the cartouches at 407.86 pt; the A4 fold is 420.945 pt, leaving 4.62 mm. Actual recipe PDF sources OF95/OF101 leave 24.72/30.55 mm. All pages are rendered with Poppler and visually reviewed; rectangle geometry and retained text are checked with pdfplumber. A fine grey dashed fold guide is printed at the halfway mark, as requested after the preview. Details start below it; oversized cartouches retain their full-content pagination fallback. Long content remains paginated without truncation.

Archived renderers 1.4/1.5/1.6 are frozen. The saved 1.6 fixture remains SHA-256 `cf0e5a8ad3e9199d09d4799e6f28f37c1a0a308fd9733ceb748b9ec22a95f0e3`. This is layout qualification, not closure of the overall manufacturing recipe.
