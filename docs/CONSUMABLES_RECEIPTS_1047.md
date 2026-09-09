# Consommables, approvisionnement et réceptions — #1047

Suivi : issue `BigFootLime/crp-systems-web#1047`, Project Office CERP `WP-256`.
Branche des trois dépôts : `feature/1047-consumables-receipts`. Aucun déploiement de production.

## Contrat métier

- `article_category_link` porte la catégorie `consommable`. `articles.internal_reference` est la référence CRP, distincte du code généré. Les conditions et le fournisseur préféré utilisent `fournisseur_catalogue` et `article_procurement_profile`.
- `stock_managed=false` signifie hors stock ; sinon `consumption_mode=UNIT` ou `GLOBAL_PACK`. Le minimum et le conditionnement explicites du fournisseur remplacent les valeurs par défaut. La quantité arrondie achetée ne modifie jamais la quantité du besoin.
- La définition des besoins vient de `ordres_fabrication.technical_snapshot.preparation_evidence.purchases`, conservé immuable. `of_material_needs` conserve article, unité, politique, référence du besoin, version technique, hash et `of_revision_id`. Une nouvelle révision active demande un rapprochement explicite des anciens engagements, même si la version de pièce technique est inchangée.
- `stock_reservations`, `stock_levels`, `stock_movements`, `lots` et les allocations de commande restent les registres autoritaires. Le journal `consumable_commands` conserve clés, empreintes et résultats transactionnels. Aucun stock parallèle.
- Le prélèvement scanné consomme la réservation et poste sa sortie dans une même transaction. Le parcours matière ne redébite pas les consommables. Les sorties partielles sont toutes protégées contre une compensation isolée qui laisserait la couverture de l’OF incohérente.
- Une palette est un lot interne distinct marqué `is_consumable_pack`. Sa disponibilité est partagée ; sa clôture exige le scan exact, le reliquat relu et une confirmation. Le réapprovisionnement anticipé ne poste pas de sortie.
- La réception groupée a les étapes `DRAFT` et `CONFIRMED`. Un BL enregistré, de taille et d’empreinte vérifiées, est obligatoire. Le document, les lignes, liens, statuts et entrées directes sont confirmés ensemble. Les fichiers préparatoires et journaux sont conservés pour reprise.
- Réception physique, acceptation, mise en stock et reliquat attendu sont distincts. La qualité conserve ses décisions et son entrée de stock autorisée ; aucune réception soumise au contrôle n’est rendue disponible avant libération. Les surplus hors stock sont calculés depuis les intervalles reçus et affectés, sans solde magasin fictif.

## API

Points d’entrée web : `/stock/consumables/:id/supply`, résolution des scans consommables dans Stock, commandes de préparation/prélèvement/rapprochement dans Production, lignes attendues et réception groupée dans Réceptions. Le filtre article `business_category=consommable` distingue la catégorie métier de la catégorie primaire `achat`. Voir les routes de ces modules et l’inventaire OpenAPI généré.

Les applications utilisent exclusivement les routes explicites `/terminals/reception/*`, `/terminals/procurement/*` et `/terminals/logistics/*`. Appareil appairé et session PIN personnelle sont requis ensemble. Les autorisations sont résolues dans chaque module ; changer le type d’appareil ne donne aucun droit supplémentaire. Aucun jeton de terminal ne donne accès à l’administration web.

Le terminal est rattaché à un site et éventuellement à un magasin ; le magasin est une destination proposée. Le modèle stock existant n’offre pas de cloisonnement géographique complet des magasins par site : ne pas présenter cette valeur comme un nouveau périmètre RBAC.

## Migrations et exploitation

Préparer une sauvegarde puis exécuter chaque `support/*.preflight.sql`, le patch correspondant avec `node scripts/db-patches.js up --only NOM_DU_PATCH.sql`, puis son `verify.sql`. Les huit empreintes LF sont enregistrées dans le runner : il conserve le verrou global, le contrôle de l’inventaire et le journal transactionnel. Ne pas relancer en production les scripts QA ni un `up` global non sélectionné. Ordre :

