# Promotion #798 — dev et main

Date : 2026-08-16  
Opérateur : Codex pour Keenan Martin  
Périmètre : sécurisation du réglage administratif du magasin ERP

## Résultat

- branche source : `fix/798-responsive-release` ;
- commit applicatif : `b05862b08d351d333dd2392b76c63383c0a6f592` ;
- `origin/dev` promue par fast-forward ;
- `origin/main` promue par fast-forward ;
- worktrees locaux `dev` et `main` avancés par `git merge --ff-only` ;
- aucun historique réécrit et aucun changement local supprimé.

## Vérifications déjà exécutées

- suite Vitest backend complète : réussie ;
- build TypeScript : réussi ;
- inventaire OpenAPI : 1 074 opérations, couverture 100 % ;
- tests négatifs RBAC, validation et idempotence du réglage : réussis.

## Décision SQL

La comparaison entre le parent de release
`b53cc8284c71c16dbec9e320a87ca1206ccd5376` et le commit promu ne contient
aucun fichier sous `db/patches` ou `db/seeds`. L'arbre Git `db/patches`
porte le même identifiant avant et après :
`e4df89ceb7a2efb21a0e8b5059e26af746492035`.

Il n'existe donc aucun patch à appliquer à `cerp_test` ou `cerp_prod`.
Aucune écriture de base n'a été réalisée, conformément à la règle qui interdit
une migration sans changement versionné.

Le contrôle distant a été effectué en lecture seule depuis le backend Coolify,
sans exposer `DATABASE_URL` :

- PostgreSQL 17.10 sur les deux cibles ;
- `erp_settings` et ses colonnes de provenance/audit présentes sur les deux ;
- `cerp_prod` : 165 patches, soit exactement l'inventaire de `main` ;
- `cerp_test` : les mêmes 165 patches plus
  `20260731_ged_fiches_360.sql` ;
- aucun checksum divergent entre les deux registres.

Le patch supplémentaire de test est un ancien patch expérimental absent de la
branche officielle. Le pousser sur `cerp_prod` sans son code et son dossier de
release créerait une dérive : il est donc explicitement laissé hors production.

## Déploiements observés

- Coolify a construit et démarré l'image
  `b05862b08d351d333dd2392b76c63383c0a6f592` ;
- `/health/live` et `/health/ready` répondent 200 ;
- la version exposée est le SHA attendu ;
- base, GED, antivirus et temps réel sont tous mesurés `up` ;
- l'API HYPERBOX2 répond, mais son déploiement n'a pas pu être actualisé :
  le port SSH 22 est injoignable et l'ERP local sert encore l'ancien frontend.

## Retour arrière

Revenir par un commit `git revert b05862b08d351d333dd2392b76c63383c0a6f592`,
valider les tests, puis repromouvoir. Aucun rollback SQL n'est requis.

## Reste après promotion Git

- déployer le backend et le frontend promus sur HYPERBOX2, puis vérifier les
  healthchecks locaux et le SHA ;
- qualifier le connecteur SUPER PDP contre le véritable bac à sable.
