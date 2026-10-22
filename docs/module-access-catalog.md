# Catalogue de visibilité des modules

Le contrôle d'accès par compte repose sur `public.app_modules` et
`public.app_module_user_access`.

## Politique actuelle — revue du 20 octobre 2026

Le code livré applique un **refus par défaut** par compte et par module.
La fonction `decide()` de `access-control.service.ts` est la référence :

- le SuperAdmin conserve l'accès complet ;
- un module protégé reste réservé au SuperAdmin ;
- un module inactif est refusé aux autres comptes ;
- `GRANTED` autorise explicitement un module actif non protégé ;
- `DENIED` le refuse ;
- l'absence de décision et `INHERIT` ne donnent aucun accès ;
- un nouveau module n'est donc pas ouvert automatiquement aux comptes existants.

Les intitulés de rôle restent descriptifs. Les capacités sensibles et la MFA
restent des contrôles distincts : ouvrir un module ne confère pas par lui-même
une capacité d'administration, un accès RH sensible ou le journal global.
La visibilité du menu suit le profil d'accès ; les routes serveur restent
autoritaires, y compris lorsqu'un utilisateur dispose d'un lien direct.

L'assistant de reprise `/data-cutover` applique en plus ses attributions
explicites par lot et domaine. Un contributeur ne devient pas administrateur et
ne reçoit ni les données financières, ni le droit de valider ou charger le lot.

Ne pas réexécuter une ancienne migration d'ouverture générale pour réparer une
fiche utilisateur. Toute modification de droits passe par la gestion nominative
actuelle, sa MFA et son audit.

## Historique #262 — remplacé pour la décision d'accès

Les paragraphes historiques ci-dessous décrivent l'ancienne politique de
juillet. Ils ne doivent plus servir de procédure de paramétrage ou de modèle
de sécurité pour un nouveau module.

Depuis le 30 juillet 2026, les rôles sont descriptifs et ne portent plus
d'autorisation :

- tout module actif est ouvert par défaut à tout compte authentifié ;
- seule une ligne `DENIED` pour un couple compte × module ferme l'accès ;
- `INHERIT` signifie ouvert et supprime l'override ;
- un ancien `GRANTED` est normalisé en `INHERIT` ;
- le défaut global ne peut plus être fermé ;
- les capacités historiques basées sur le rôle sont traversées après
  autorisation du module ;
- les invariants métier qui ne dépendent pas du rôle restent appliqués ;
- les API `/admin/access` sont réservées au statut `is_superadmin`, attribué
  uniquement au compte KEENAN.

Le middleware global porte la décision autorisée dans un contexte asynchrone
jusqu'aux politiques profondes. L'identité, le rôle descriptif et les données
d'audit ne sont pas modifiés. Un `DENIED` est refusé avant la route.
Ce contexte est ouvert dès l'entrée dans `/api/v1`, puis marqué comme accordé
par le gate : il reste ainsi disponible dans les routeurs imbriqués, les
middlewares asynchrones et les services profonds. Les surfaces partagées
authentifiées qui ne correspondent à aucun module (par exemple les réponses de
capacités UI) reçoivent également ce contexte ; elles ne recréent jamais une
autorisation par rôle.
La décision est aussi inscrite sur l'objet `Request` Express. Les gardes HTTP
lisent cette preuve en priorité : des appels parallèles du dashboard ne peuvent
donc ni perdre ni échanger leur autorisation asynchrone. L'AsyncLocalStorage
reste utilisé par les règles profondes qui ne reçoivent pas la requête.
L'identifiant du compte est normalisé lorsqu'un ancien jeton JWT le fournit
sous forme de chaîne numérique, afin que la décision nominative reste
autoritaire. Le kill-switch d'exploitation désactive uniquement les refus
nominatifs : il conserve ce contexte d'autorisation et ne réactive donc jamais
les anciens refus fondés sur le rôle.

Le patch `20260730_account_module_access_262.sql` ouvre et active le catalogue,
journalise les anciens overrides avant de les retirer et garantit l'unicité du
superadmin KEENAN. Préflight et vérification sont obligatoires sur `cerp_test`
avant `cerp_prod`.

## Contrat `access-profile` v1

`GET /api/v1/auth/access-profile` exige un JWT valide et répond pour tout compte
authentifié. La réponse canonique contient `contract_version: 1`,
`cache_ttl_seconds`, `is_superadmin` et la liste `modules`. Chaque module porte
`module_key`, `label`, `nav_page_keys`, `allowed` et `source`. Le frontend peut
masquer une entrée à partir de ce profil, mais cette visibilité ne remplace
jamais le gate serveur : un accès direct explicitement refusé reste un `403`.

Le cache serveur converge au plus tard dans le délai annoncé par
`cache_ttl_seconds` et les mutations locales l'invalident immédiatement. Pendant
un déploiement progressif, un frontend récent accepte l'ancienne réponse sans
métadonnées et utilise dix secondes par défaut ; un frontend ancien ignore les
deux champs additifs.

Ordre de déploiement : backend, tests `401/403/200` sur `cerp_test`, puis
frontend. Le rollback applicatif consiste à remettre le frontend précédent puis
le backend précédent ; aucun rollback SQL n'est requis pour ces deux champs de
réponse additifs. Les restrictions en base et leurs journaux ne sont jamais
supprimés par ce rollback.

## Réparation #402

Le patch `20260730_repair_module_catalog_visibility_402.sql` remet le catalogue
persistant en cohérence avec le catalogue TypeScript :

- les espaces **Pièces techniques**, **Bibliothèque de finitions**,
  **Méthodes — Centres de frais** et **Méthodes — Parc machine** sont quatre
  modules séparés dans la matrice. Un administrateur peut donc attribuer ou
  refuser chacun d'eux indépendamment ;
- la **Gestion documentaire** (`/ged`) devient un module distinct, actif par
  défaut lorsqu'il est créé et non protégé ;
- les choix déjà réalisés en exploitation (`enabled_by_default`, `is_active` et
  les overrides nominatives) sont préservés. Au premier découpage, les trois
  nouveaux modules Méthodes/Finitions héritent du défaut et de l'état actif de
  `pieces-techniques`; un override nominatif historique est recopié seulement
  si aucun override plus précis n'existe déjà.

Les routes partagées de diagnostic de Méthodes restent hors de ce découpage ;
elles ne donnent ni lecture métier ni droit d'écriture. Les routes de chaque
espace, et leurs capacités métier propres, restent contrôlées par le backend.

## Ordre de livraison

Le catalogue TypeScript résout aussi les routes API. Le déploiement backend et
le patch SQL doivent donc être appliqués dans une même fenêtre de maintenance :
ne laissez jamais une version de code antérieure tourner entre le découpage SQL
et le redémarrage de l'API. La recette démarre sur `cerp_test`, puis passe sur
`cerp_prod` après sauvegarde et validation explicite.

Le préflight et le verify se trouvent dans `db/patches/support/`. Ils doivent
être exécutés sur `cerp_test` avant toute décision de déploiement. Le patch ne
modifie aucune donnée métier, aucun compte et aucun flag du pilote Project
Office ; son rollout utilisateur reste une décision séparée et contrôlée.
