# Identité des familles de procédés spéciaux

Issue frontend #1831 ; demande utilisateur du 4 novembre 2026, complétée par l’autorisation de configurer les familles existantes.

Les codes des familles sont attribués par PostgreSQL (`FPS_000001`) et deviennent immuables. `legacy_code` conserve le code antérieur. Le patch ciblé `20261104_special_process_family_identity_1831.sql` recode les familles et conserve leurs rattachements par clé étrangère avec propagation des mises à jour. Aucune finition, révision ou article n’est supprimé.

`nom_diminutif` appartient à la famille. Il est unique parmi les familles actives. La création et la modification de finition résolvent la famille côté serveur et reprennent ce diminutif ; une valeur contradictoire envoyée par un ancien client est refusée. Les codes et désignations d’articles déjà émis restent historiques. Une finition déjà liée à un article ne peut pas être déplacée vers une autre famille.

La création PS exige un choix de famille unique et une finition appartenant à celle-ci ; le serveur contrôle le rattachement. La révision de finition reste scalaire sur chaque article. `PATCH /finitions/familles/:familyCode` configure le référentiel avec la capacité existante `library_draft_write`, contrôle de concurrence et audit.

Configuration initiale autorisée : Anodisation OAS ; Anodisation dure OAD ; Passivation PASS ; Zingage ZN ; Nickelage chimique NICH ; Chromage CHR ; Brunissage BRUN ; Phosphatation PHOS ; Peinture PEINT ; Thermolaquage THERMO ; Cataphorèse CATA ; Préparation mécanique PREP ; Autre AUTRE. Les diminutifs existants non ambigus ont priorité.

Avant application : sauvegarde privée du référentiel, comptages des familles, finitions, révisions et articles, et inventaire des clés étrangères. Appliquer uniquement ce patch et inscrire son empreinte LF dans `cerp_schema_migrations` dans la même transaction. Vérifier le format des codes, les 13 diminutifs, l’absence d’orphelins et la conservation des identifiants et comptages. Le script de retour arrière restaure les codes antérieurs sans effacer les nouveaux champs ni les données saisies après livraison.

Aucune suite de tests n’est exécutée sur instruction utilisateur. Les compilations, contrats, contrôles du référentiel et vérifications d’intégrité de livraison sont consignés séparément dans les preuves de livraison.
