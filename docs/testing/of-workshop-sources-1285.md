# OF atelier 1.4 — nomenclature et sources vérifiables

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