1. `20260909_consumables.sql`
2. `20260909_consumable_procurement.sql`
3. `20260909_grouped_supplier_receipts.sql`
4. `20260909_consumable_need_reservations.sql`
5. Socle Android #1038 : `20260908_android_terminals_1038.sql`, puis `20260908_android_automatic_time_1038.sql` si absents.
6. `20260909_supply_terminals.sql`
7. `20260909_consumable_of_revision.sql`

Les précontrôles et procédures de récupération accompagnent les nouveaux patches. Après des écritures, privilégier une correction additive et conserver les journaux. Ne pas supprimer les allocations, réceptions, décisions qualité ou mouvements pour revenir en arrière.

Le socle Android provient du travail #1038 (backend `f90a09a`, web `3f37e948`, mobile basé sur `444169e`). Il fait partie des prérequis de cette branche. Activer les terminaux avec la configuration #1038, un secret PIN administré et une URL web HTTPS ; le PIN est défini par son propriétaire depuis le compte web. Les secrets ne figurent pas dans ce document.

Les imports BL passent par le traitement antivirus existant. La recette doit utiliser le même contrôle ; aucun mode de contournement n’a été ajouté.

## Preuves au 9 septembre 2026

- Compilation serveur, contrat OpenAPI : 1 296 opérations, couverture 100 %.
- Suite ciblée : 342 tests serveur réussis, 14 tests d’intégration historiques conditionnels ignorés.
- `scripts/qa/consumables-transaction-smoke.ts` : 16 scénarios réussis sur `cerp_test`, référence `QA1047-1788978643975`. Concurrence, arrondis, deux palettes, sorties partielles et répétées, affectations, surplus, réception 60/40 et plusieurs commandes/BL, blocage qualité, révisions et surplus de report.
- La recette transactionnelle utilise des BL **fictifs** attachés au dépôt pour vérifier les transactions et leur intégrité ; elle ne constitue pas une preuve de réussite de l’upload HTTP avec antivirus.
- `scripts/qa/consumables-terminal-http.mjs` : 9 contrôles HTTP réussis, deux types d’appareil, même PIN, droits, révocation, verrouillage et limitation des essais.
- Recette navigateur réussie : création du consommable `ART-CONS-001142` et du fournisseur fictif dans la fiche, conservation de la référence CRP et des conditions, prix inconnu conservé, réapprovisionnement de 120 arrondi à 200 dans le brouillon `BCF-2026-1143`, sans mouvement de sortie. Identifiants uniquement dans `cerp_test`.
- Web : 107 tests ciblés réussis sur 9 fichiers, dont création article, fiche détail, réception, nomenclature et schémas de commande ; 51 fichiers TypeScript modifiés contrôlés par ESLint.
- Les scripts QA exigent un opt-in `1047`, n’utilisent que `cerp_test` et ne déclenchent aucun envoi fournisseur. Les jeux `QA1047` sont identifiables et conservés.

## Validation encore requise

Le blocage antivirus de la recette a été résolu le 9 septembre en exécutant le runtime isolé sous le compte de service `cerp`, membre du groupe ClamAV. Aucun contrôle antivirus n’a été désactivé. Les imports HTTP de BL ont reçu un verdict CLEAN ; les réceptions successives de 60 puis 40, le hors stock et le rejeu idempotent ont réussi sur `cerp_test` (`BCF-2026-1026`). Une sur-réception sans autorisation a été refusée.

Le parcours qualité HTTP a également réussi : entrée de stock refusée avant libération, mesures conformes, refus de l’auto-libération par l’auteur du contrôle, libération par un second compte fictif autorisé, puis entrée de 100 unités (`CQ-2026-001148`, mouvement `SM-00000589`). Ces identifiants appartiennent uniquement à la base de test. Les comptes fictifs sont désactivés après les essais.

Le contrat OpenAPI vérifie explicitement les deux protections cumulatives des routes Android : secret d’appareil et session personnelle. Les routes de bootstrap ne requièrent que l’appareil ; elles ne sont pas déclarées publiques. Sur un runner Linux exécuté comme root, fournir un `TMPDIR` privé à 0700 : la protection documentaire refuse à juste titre un ancêtre appartenant au service et accessible en écriture à tous, tel que `/tmp` dans cette configuration.

Les APK et essais sur émulateur ne remplacent pas la recette sur tablette, caméra et scannette physiques. Le chantier reste en cours jusqu’à ces validations.
