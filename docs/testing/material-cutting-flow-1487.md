# Rendement matière de la PT vers l’OF et le PDF — #1487

Demande utilisateur du 29 octobre 2026, frontend #1805. Pas de migration.
`longueur_mm` porte la longueur de coupe et `quantite_pieces` le nombre canonique
de pièces par brut ; une valeur 1/3 signifie trois bruts par pièce.

`piecesPerBlank` est ajouté facultativement au JSON de règle de débit. Sans
cette donnée, les règles existantes conservent leur calcul. `unitsPerBlank`
reste la longueur physique consommée par brut, indépendante du rendement.
Le besoin de l’OF arrondit au brut entier avant le calcul de consommation ;
les déclarations atelier de bruts déjà débités restent des quantités physiques.

Les DTO matière et preuves techniques exposent `cutting` par ligne : longueur
de coupe, pièces/brut, bruts/pièce, nombre de bruts et longueur totale. Une
longueur absente n’empêche pas de transmettre le rendement et le nombre de
bruts d’une matière unitaire. Le PDF atelier affiche les données de chaque
matière sans sélectionner implicitement la première ligne.

Contrôles ciblés : 100 pièces, deux par brut, coupe de 100 mm → 50 bruts et
5 000 mm ; 101 pièces → 51 bruts et 5 100 mm ; trois bruts par pièce → 303
bruts. Contrôles de rétrocompatibilité des règles sans rendement et des
versions de dossier. Aucune donnée métier n’est modifiée par les vérifications.
