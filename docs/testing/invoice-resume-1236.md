# Reprise d’une facture enregistrée — #1236

Project Office : FLUX-20261009-08 / WP 285. Frontend associé : #1468.

La lecture `GET /factures/workflow/:id`, protégée par la capacité Finance `read` et une session authentifiée, restitue le statut, la version, l’empreinte de validation, les lignes, montants et échéances enregistrés. Une seule requête SQL donne une vue cohérente. Elle n’écrit rien, ne relance pas le calcul des sources BL et ne produit pas de reçu de commande fictif. Une facture historique sans parcours retourne une erreur explicite ; aucune valeur d’approbation n’est fabriquée.

Les actions suivantes restent les endpoints existants : permissions, versions attendues, idempotence, contrôle qualité, émission et audit sont conservés. Aucune migration ni modification de configuration de transmission électronique.

Vérification du 12 octobre 2026 : 11 tests ciblés passent (lecture et autorisations), TypeScript passe. Requête réelle exécutée en transaction `READ ONLY` sur Base Test : facture 1 approuvée, version 3, une ligne de 4 pièces, 480 EUR TTC, une échéance. L’émission réelle reste à rejouer après renouvellement MFA de la session ; cette lecture ne vaut pas validation de la recette complète.
