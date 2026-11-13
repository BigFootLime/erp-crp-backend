# Qualification rétrospective Vision — quatre cycles 2026

Date de l'essai : 2 novembre 2026. Périmètre : quatre programmes réels Vision
Systems Aeronautics, S34, S39, S41 et S44 de 2026. Les fichiers restent sur le
partage métier. Aucun PDF, OCR, CSV produit, identifiant client, commande ou
ligne n'a été ajouté au dépôt, importé dans CERP ou envoyé à un service externe.

## Méthode reproductible

Pour chaque PDF, l'opérateur a exécuté localement
`scripts/demand/vision_programme_review.py` avec un dossier de sortie sous le
répertoire temporaire Windows et `source-version` égal à la semaine concernée.
Le convertisseur a été exécuté sans argument d'import et sans accès à la base
ERP. Il conserve par conception `REVIEW_REQUIRED=TRUE` et `NO_AUTO_APPLY`.

Les sources de contexte consultées, sans les copier dans Git, sont le planning
VS/CRP de novembre 2024, les tableaux de commande et décalage 2025, et
l'archive CLIPPER « Prévision livraison » du 31 juillet 2026. L'archive
CLIPPER n'a pas servi à créer une identité ou une annulation : son format doit
être qualifié séparément par l'ADV avant tout rapprochement.

## Ce que permettent les tableurs retrouvés

| Source | Constat sur le contenu | Conséquence pour l'ADV |
| --- | --- | --- |
| Tableau de commandes du 22 septembre 2025 | 120 couples commande/article exploitables. Colonnes `Cde Order`, `QTE_CDE`, `QTE_LIV`, `QTE_SOLDE` et `UA`. | L'adaptateur lit le numéro de commande, le solde à livrer et l'unité. Les identifiants de ligne et d'échéance manquent. |
| Décalage du 5 mars 2025 | 34 lignes renseignées, 32 couples commande/article distincts. Deux couples apparaissent plusieurs fois. | Un rapprochement par commande et article peut déplacer la mauvaise échéance. |
| Planning des commandes ouvertes revu le 3 décembre 2024 | Présence du contrat, de la commande, de la date de besoin et du solde. | Le planning aide à relire un écart. Il ne fournit pas les deux identifiants requis. |
| Extrait CSV joint | 676 lignes, sans quantité ni identifiants stables de ligne et d'échéance. | Une nouvelle date ou une valeur sentinelle passe en revue. |

Pour la prochaine semaine, demander à Vision un export avec les colonnes
suivantes. L'ADV renseigne la version et la date d'extraction si celles-ci
figurent dans les métadonnées du fichier. L'identifiant d'échéance doit
survivre à un changement de date ou de quantité.

`SITE,NUM_CDE,ID_LIGNE,ID_ECHEANCE,ARTICLE,FERMETE,QTE_SOLDE,UA,DATE_BESOIN,CONTRAT,source_version,source_as_of`

Le rapprochement du lundi suivant se fait sur le site, la commande, la ligne
et l'échéance. Conserver la version précédente, les décisions et les lignes
qui ont exigé une relecture. L'ADV consigne une ligne par cycle avec la date
de réception, les minutes de traitement manuel et dans CERP, les écarts
acceptés, refusés et non résolus, le nombre d'AR émis et les doublons vérifiés.

## Résultat de la conversion locale

| Cycle | Pages | Candidats fermes | Candidats prévisionnels | Pages bloquées | Décision |
| --- | ---: | ---: | ---: | ---: | --- |
| S34-2026 | 8 | 52 | 71 | 8 | Revue requise |
| S39-2026 | 8 | 33 | 89 | 8 | Revue requise |
| S41-2026 | 8 | 38 | 90 | 8 | Revue requise |
| S44-2026 | 8 | 49 | 126 | 8 | Revue requise |

Les 32 pages sont des scans. L'exécution locale a utilisé Tesseract 5.5.3,
avec les langues française et anglaise installées hors du dépôt. Tous les
candidats, y compris les cellules « ferme », restent bloqués par
`OCR_OR_TRANSCRIPTION_REVIEW_REQUIRED` et `NO_AUTO_APPLY`. Les identifiants
stables sont absents pour les 548 candidats. Les cellules fermes (172 au
total) portent aussi `FIRM_CELL_OCR_REVIEW_REQUIRED` : les zones date/quantité
peuvent être ambiguës ou se chevaucher. Ces chiffres décrivent des candidats
OCR et ne constituent ni des commandes, ni des confirmations, ni des
annulations.

## Comparaison et mesure ADV

Les quatre semaines choisies (S34, S39, S41 et S44) sont des points de
contrôle distincts, pas quatre semaines consécutives. Elles prouvent que le
convertisseur sait produire une file de revue locale, mais elles ne constituent
pas encore le pilote opérationnel à quatre cycles hebdomadaires consécutifs.
La comparaison inter-semaines ne peut pas être chiffrée : aucun candidat OCR
ne possède la clé stable de commande, ligne et échéance requise. Il est donc
impossible d'affirmer un ajout, un déplacement, une réduction ou une annulation
depuis ces essais. De même, aucun relevé horodaté du temps ADV de traitement
manuel n'était joint aux sources consultées ; le gain de temps n'est pas mesuré
et ne doit pas être annoncé.

Pour fermer la recette, l'ADV doit conserver, hors Git, une transcription/OCR
locale vérifiée pour chacune des quatre semaines et associer les identifiants
stables de commande, ligne et échéance. Le test suivant devra alors comparer
les quatre versions successives et compter : ajouts, déplacements, variations
de quantité, ambiguïtés, décisions ADV et temps de traitement. Toute ligne
absente restera `REVIEW_REQUIRED` jusqu'à décision explicite ; elle ne sera
jamais transformée en annulation par le convertisseur.

## Registre des écarts

| Écart | Effet | Décision attendue | Preuve de fermeture |
| --- | --- | --- | --- |
| OCR ambigu sur cellules fermes | 172 candidats fermes restent non fiables | Faire relire chaque cellule date/quantité et conserver la preuve locale | Fichier de revue local signé par l'ADV, hors Git |
| Identifiants stables absents des scans | Aucun rapprochement fiable possible pour 548 candidats | Associer commande, ligne et échéance à partir de l'export Vision complet | Quatre fichiers normalisés validés |
| Baseline temps ADV absente | Gain non mesurable | Relever le temps de quatre cycles manuels puis de quatre cycles pilotes | Tableau de mesure validé par ADV |
| Consentement/export non attesté | Aucun portail ou échange externe autorisé | Obtenir la validation métier et sécurité distincte | Preuve de consentement hors ce rapport |
