# Rapport d'exécution — SOL-37

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/540
- Branche : `docs/540-sol37-organization-identity-gate`
- Base : `origin/main` `132b0f7c0f611bab095c6503dde64a6789ea8ac9`
- Verdict : **instances dédiées ; NO-GO multi-société/SSO/SCIM sans contrat**

## Diagnostic et cause racine

Le modèle courant isole l'entreprise par instance de déploiement. Les entrepôts et
magasins sont des objets logistiques, pas des tenants. Aucune preuve ne montre
plusieurs clients CERP+ ni un client multi-site avec besoin contractuel, et aucun IdP
n'est choisi. Introduire aujourd'hui des clés de tenant ou un SSO générique créerait
des ambiguïtés d'écriture et une surface de fuite sans utilisateur réel.

## Preuves

- recherche des deux dépôts et des issues : aucune demande multi-site, SSO, SCIM,
  OIDC ou SAML contractualisée ;
- code et ADR-0076 : aucun contexte société/site universel, et un `site_id` de filtre
  Direction correspond à un entrepôt métier ;
- transaction PostgreSQL `BEGIN READ ONLY` sur `cerp_prod` : 4 entrepôts, 5 magasins,
  18 utilisateurs ; zéro colonne de tenant/société/organisation/site et zéro table
  `tenants`, `companies`, `organizations`, `societes`, `sites`, `sso_connections` ou
  `scim_connections`.

## Architecture retenue

`ADR-0082` maintient une instance dédiée par société et interdit d'utiliser les
magasins comme frontière de sécurité. Il cartographie les propriétaires actuels et
définit un plan additif en huit étapes si un besoin réel apparaît : spine
organisation/site, backfill, contexte serveur, isolation, consolidation, IdP, SCIM
idempotent et qualification de compatibilité.

L'invariant futur est explicite : toute écriture reçoit société/site du serveur et
échoue en cas d'ambiguïté. Une valeur venant du navigateur ne peut jamais élargir le
périmètre autorisé.

## Fichiers, migrations et données

- `docs/adr/ADR-0082-dedicated-instance-organization-boundary.md` ;
- `docs/execution-reports/SOL-37.md`.

Aucun code, endpoint, claim, secret, migration ou donnée n'est ajouté. Le frontend
reste inchangé. Les 4 entrepôts et 5 magasins existants ne sont pas réinterprétés.

## Tests et vérifications

| Contrôle | Résultat |
|---|---|
| inventaire Git/dépôts/issues | PASS |
| introspection `cerp_prod` en lecture seule | PASS |
| validation UTF-8 des Markdown | PASS — 2/2 |
| `git diff --check` | PASS |

Typecheck, build et E2E sont non applicables à ce diff documentaire. Aucun navigateur
ne peut prouver un SSO ou un changement de contexte qui n'existe pas.

## Risques et compatibilité

- Plusieurs entrepôts ne prouvent ni plusieurs sites juridiques ni des droits
  inter-sites ; les confondre provoquerait des fuites ou des blocages.
- Une future consolidation doit gérer numérotations, devises, calendriers, coûts,
  documents et sauvegardes ; elle ne peut être activée domaine par domaine sans
  rapport de couverture.
- Le modèle dédié reste compatible avec toutes les fonctions actuelles.

## Rollback

Revenir sur le commit documentaire retire seulement la décision et le rapport. Il
n'existe aucun changement SQL ou de secrets à restaurer.

## Reste réellement à faire

1. Obtenir un contrat multi-société/multi-site ou SSO et identifier l'IdP réel.
2. Valider propriété, partage, numérotations, stocks, calendriers, coûts et GED.
3. Exécuter alors le plan ADR-0082 avec sauvegarde, migration par domaine, tests de
   non-fuite et rollback démontré.
