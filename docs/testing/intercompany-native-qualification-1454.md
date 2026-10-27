# Qualification locale du flux interentreprises — #1454 / #1775

État au 27 octobre 2026. Cette recette est exclusivement synthétique et locale.
Elle ne constitue pas une mise en service d'Esprit Carabine.

## Socle conservé

Les branches de travail partent des sources publiées en 2.0.27 (backend
`f796d2e5`, frontend `d743bd48`). Le correctif frontend 2.0.28
`22ba11e3` est intégré par `a80b160e` pour conserver les dialogues matière et
l'ordre des champs corrigés. La fenêtre urgente de publication 2.0.28 a été
libérée par son opérateur ; aucun déploiement EC ne s'est déroulé en parallèle.

## Frontières réellement exercées

| Contrôle | Résultat et portée |
| --- | --- |
| Migration métier à froid | 329 patches appliqués sur une nouvelle base PostgreSQL 17 synthétique ; zéro pending et zéro mismatch lors du contrôle. |
| Commande EC, achat CRP et demande vendeur | Chemins natifs exercés sur deux bases PostgreSQL distinctes : outbox achat, inbox vendeur, notification, décision, création de commande vendeur et retour de décision. Ce helper SQL ne constitue pas à lui seul une preuve du transport HTTP entre processus fixes. |
| Livraison | Préparation et contrôles natifs exercés. La qualification complète expédition/réception reste ouverte : le traitement d'archivage officiel de l'AR et le transport mail TEST sont nécessaires avant de franchir l'envoi AR. |
| Identité et basculement | Vrai Directory RPC puis vraies API Express de deux runtimes fixes : connexion acheteur, création du ticket, échange vendeur et contexte vendeur. Un en-tête d'une autre entreprise est refusé (403) ; le Bearer acheteur présenté au vendeur est refusé (401). Le rejeu avec la même clé est idempotent. |
| Tarification publiée | Transaction PostgreSQL annulée : l'ancien prix publié est conservé après hausse du tarif courant ; une révision inexistante est refusée. Helper `intercompany-supplier-price-freeze-1454.ts`, commit `16cfc4ee`. |
| Interface | Playwright isolé avec API simulée : connexion, administration entreprise, acceptation de demande avec référence/variante/options/prix et adresse, basculement vers l'accueil EC, absence devis/production et création d'un particulier. Ce test visuel ne remplace pas la recette API métier. |
| Factures | Helper natif brouillon/demande/validation/émission préparé. Deux émissions et leurs documents ne sont pas encore qualifiés sur les sources issues de cette livraison. |

Un premier résultat livraison annoncé sur la seule sortie du processus a été
rétracté après contrôle direct des bases : les BL étaient encore READY et
aucun reçu externe n'existait. Les succès suivants doivent être appuyés par un
marqueur final durable **et** les états SQL après exécution. Une sortie 0 ou un
message intercepté par le logger ne suffit pas.

Les helpers utilisent le conteneur local dédié `cerp-ec1454-fixture`, son label
`cerp-task=1454` et le port loopback 15464. Les anciennes bases sont préservées ;
les bases v2 sont des clones du nouveau baseline. Les tests d'identité utilisent
d'autres clones opaques et un annuaire jetable séparé. Aucun DSN, secret de
signature, mot de passe, document client ou tarif réel n'est versionné.

## Vérifications de code et d'interface

- Backend : build complet réussi, contrat OpenAPI valide, 1 619 opérations
  inventoriées. La réception interentreprises déclare explicitement la signature
  HMAC du pair, indépendamment du Bearer utilisateur.
- Backend : 12 fichiers / 105 tests ciblés réussis, incluant entreprises,
  transport, reçus de livraison et contrat OpenAPI.
- Frontend : typecheck et build réussis ; 24 tests ciblés API demande/facturation
  réussis ; scénario Playwright sans retry réussi.
- Le scénario navigateur a permis de corriger le type de l'identifiant natif
  de commande et l'affichage automatique du tutoriel par-dessus la demande.

Commandes locales sans secret, exécutées depuis leurs worktrees respectifs :

```powershell
corepack pnpm build
corepack pnpm test:run src/module/entreprises src/__tests__/openapi-contract-sol28.test.ts src/module/commande-client/routes/intercompany-fulfilment.routes.test.ts
# Frontend
corepack pnpm typecheck
corepack pnpm exec vitest run src/modules/facturation/pages/FacturationWorkflowPage.test.tsx src/modules/commande-client/api/intercompany-requests.api.test.ts
$env:CERP_E2E_ISOLATED='1'
$env:CERP_E2E_MANAGED_STACK='1'
$env:E2E_BASE_URL='http://127.0.0.1:5179'
corepack pnpm exec playwright test e2e/multi-company-switch.fixture.spec.ts --project=chromium --retries=0
```

Le dernier scénario utilise un serveur preview local déjà lancé sur le build
qualifié. Ses captures et traces restent dans `test-results`, hors versionnement.

## Paramétrage et mise en service encore ouverts

Le dossier source fourni contient 16 lignes avec prix fournisseur explicite.
Un aperçu d'import privé a été préparé ; les références techniques et variantes
doivent être créées ou liées avant publication. Aucun tarif manquant n'est
déduit et aucun stock historique n'est chargé depuis les anciens classeurs.

L'utilisateur confirme que le SIRET définitif EC n'est pas encore disponible et
qu'il sera renseigné dans le paramétrage ERP de l'entreprise. Une identité de
démonstration peut être utilisée pour la recette. Aucun identifiant légal réel
n'est inventé ou déduit du bon de commande de 2023.

Les affectations réelles des sept utilisateurs demandés, le provisionnement EC,
le catalogue réel et la livraison coordonnée restent ouverts. Le site e-commerce
final fera l'objet du travail ultérieur demandé par l'utilisateur.
