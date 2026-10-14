# Correction d'un remboursement enregistré par erreur — #1268

Un utilisateur habilité peut corriger un remboursement complet, sans supprimer le fait d'origine. Le serveur reprend son montant, sa société facturée, sa devise, son mode et ses références. La commande demande un motif, une confirmation et des dates valides. Elle ne déclenche aucun virement.

`POST /paiements/workflow/refunds/reversals/preview` lit l'original. `POST /paiements/workflow/refunds/reversals/register` enregistre une correction unique, avec l'empreinte de l'aperçu et une Idempotency-Key stable. Le même appel rejoué retrouve la même correction. Une seconde intention sur le même remboursement renvoie 409. Aucun second acteur n'est requis ; les permissions `payment_register` et `payment_allocate` restent obligatoires.

Les tables originales restent immuables. Les lecteurs économiques utilisent les vues effectives qui excluent le remboursement compensé ; les lecteurs comptables conservent l'original et sa correction. La correction restaure les budgets remboursables et recalcule les soldes. Elle ne crée pas une seconde correction de TVA.

L'export inverse exactement les comptes, journaux, comptes tiers et axes du remboursement déjà exporté. Si l'original n'est pas encore exporté, il doit être inclus avec sa correction dans le même lot. Sans l'une de ces preuves, l'aperçu bloque avec une action explicite. Un export original utilisé par une correction ne peut plus être libéré pour changer ses comptes. La sérialisation Finance couvre la correction, la génération comptable et l'annulation du lot.

## Qualification du 14 octobre 2026

- Compilation stricte et inventaire de 1 507 routes : passés.
- Tests ciblés : 31 assertions, dont permissions HTTP, répétition HTTP et inversion malgré un changement de comptes.
- PostgreSQL 17, schéma copié de Test sans données métier, sous rôle `cerp_app` : application, réapplication, retour arrière à vide et refus après preuves enregistrées passés.
- Commandes réelles du repository : deux corrections de 60 €, deux répétitions identiques et deux autres corrections refusées. Une correction restaure 60 € remboursables ; les remboursements de remplacement peuvent les utiliser.
- Export déjà généré : comptes, journal et axes d'origine inversés malgré une nouvelle version de paramétrage. Libération directe et annulation de l'export original refusées.
- Original non exporté : remboursement et correction exportés ensemble avec solde nul par compte. Après remboursement final de remplacement, les soldes bancaires, client, acomptes et TVA de la fixture sont tous nuls. Les quatre faits de remboursement originaux sont conservés ; le total économique reste 120 €.
- Les états fiscaux d'émission initiaux des factures et avoirs sont explicitement simulés par la fixture. Aucun mouvement bancaire externe, GED réelle ou parcours utilisateur complet n'est revendiqué.

Le lecteur d'historique `GET /paiements/workflow/refunds?avoir_id=…` conserve les faits originaux et leur correction, sous permission d'affectation Finance. Les filtres sont typés et stricts. Treize tests HTTP et compilation1 508routes passent ; le lecteur réel sous rôle applicatif retrouve trois remboursements dont deux corrigés dans la fixture. Le panneau lié à la fiche avoir est développé dans le lot frontend1571 : solde proposé, format français, confirmation explicite, correction du seul original sélectionné et reprise réseau avec même clé.

La qualification couvre le moteur et l'export. Les reprises historiques, la contrepassation des encaissements, le déploiement et la recette Finance/GED normale restent à terminer. Le panneau web et le moteur natif sont qualifiés séparément ; leur exercice réel ensemble après publication n'est pas encore revendiqué.
