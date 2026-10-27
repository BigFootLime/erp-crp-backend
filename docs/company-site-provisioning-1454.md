# Plan de provisionnement d'un site EC — #1454

> **Statut : préparation uniquement.** Ce document n'autorise ni migration, ni création de base, ni changement de service, proxy, NAS/GED ou secret. Une fenêtre séparée doit commencer seulement après gel SQL explicite et accord de l'opérateur responsable.

> **Décision utilisateur du 27 octobre 2026 :** NIZIER et LAMBERT sont prévus mais différés. Ne créer, réactiver ni activer aucun compte, profil Directory ou accès pour eux dans cette fenêtre. Conserver leurs anciens comptes locaux.

Ce plan crée une entreprise commerciale EC physiquement et logiquement séparée de CRP. Il est destiné à la candidate `backend-integration-2.0.29`, à reprendre sur le SHA de livraison effectivement retenu. Il ne doit jamais être exécuté depuis une recette locale ou en remplaçant des variables par des valeurs de démonstration.

## État constaté à recouper avant la fenêtre

Les éléments suivants sont des faits d'exploitation communiqués pour préparer la fenêtre, pas des garanties réutilisables sans lecture fraîche :

| Sujet | État attendu au préflight |
| --- | --- |
| Versions actuellement publiées | Production `2.0.29`; baselines `main` backend `870c7ed07`, frontend `3be3fe7a`. |
| Bases métier existantes | `cerp_prod`, `cerp_test`, et template `cerp_test_template_204_139385585b8a`. |
| Annuaire privé | `cerp_directory_ae73e92347374b41ab71bab15c3f324a`. |
| Drapeaux actuels | Directory partagé actif sur production/test/public; `CERP_BUSINESS_COMPANIES_ENABLED=false`. |
| Registre entreprise | Aucune table `cerp_business_%` à ce relevé; les projections Directory côté entreprise sont déjà présentes. |
| Nouveau SQL attendu | Les correctifs additifs de lignes commerciales et leurs gardes doivent être présents dans le candidat gelé, avec inventaire final qualifié avant toute étape de production. |

Un écart sur une ligne bloque la fenêtre : il faut mettre à jour ce plan et refaire les préflights, plutôt que d'adapter une commande sur l'hôte.

## Variables à décider et à consigner hors Git

L'opérateur renseigne les valeurs suivantes dans un ticket de changement et le coffre de secrets. Aucune ne doit figurer dans le dépôt, un log, une commande historisée ou la base comme substitut d'un secret.

| Variable | Décision requise |
| --- | --- |
| `EC_COMPANY_ID` | UUID canonique nouveau, réservé une fois pour l'entreprise EC. |
| `EC_CODE`, `EC_NAME` | Code et raison sociale affichée, approuvés par le métier. |
| `EC_PROFILE` | `COMMERCIAL`; aucun profil industriel implicite. |
| `EC_PROD_DB`, `EC_TEST_DB` | Respectivement `cerp_company_<uuid-sans-tirets>_prod` et `cerp_company_<uuid-sans-tirets>_test`. |
| `EC_PROD_SITE_ID`, `EC_TEST_SITE_ID` | Identifiants Directory distincts des noms de bases; créés/confirmés par Directory. |
| `EC_PROD_ORIGIN`, `EC_TEST_ORIGIN` | Origines fixes privées approuvées. Le manifeste n'accepte que `127.0.0.1` ou l'adresse WireGuard autorisée, avec ports distincts. |
| `EC_DIRECTORY_CALL_KEY`, `EC_DIRECTORY_ID` | Référence de coffre et identifiant d'autorité; clés nouvelles, générées pour EC, jamais dans PostgreSQL. |
| `EC_DB_ROLE_SECRET`, `EC_GED_ROOT`, `EC_GED_TENANT` | Références de coffre et chemins/tenant GED dédiés. Ne pas partager un secret applicatif avec CRP. |
| `EC_ISSUER_*` | Identité légale, mentions, séquences et paramètres de facturation EC. Le vrai SIRET est en attente. L'utilisateur autorise une valeur provisoire de démonstration dans le paramétrage, clairement identifiée et modifiable; elle ne constitue pas un identifiant légal confirmé. |
| `EC_OWNER_PROFILE_ID`, `EC_MEMBER_PROFILE_IDS` | Profils Directory explicitement sélectionnés, avec modules et capacités fermés par défaut. |
| `CHANGE_ID`, `BACKUP_RECEIPT`, `ROLLBACK_OWNER` | Référence de changement, preuve de sauvegarde/restauration et responsable autorisé à interrompre/revenir en arrière. |

