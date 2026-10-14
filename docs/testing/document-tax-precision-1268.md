# Ventilation documentaire et prix financiers exacts — 14 octobre 2026

Une facture de 100 € HT à 20 % et 100 € HT à 5,5 %, avec remise globale de 5 %, conserve 190 € HT / 24,23 € TVA / 214,23 € TTC. Le PDF, le modèle SUPER PDP et l'export comptable utilisent les mêmes bases de 95 € et taxes de 19 € / 5,23 €. L'allowance documentaire reste distincte des prix/remises de ligne et des acomptes ; aucun encaissement supplémentaire n'est créé.

Le modèle est figé dans le snapshot lors de l'émission, avec calcul exact en centimes/entiers et répartition des restes. Les documents antérieurs sans ce modèle dérivent uniquement de leurs faits conservés. Leur TVA arrondie par catégorie reste inchangée en l'absence de remise documentaire ; un modèle présent mais contradictoire est bloqué. Les contrats des champs sont ceux de [SUPER PDP](https://www.superpdp.tech/openapi/), avec somme des taxes par catégorie [BR-CO-14](https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-tc434/BR-CO-14/) et tolérance de catégorie [BR-S-09](https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-tc434/BR-S-09/).

## Défaut de stockage reproduit

Le véritable schéma Test conserve encore les prix des lignes facture/avoir en numeric(12,2), alors que le calcul fiscal accepte quatre décimales : 0,025 devient 0,03 lors de l'INSERT. Une première qualification native a échoué sur cette différence. Le patch `20261014_finance_line_precision_1268.sql` élargit prix, remise de ligne et taux à quatre décimales sur les deux tables, atomiquement, sans recalcul de prix historiques ni de totaux. Preflight et verify accompagnent le patch ; rollback protégé et refusé si des valeurs plus précises ou trop grandes seraient perdues. Des vues dépendantes ou triggers conditionnels non prévus bloquent le préflight.

La lecture des brouillons PDF utilise des chaînes décimales SQL exactes dans une transaction de lecture répétable : devises, remises et échéanciers multiples sont conservés. Elle refuse la régénération d'un document émis, y compris les anciens états. Pour la facture électronique, les lignes figées de l'émission font autorité quand elles existent, même si une ancienne colonne avait arrondi le prix. Une liste figée invalide ne provoque pas un repli silencieux vers les lignes actuelles.

## Qualification

- Build strict : 1 495 opérations API, 1 406 sources runtime/émises.
- 7 894 tests / 711 fichiers passent ; 254 tests / 31 fichiers restent ignorés par la suite existante.
- PostgreSQL 17 isolé : schéma Test seul, aucune donnée métier copiée, rôles/permissions conservés. Application/rejeu/vérification/rollback vide et refus de perte de précision passent. Prix facture 0,0250, prix avoir 0,0255, remise 1,2345 % et TVA 20,1250 % restent exacts. Le lecteur de facture émise retient le prix figé 0,0250 face à une ligne historique simulée à 0,0300.
- Repositories comptables réels : création mapping fictif, aperçu, validation, génération, téléchargement, checksum, rejeu idempotent et refus de réexport. Cinq écritures équilibrées à 214,23 €, bases/remise exactes. Les factures sont des fixtures fiscales de stockage, pas des émissions normales ; aucun appel PDP/import comptable externe ni recette UI revendiqué.
- Le premier essai de la fixture émise manquait ses champs réglementaires liés au catalogue BT-23 : contrainte conservée, jeu isolé corrigé puis qualification rejouée. Aucun contrôle de production relâché.

Preuves : `proforma1268-fiscal-tax-{build,full-tests,schema}.log`, `proforma1268-fiscal-tax-schema-proof.json`, `recette-20261009/evidence/proforma1268-fiscal-tax-repository.log`, dans le dossier d'audit local. Sauvegarde complète vérifiée et dumps Test/Prod du 14 octobre à 03:13:02 UTC relus sur VPS avant la qualification. La base temporaire est supprimée après l'essai ; aucune BDD live changée.

## Encore ouvert avant livraison

Comptabilité des acomptes/exigibilité de TVA et lettrage final sans double revenu/taxe, avoir partiel reprenant la remise globale originale, reprise/annulation des brouillons, forfait urgent entre sociétés, interface guidée et classement GED réel. Le PR #1319 reste en brouillon, sans merge dev/main ni déploiement Test/Prod de ce lot. Les 12 scénarios complets et les tests natifs/impressions restent en cours ; les validations unitaires/isolées ne les clôturent pas.
