# Catalogue de visibilité des modules

Le contrôle de visibilité par compte repose sur `public.app_modules` et
`public.app_module_user_access`. Il ne remplace pas les autorisations métier :
les routes concernées gardent leurs contrôles RBAC propres.

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