Les DSN administrateur, mots de passe, clés HMAC, JWT, GED et certificats ne sont indiqués que par des références de coffre à accès minimal.

## Préconditions bloquantes

1. Geler le SHA backend et frontend, incluant les correctifs de lignes commerciales; produire l'inventaire `filename:sha256` et la sortie `status --check` pour les bases existantes concernées. Ne jamais modifier un checksum ni fabriquer un ledger.
2. Obtenir un point de restauration testé pour `cerp_prod`, `cerp_test`, le template et l'annuaire privé, avec conservation des preuves et des journaux d'audit. Ce plan n'autorise pas un reset ou une recréation de ces bases.
3. Vérifier en lecture seule que les migrations Directory de société ne sont pas déjà partiellement installées et que les projections locales annoncées sont présentes. L'absence actuelle de `cerp_business_%` signifie que le script Directory dédié doit être exécuté dans une fenêtre contrôlée; elle ne permet aucun `up` global.
4. Confirmer les droits d'administration, la MFA récente du propriétaire central, le rôle applicatif, le chemin GED, l'antivirus et le stockage de sauvegarde. Préparer les unités de service EC sans les démarrer.
5. Recenser les objets documentaires et blobs existants. L'alias `documents/legacy-import` vers `metrologie/legacy-import`, ses objets GED et ses blobs restent inchangés : pas de déplacement, renommage, déduplication, purge ou rattachement à EC dans cette fenêtre.
6. Réserver les origines, ports et règles de proxy sans collision. Le générateur de proxy sera exécuté sur un manifeste privé, inspecté, puis seulement inclus à l'emplacement approuvé avant les règles legacy. Aucun proxy actif n'est modifié pendant le préflight.

## Exécution proposée, après feu vert explicite

Chaque étape a un reçu horodaté, l'identité de l'opérateur et un contrôle de sortie. À la première erreur, arrêter la phase courante sans compenser par SQL manuel.

### 1. Préflight et sauvegarde

- Consigner les versions effectives, hashes de sources, services en cours, inventaires de bases, tables Directory, routes proxy et paramètres sans en afficher les valeurs sensibles.
- Réaliser la sauvegarde approuvée et tester la restauration dans un espace isolé. Enregistrer `BACKUP_RECEIPT` avant une mutation.
- Lancer les préflights en lecture seule appropriés : `db/shared-directory/20261026_business_companies_1454.preflight.sql` sur `EC_DIRECTORY_DB`, puis les préflights du site seulement après création de la base opaque. Les gardes de nom doivent refuser toute base CRP classique.

### 2. Préparer le registre Directory, sans rendre EC accessible

- Sur l'annuaire privé seulement, appliquer `db/shared-directory/20261026_business_companies_1454.sql` avec son compte de migration contrôlé, puis son `verify.sql`.
- Confirmer que les tables de registre restent privées à `cerp_directory_app`; `cerp_app` ne reçoit aucun droit sur elles.
- Créer via l'API/administration Directory authentifiée l'objet société EC en état inactif, avec `EC_COMPANY_ID`, `EC_CODE`, `EC_NAME`, `COMMERCIAL` et des modules/capacités explicitement limités. La création doit produire une trace d'audit. Ne pas insérer directement des lignes pour contourner les versions, verrous ou audits.
- Enregistrer également l'entreprise CRP et ses instances historiques avec un UUID canonique propre et le profil `INDUSTRIAL`. Conserver leurs bases physiques `cerp_prod`/`cerp_test`, utilisateurs, documents et paramètres existants. Les projections Directory déjà installées doivent être vérifiées; la fondation opaque EC n'est pas à exécuter sur ces bases historiques.

