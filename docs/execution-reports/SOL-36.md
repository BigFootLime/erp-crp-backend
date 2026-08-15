# Rapport d'exécution — SOL-36

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/537
- Branche : `docs/537-sol36-connector-gate`
- Base : `origin/main` `d00dd77265465917b3c13acb5a1e603c999440b9`
- Verdict : **NO-GO adaptateur réel — précondition client non satisfaite**

## Diagnostic et cause racine

Le premier connecteur doit répondre à un besoin financé. L'inventaire des dépôts,
des issues et de la configuration réelle ne trouve ni client payant associé, ni
logiciel/protocole choisi, ni spécification, ni bac à sable, ni secrets qualifiés.
Une implémentation Sage/EDI dans cet état serait une donnée et une compatibilité
inventées.

Le noyau existant n'est pas manquant : SOL-26 fournit la frontière de facturation
électronique et SOL-27 un moteur d'export canonique, versionné, idempotent, audité et
protégé par RBAC. La cause du blocage est exclusivement commerciale et contractuelle.

## Preuves examinées

- recherche ciblée dans `docs`, `src`, `scripts` et les issues des deux dépôts :
  aucune demande client nominative pour un fournisseur comptable ou EDI ;
- `ADR-0072` : aucun prestataire, contrat, certificat ou sandbox de Plateforme
  Agréée ;
- `ADR-0073` et rapport SOL-27 : aucun logiciel comptable prioritaire ni contrat
  d'import, l'adaptateur générique n'est pas déclaré compatible avec un tiers ;
- lecture PostgreSQL `BEGIN READ ONLY` sur `cerp_prod` :
  `einvoice_provider_connections=0`, `accounting_export_mapping_versions=0`,
  `accounting_export_batches=0` ; aucun statut de lot n'existe.

## Choix d'architecture

`ADR-0081` bloque tout adaptateur spécifique jusqu'à un dossier commercial complet.
Il réutilise les frontières SOL-26/SOL-27 et interdit une nouvelle architecture
générique prématurée. Le premier adaptateur sera un chemin vertical minimal contre
un bac à sable réel ; le coût d'un second sera mesuré ensuite sur le diff observé.

## Fichiers, migrations et données

- `docs/adr/ADR-0081-connectors-commercial-gate.md` ;
- `docs/execution-reports/SOL-36.md`.

Aucun fichier runtime, endpoint, secret, migration ou donnée n'est modifié. Le
frontend reste inchangé car aucun écran fonctionnel n'est autorisé sans connecteur.

## Vérifications exécutées

| Contrôle | Résultat |
|---|---|
| état Git de la base `origin/main` | propre, SHA `d00dd772…` |
| inventaire dépôts/issues | PASS — aucun besoin client ou fournisseur choisi |
| lecture production en transaction read-only | PASS — compteurs `0 / 0 / 0` |
| lecture des deux Markdown et contrôle des liens relatifs | PASS |
| `git diff --check` | PASS |

Les suites runtime et Playwright sont non applicables : aucune logique, API,
interface ou configuration exécutable n'est changée. Aucun accès navigateur ne peut
qualifier un tiers absent.

## Risques et compatibilité

- Le besoin futur peut imposer SFTP, API, AS2, EDIFACT ou un format propriétaire ;
  le choisir aujourd'hui créerait une dette sans preuve.
- L'export `GENERIC_DELIMITED_V1` reste disponible, mais son import dans un logiciel
  externe doit toujours être qualifié par le comptable.
- L'absence de connecteur reste visible et fermée ; aucun succès externe n'est
  simulé.

## Rollback

Revenir sur le commit documentaire retire seulement l'ADR et ce rapport. Aucun
rollback applicatif, SQL ou secret n'est requis.

## Reste réellement à faire

1. Obtenir un engagement client payant et désigner le propriétaire métier.
2. Fournir produit/version/protocole, spécification, exemples, sandbox et secrets.
3. Définir volumes, SLA, rejets, retry, réconciliation, support et prix.
4. Implémenter et qualifier alors le premier adaptateur réel, puis mesurer le coût
   d'un deuxième adaptateur à partir du travail observé.
