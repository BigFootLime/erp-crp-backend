# ADR-0080 — Gate produit du portail fournisseur

- Statut : accepté
- Date : 2026-08-15
- Décisionnaire : Keenan Martin
- Portée : SOL-35 et CLAUDE-16

## Contexte

Un portail fournisseur crée une nouvelle frontière Internet, des identités externes, des données contractuelles, des dépôts documentaires et des actions qui peuvent modifier une promesse d'achat. Il ne doit pas être construit sur la seule hypothèse qu'il pourrait être utile.

SOL-35 impose donc un besoin fournisseur réel et répété. La mesure effectuée le 15 août 2026 dans une transaction PostgreSQL `READ ONLY` donne pour `cerp_prod` : un fournisseur actif, aucune commande fournisseur et aucun fournisseur ayant reçu au moins deux commandes non annulées. Les 60 commandes de `cerp_test` appartiennent au jeu déterministe de validation et ne constituent pas une preuve métier.

## Décision

Le portail fournisseur est placé en **No-Go produit**. Aucun compte externe, endpoint public, table, projection, document publié, notification ou écran de portail n'est ajouté tant que la précondition n'est pas démontrée.

Le gate peut être rouvert uniquement lorsque les preuves suivantes existent ensemble :

1. au moins deux commandes d'achat réelles non annulées adressées au même fournisseur sur une période de douze mois ;
2. une confirmation écrite du besoin répété portant sur au moins une action précise : accusé de commande, proposition de date, dépôt d'un document ou réponse à une non-conformité ;
3. un fournisseur pilote nommé et consentant, un propriétaire métier Achats et un responsable de support ;
4. la liste des champs exposables, des validations internes obligatoires et des délais de conservation approuvés ;
5. un environnement de pilote, un canal d'invitation et de récupération, et les secrets dédiés provisionnés hors dépôt.

Ces critères sont des conditions minimales, pas une autorisation automatique de développement. Le périmètre reste limité au besoin financé et ne doit pas reproduire le module Achats.

## Architecture réservée après réouverture

Une future implémentation devra reprendre les contrôles éprouvés du portail client sans réutiliser ses identités ni son audience : identité fournisseur distincte de `users`, rattachement à un seul `fournisseur_id`, JWT/session dédiés, projections SQL en liste blanche, filtrage dérivé exclusivement de l'identité vérifiée, invitations à usage unique, idempotence persistante, audit append-only et tests de non-fuite entre fournisseurs.

Une proposition de date ou une réponse contractuelle restera une proposition externe. Son application à la commande interne exigera une validation Achats explicite, idempotente et auditée.

## Conséquences

- CERP+ n'expose pas aujourd'hui de nouvelle surface d'attaque ni de faux parcours fournisseur.
- Aucune migration, variable d'environnement, sauvegarde spéciale ou opération de rollback n'est nécessaire.
- CLAUDE-16 est non applicable : il n'existe aucun portail fournisseur fonctionnel à retoucher et il est interdit d'en inventer un à des fins visuelles.
- La requête de preuve et ses résultats sont consignés dans `docs/execution-reports/SOL-35.md`.

## Retour arrière

Cette décision ne modifie aucun runtime ni aucune donnée. Son retour arrière consiste à remplacer cette ADR par une nouvelle ADR citant les preuves du gate, le fournisseur pilote, le besoin financé et l'architecture approuvée. L'historique de la présente décision doit être conservé.