### 3. Créer les sites physiques opaques

- Créer `EC_TEST_DB` d'abord, depuis le template qualifié approuvé; ne jamais cloner `cerp_prod`, importer des données métier CRP, ni copier son ledger.
- Vérifier le nom opaque, le propriétaire, le rôle `cerp_app`, le schéma attendu, les tables `users` et `operator_device_sessions`, ainsi que l'absence de données métier non autorisées.
- Exécuter, sur cette seule base, dans cet ordre :

  ```text
  db/company-sites/20261026_company_directory_sites_1454.preflight.sql
  db/company-sites/20261026_company_directory_sites_1454.sql
  db/company-sites/20261026_company_directory_sites_1454.verify.sql
  ```

  Cette fondation est hors du runner métier automatique. Les patches applicatifs additionnels doivent être uniquement ceux prescrits par le template et le SHA gelé; aucun `db-patches up` global ne sert de raccourci.
- Créer `EC_PROD_DB` avec le même procédé après recette test signée, jamais par promotion de données de `EC_TEST_DB`. Refaire les trois contrôles et conserver les inventaires séparés.

### 4. Enregistrer instances, identités et accès

- Déclarer les instances test puis production dans Directory avec les couples stricts `(EC_COMPANY_ID, cerp_test|cerp_prod, EC_*_SITE_ID)`, d'abord inactifs. Une déclaration prépare le raccordement; elle ne crée pas la base.
- Renseigner dans chaque site l'identité EC, la politique et les séquences locales. La valeur de SIRET provisoire demandée par l'utilisateur doit rester identifiable comme démonstration dans le paramétrage, et son remplacement par la valeur officielle doit être suivi sans la présenter comme confirmée.
- Générer des secrets propres pour chaque runtime et GED, les déposer dans le coffre puis injecter uniquement leurs références dans les unités de service. Ne pas mettre une clé Directory, un blob ou un secret dans le registre métier.
- Ajouter les memberships via l'administration Directory avec un profil réel, un statut actif explicite, une liste de modules minimale et les capacités de projection commerciale nécessaires. Un nom ne donne jamais un accès.

L'utilisateur a déjà demandé l'accès aux deux entreprises pour les sept personnes
ci-dessous. Ne pas redemander cette préférence; vérifier les identifiants et
réaliser les memberships explicites au cours de la fenêtre autorisée.

| Profil/situation | Décision opérationnelle |
| --- | --- |
| Ghislaine | Profil Directory identifié dans le reçu privé; accès CRP/EC test et production demandé; approbatrice des demandes CRP. |
| Thomas | Profil Directory identifié dans le reçu privé; accès CRP/EC test et production demandé. |
| Clément | Profil Directory identifié dans le reçu privé; accès CRP/EC test et production demandé. |
| Keenan | SuperAdmin confirmé par l'utilisateur : accès aux deux entreprises et à tous leurs paramètres. Créer les memberships entreprise explicites et actives, puis configurer explicitement le rôle SuperAdmin des sites EC via l'administration Directory auditée. Vérifier et conserver les droits CRP; les opérations sensibles gardent leurs contrôles de session et de MFA. |
| Jean-Marie | Profil Directory actif, présent uniquement en test au relevé. L'accès demandé aux deux entreprises en production nécessite une membership/projection explicite supplémentaire, sans réutiliser un ancien ID local par nom. |
| NIZIER et LAMBERT | Anciens comptes locaux inactifs, sans profil Directory : laisser en attente conformément à la décision utilisateur. Aucun compte, profil ou membership de substitution à créer, réactiver ou activer dans cette fenêtre. |
| Tout autre accès | Choisir un profil Directory réel avec l'approbation du propriétaire et des modules/capacités explicites. Aucun mapping automatique par nom, e-mail ou ancien `users.id`. |

### 5. Déployer les runtimes et le routage

