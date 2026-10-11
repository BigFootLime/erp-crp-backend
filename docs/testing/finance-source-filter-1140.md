# OBS080 — Lecture des sources de facture par BL

Le listing paginé accepte `livraison_id` UUID optionnel, filtré dans le même WHERE paramétré pour le comptage et la page. Les filtres existants client/commande/affaire se combinent ; les BL non expédiés/livrés et commandes internes restent exclus. Aucun changement de mutation, droit, qualité, métrologie, annuaire, politique ou migration.

Tests ciblés : UUID invalide/refus de clé inconnue ; vrais appels repository vérifiant la liaison paramétrée commune comptage/page et intersection. Compilation stricte/OpenAPI, déploiement avec frontend1370 puis rejeu Base Test BL48 requis. Ces tests SQL mockés vérifient le contrat des requêtes ; ils ne sont pas présentés comme recette PostgreSQL réelle ou facture émise.

État avant vérification : candidat en cours.
