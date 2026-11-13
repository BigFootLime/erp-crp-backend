# Multi-entreprises — intégration sur CERP 2.0.27

Relevé du 27 octobre 2026. Le socle entreprise reste local, incomplet au regard
du flux commercial Esprit Carabine, sans activation ni déploiement. La livraison
Métrologie 2.0.27, distincte, est clôturée dans le
[registre commun](cerp-deployment-coordination-20261026.md).

## Sources intégrées

| Dépôt | Base publiée | Branche locale / résultat source |
|---|---|---|
| Backend | `f796d2e504f2d60417778524ead41ca9a0f596eb` | `feature/1454-company-main-2.0.27`, `b599449e8876fc64a67edc37e34df302c08c33ef` |
| Frontend | `d743bd48fa70de36b200e986043c2498085bd399` | `feature/1775-company-main-2.0.27`, `e89dcb09` |

Worktrees sous `cerp-multi-company-20261026` : `backend-main-2.0.27` et
`frontend-main-2.0.27`. Les anciens `backend` / `frontend` et leurs branches
de fondation sont conservés. Aucune fusion globale de dev, aucun cutover importé.

Backend : contrats `e74dde31`, B2C `3aae2c1f`, primitive native `7d49aab4`,
runtime/Directory/admin `27b5b4c6`, inventaire et fixture B2C adaptés à main
`634d1dec`. Le registreur a revu le diff de la primitive contre main :
extraction du wrapper transactionnel et retour du numéro, corps métier conservé.
Aucune acceptation inter-entreprises n'appelle encore cette primitive.

Frontend : architecture `341911d6`, B2C dans les formulaires existants
`1d343c7a`, interface/contexte communs `f67267e1`, décisions documentées
`50f7b772`, puis fixtures de tickets valides relativement à l'heure du test
`03b4054d`. Le test de ticket expiré est conservé. Les conflits CHANGELOG et
import d'administration conservent les entrées publiées et la gestion des
tablettes. Aucun correctif Notifications déjà publié n'est réappliqué.

## Vérifications locales

- Backend : 112 tests ciblés et 19 tests lifecycle/background réussis ;
  typecheck TypeScript local 5.9.3 et build complet réussis. Quatre fixtures
  PostgreSQL PGlite synthétiques réussies. OpenAPI régénéré : 1 596 opérations,
  couverture déclarée 100 %.
- Frontend : 69 tests ciblés réussis (auth/contexte 14, HTTP/runtime/admin 33,
  B2C/login/onboarding 22). Typecheck explicite
  `node node_modules/typescript/bin/tsc -b --pretty false` et build
  `node node_modules/vite/bin/vite.js build` réussis, codes 0.
- L'échec initial de `pnpm typecheck` n'a pas été reproduit par l'invocation
  explicite locale. `pnpm exec tsc --version` et le binaire local renvoient
  tous deux 5.8.3 : l'hypothèse initiale PATH/shim n'est pas démontrée, cause
  exacte indéterminée. Versions et lock concordent avec le clone qualifié
  (Vite 7.3.7, Vitest 4.1.11), configurations identiques, tsconfig inchangé.
- Le registreur a vérifié par diff contre les bases publiées que Métrologie,
  Outillage, correctif temps réel, lifecycle/background, supervision, Android,
  Electron, dépendances, Dockerfile et patch MD15 restent inchangés dans les
  périmètres concernés. Les douze starters backend publiés sont conservés.

Ces tests ciblés ne constituent pas un gate complet de release. Les anciens
comptes rendus de fondation décrivent leurs anciens SHAs ; leurs nombres ne
sont pas additionnés ici. Aucun test réel à deux services/bases, transport,
restauration métier EC ou nouveau parcours navigateur n'est revendiqué.

## Correctif de portée PIN issu de la relecture indépendante

La relecture a identifié l'absence de validation de cible entreprise sur les
routes publiques PIN, alors que login/MFA la validaient. Backend `2cd7afc5`
ajoute `companyLoginTargetMiddleware` à `/auth/tablet-pin/login` et
`/auth/tablet-pin/pair` : en mode entreprise, contexte absent, UUID altéré et
environnement erroné donnent `403 COMPANY_LOGIN_TARGET_MISMATCH`. La cible
fixe confirmée est acceptée ; le mode legacy reste compatible sans header.
Les endpoints PIN authentifiés passaient déjà par l'enforcement commun.