- Construire les deux configurations de runtime fixes avec leur propre pool, base, `CERP_COMPANY_ID`, environnement (`cerp_test`/`cerp_prod`), Directory partagé et clé de site. Un processus ne change jamais de base selon un header.
- Avant la bascule, le flag entreprises reste désactivé sur les services CRP historiques. La mise en service complète exige ensuite son activation explicite sur les runtimes fixes **CRP et EC**, avec leur UUID/environnement et leur politique Directory respectifs; sinon le basculement et la réception interentreprises CRP ne sont pas disponibles. La configuration `workers=off` ou `workers=leader` est décidée par site, sans worker implicite.
- Générer le fragment avec `scripts/entreprises/render-company-proxy.mjs` depuis un manifeste privé qui contient les deux destinations fixes. Examiner le diff; installer le fragment avant les catch-all legacy puis valider la configuration du proxy. Les couples inconnus et les mauvais environnements doivent répondre 403, jamais tomber sur CRP.
- Démarrer test, vérifier le boot (base/UUID/Directory), l'accès direct et la projection de politique signée. Activer l'instance test seulement après ces preuves. Répéter la séquence production pendant sa fenêtre dédiée.

### 6. Recette de mise en service et décision

- Vérifier connexion, MFA, sélection d'entreprise, ticket de bascule, refus d'un bearer ou d'un header d'une autre société, modules commerciaux autorisés et refus des capacités industrielles.
- Vérifier en environnement test création d'un particulier, identité EC, GED tenant EC, livraison/facturation et journal d'audit avec données synthétiques. Ne pas créer de fausses pièces fiscales en production pour un smoke test. Vérifier qu'aucun mouvement, utilisateur ou document historique CRP n'a été réattribué.
- Vérifier une dernière fois les alias et blobs Métrologie existants, notamment `documents/legacy-import` → `metrologie/legacy-import`.
- Faire valider les reçus par `ROLLBACK_OWNER`, puis activer l'instance production et la route correspondante. En l'absence de tous les reçus, garder l'instance inactive.

## Commandes de fenêtre (gabarits, non exécutables tels quels)

Les valeurs sont fournies par l'environnement sécurisé de l'opérateur. Les placeholders ne sont pas des identifiants ni des secrets à inventer.

```powershell
# Lecture seule; échoue si le nom d'annuaire ou de site n'est pas celui attendu.
psql $env:EC_DIRECTORY_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/shared-directory/20261026_business_companies_1454.preflight.sql
psql $env:EC_SITE_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/company-sites/20261026_company_directory_sites_1454.preflight.sql

# Après approbation de la phase et sauvegarde validée seulement.
psql $env:EC_DIRECTORY_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/shared-directory/20261026_business_companies_1454.sql
psql $env:EC_DIRECTORY_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/shared-directory/20261026_business_companies_1454.verify.sql
psql $env:EC_SITE_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/company-sites/20261026_company_directory_sites_1454.sql
psql $env:EC_SITE_ADMIN_DSN -v ON_ERROR_STOP=1 -f db/company-sites/20261026_company_directory_sites_1454.verify.sql

# Génère un fragment à inspecter, sans modifier la configuration active.
node scripts/entreprises/render-company-proxy.mjs --input <manifest-prive.json> --output <workspace>/ec-company-proxy.conf
```

## Retour arrière et limites

Avant l'activation, arrêter les unités EC non publiées, retirer le fragment proxy non activé et révoquer les secrets de site créés, en conservant les journaux. Ne pas supprimer une base, un tenant GED ou une clé tant que la sauvegarde et la décision de rétention n'ont pas été approuvées.

Après création d'une société, d'une membership, d'une instance ou d'une trace d'audit, les rollbacks SQL fournis doivent normalement **refuser** : ils protègent la preuve historique. Dans ce cas, le retour arrière est fonctionnel : désactiver l'instance dans Directory, retirer la route, arrêter le runtime, révoquer les secrets et conserver base, blobs, GED et audit en quarantaine. Une suppression ultérieure requiert une décision de rétention distincte, un reçu de sauvegarde et une procédure approuvée; jamais `DROP DATABASE`, purge GED ou modification de ledger improvisés.

Les bases CRP (`cerp_prod`, `cerp_test`), leur template, l'annuaire existant et les documents/blobs antérieurs restent hors portée du rollback EC.
