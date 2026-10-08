# ADR 0995 — Origine figée des réceptions de pièces fabriquées

Statut : implémenté, recette finale différée. Issue backend #995 / WP278 / #977.

Une réception OF est une fabrication, distincte d'un achat fournisseur. Son prix
de vente ou une marge recalculée plus tard ne constituent pas sa valeur d'entrée
en stock. Il faut conserver l'origine physique et les bases connues à cet instant.

## Décision

La migration additive `20261008_stock_manufacturing_sources_995.sql` crée une
frontière future et une table de preuves immuables. Au commit du mouvement Stock,
le journal capture déjà sa racine ; un déclencheur enregistre alors réception
canonique, OF, PT/version, lot, quantités bonnes/rebut/retouche, état qualité,
opérations, déclarations et dernière marge ACTUAL sauvegardée. Ces faits possèdent
un SHA et le lien exact au SHA du journal dans la même transaction. Toute insertion
hors de ce chemin, modification, suppression ou troncature est refusée.

La capture est bornée : deux réceptions permettent de détecter une ambiguïté,
100 opérations et 1 000 déclarations ; au-delà, une anomalie explicite est figée.
Le contenu d'une marge est limité à 512 Kio, le dossier à 1 Mio ; les contenus
volumineux sont omis avec un diagnostic. Il n'y a aucun rattrapage des anciennes
entrées. La migration requiert le projecteur PREPARED, vide et non initialisé.

Le parseur vérifie les liens OF/article/lot/PT/version/unité/quantité. Le projecteur
distingue cette origine et conserve les références de preuve. Une réception
fabriquée ne passe plus dans le résolveur de prix d'achat. La valeur reste UNKNOWN
avec `MANUFACTURING_VALUE_ALLOCATION_REQUIRED`, même si une marge a été sauvegardée.
Une marge estimée/partielle ne devient pas une valeur de fabrication vérifiée.

## Limites / étapes suivantes

Ce lot prépare la provenance ; il ne valorise pas les pièces fabriquées et n'active
pas le CUMP. La sélection/validation de la base de coût, le partage exact entre
réceptions partielles et les annulations de cette allocation restent à développer
avant activation, avec l'ouverture historique et les corrections de factures.
Le Stock continue à recevoir la quantité physique même si sa preuve monétaire
manque. Aucun montant n'est inventé pour contourner une donnée absente.

## Validation et récupération

TypeScript/build/OpenAPI et six PREPARE/EXPLAIN sous cerp_app Test/Prod, avec DDL
dans ROLLBACK. Ces contrôles vérifient le schéma, pas l'exécution métier des
déclencheurs. Recette métier/sécurité/concurrence préparée **NON EXÉCUTÉE**, finale
commune différée à la demande utilisateur.

Preflight et verify accompagnent la migration. Le retour arrière SQL ne supprime
que des structures vides avec projecteur inactif ; après première capture, conserver
les preuves et réinstaller un backend compatible ou préparer une correction
additive. Ne jamais effacer une source historique pour revenir en arrière.