Frontend `e89dcb09` transmet la cible confirmée de sign-in-context, figée au
submit, aux appels appairage/PIN puis au challenge MFA et à la vérification
de session. Aucun choix depuis un ancien stockage ; un environnement
contradictoire est rejeté avant requête. Une cible expirée n'envoie pas de PIN.

Après correction : 10 tests backend de routes auth et 27 tests frontend
API/login/MFA réussis, typechecks locaux réussis. Les nombres recouvrent des
tests précédents et ne sont pas additionnés aux totaux initiaux. Le registreur
a relancé les deux builds après ce changement : build backend complet réussi
(OpenAPI, compilation et frontière données source/dist), build web réussi
(Vite et frontière données source/dist). Inventaire actualisé dans
`b599449e`, 1 596 opérations, source `135e7e5e79b3`. Warnings tiers Zod et
taille de chunks conservés, aucun masquage de configuration.

Ce correctif local n'a pas été publié sur les services 2.0.27 existants ; le
mode multi-entreprises reste désactivé. La qualification native réelle à deux
entreprises demeure à faire.

## Raccordements indispensables avant fonctionnement EC

1. Le profil commercial ne change pas encore les règles de commande. Les
   articles natifs acceptent `stock_managed=false` et `lot_tracking=false`,
   mais l'éligibilité commande client exige aujourd'hui une pièce fabriquée
   stockée avec PT. Prévoir une exécution par fournisseur résolue côté serveur,
   conservant les règles industrielles CRP et sans stock physique EC.
2. Réutiliser articles/formulaires et catalogue fournisseur natifs, ajouter
   variantes structurées et mapping article CRP/PT/version/unité/révision.
   Les identifiants distants restent opaques, sans FK inter-base. Aucun
   catalogue, tarif ou identifiant réel n'est inventé.
3. Le prix client reste privé EC. Retirer `ec_sale_unit_price`, encore présent
   dans le contrat pur, de toute enveloppe fournisseur avant transport actif.
   CRP reçoit le prix d'achat convenu et les données autorisées nécessaires.
4. Achat EC + outbox atomiques ; inbox CRP authentifiée, versionnée et
   idempotente. La notification ouvre une demande de **commande client CRP**,
   jamais une commande fournisseur CRP ou l'achat privé EC. L'acceptation crée
   la commande native dans la transaction de son reçu ; replay = même résultat.
5. Raccorder annulations, livraisons partielles, documents et deux cycles de
   facturation aux preuves natives. CRP vend à EC, EC vend au client, BL au nom
   EC : ces décisions utilisateur sont acquises, sans question à répéter.
6. Définir un profil de tâches serveur commercial ou un worker dédié avant
   activation : aucun filtrage stock/OF/procurement commercial n'est introduit
   par ce socle, qui conserve les starters industriels publiés.
7. Qualifier deux bases/services jetables : droits, panne réseau, doubles
   soumissions, commit incertain/reprise, restauration et confidentialité des
   prix. PGlite seul ne couvre pas cette preuve.

Étendre les écrans Achats/Fournisseurs, commandes clients et notifications
existants. L'Accueil commercial garde l'interface CERP commune, sans bureau
EC ni ERP parallèle. La boutique finale reste ultérieure. Aucun compte des
sept utilisateurs, base EC, service, migration réelle ou installateur de ce
lot n'est créé. Issues #1454/#1775 ouvertes ; aucun push/PR de ces branches.

## Candidate locale EC 2.0.30 après conservation de Métrologie 2.0.29

Le 27 octobre 2026, la base publiée Métrologie 2.0.29 a été fusionnée dans la
candidate locale `feature/1454-company-main-2.0.29` (merge `8c4f1104`). Les
migrations immuables EC et les ajouts Métrologie sont conservés ; l'inventaire
OpenAPI est régénéré à 1 628 opérations, couverture 100 %. Les garde-fous
commerciaux EC (`a64359db`) interdisent les transitions stock/OF et les actions
incohérentes. `npm run typecheck` et `npm run build` ont réussi localement.

Cette branche prépare la prochaine candidate EC 2.0.30, sans publication 2.0.29 :
aucun service, base, migration, installateur, push ou déploiement n'a été exécuté.
