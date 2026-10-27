# Qualification locale du flux interentreprises — #1454 / #1775

État au 27 octobre 2026. Cette recette est exclusivement synthétique et locale.
Elle ne constitue pas une mise en service d'Esprit Carabine.

## Socle conservé

Les branches de travail partent des sources publiées en 2.0.27 (backend
`f796d2e5`, frontend `d743bd48`). Le correctif frontend 2.0.28
`22ba11e3` est intégré par `a80b160e` pour conserver les dialogues matière et
l'ordre des champs corrigés. La fenêtre urgente de publication 2.0.28 a été
libérée par son opérateur ; aucun déploiement EC ne s'est déroulé en parallèle.
Les candidats d'intégration conservent désormais aussi les mains Métrologie
2.0.29 : backend `870c7ed0`, frontend `3be3fe7a`. La candidate EC est préparée en
2.0.30 ; la fenêtre Métrologie 2.0.29 reste prioritaire jusqu'à sa libération.

## Frontières réellement exercées

| Contrôle | Résultat et portée |
| --- | --- |
| Migration métier à froid | 332 patches de l'inventaire candidat intégré présents, zéro manquant et zéro mismatch après recréation du seul baseline synthétique PostgreSQL 17. Le ledger contient aussi deux patches explicitement TEST outillage, soit 334 lignes. |
| Commande EC, achat CRP et demande vendeur | Chemins natifs exercés sur deux bases PostgreSQL distinctes : outbox achat, inbox vendeur, notification, décision, création de commande vendeur et retour de décision. Ce helper SQL ne constitue pas à lui seul une preuve du transport HTTP entre processus fixes. |
| Livraison | Passage natif complet obtenu : AR archivé/envoyé vers un récepteur mail loopback TEST, prélèvement validé, BL SHIPPED et un mouvement POSTED. Reçu externe et historique LIVRE côté acheteur, sans mouvement local. Contre-vérification indépendante via `intercompany-durable-proof-1454.ts`. |
| Identité et basculement | Vrai Directory RPC puis vraies API Express de deux runtimes fixes : connexion acheteur, création du ticket, échange vendeur et contexte vendeur. Un en-tête d'une autre entreprise est refusé (403) ; le Bearer acheteur présenté au vendeur est refusé (401). Le rejeu avec la même clé est idempotent. |
| Transport HTTP | Deux processus fixes distincts (18081 acheteur, 18082 vendeur), chacun vérifiant sa propre base v2. Vrai routeur HMAC et worker natif : un achat et deux retours vendeur acquittés durablement, zéro échec. Rejeu de l'inbox vérifié ; signature, destination et environnement modifiés refusés en 403 dans les deux directions. Cette passe transporte des événements déjà appliqués par la recette SQL et exerce donc le rejeu réel, sans recréer les pièces métier. |
| Tarification publiée | Transaction PostgreSQL annulée : l'ancien prix publié est conservé après hausse du tarif courant ; une révision inexistante est refusée. Helper `intercompany-supplier-price-freeze-1454.ts`, commit `16cfc4ee`. |
| Interface | Playwright isolé avec API simulée : connexion, administration entreprise, acceptation de demande avec référence/variante/options/prix et adresse, basculement vers l'accueil EC, absence devis/production et création d'un particulier. Ce test visuel ne remplace pas la recette API métier. |
| Factures | Deux émissions natives sur le même scénario : CRP → EC, 2 × 70 = 140 HT / 168 TTC ; EC → particulier, 2 × 120 = 240 HT / 288 TTC, fiscalité professionnelle du particulier absente. Numérotations et émetteurs distincts, allocations consommées une fois, deux PDF archivés et récupérables. Prix exclusivement synthétiques. |
| Profil purement commercial | Preuve PostgreSQL : lecture workflow et tentatives industrielles EC laissent checkpoints, affaires, réservations et OF à zéro ; workflow CRP standard conservé. Édition, duplication, suppression/annulation locale non synchronisées d'une commande transmise sont refusées explicitement. L'interface et les guides EC suivent cette limite. |

Un premier résultat livraison annoncé sur la seule sortie du processus a été
rétracté après contrôle direct des bases : les BL étaient encore READY et
aucun reçu externe n'existait. Les succès suivants doivent être appuyés par un
marqueur final durable **et** les états SQL après exécution. Une sortie 0 ou un
message intercepté par le logger ne suffit pas.

La contre-vérification indépendante lit le reçu
`1bb8a87e-db05-4e85-a686-f35fc41bdc82`, son BL vendeur
`fc79a727-6800-4045-807a-ebf1e1001c7b`, son unique mouvement POSTED et le workflow
LIVRE acheteur pour une quantité prouvée de 2. Le snapshot officiel du BL
`1fd65909-8667-42bd-9a3a-dbaa7fb214d7` porte l'émetteur synthétique
`TEST EC ACHETEUR v2` et le destinataire `TEST final customer`.
Lors de la première lecture, son archivage PDF final était encore en attente.
Le worker natif a ensuite archivé le PDF en GED : 36 909 octets, SHA-256
`eb491096926a17d716f2944f024e03f1daf0df703389d2f863d8b12a1e030d84`.
Le read natif a vérifié cette empreinte et exporté une copie TEST privée pour
contrôle visuel. La conformité du snapshot était une étape distincte de cette
disponibilité PDF.

Une dernière passe après correction du branding et des gardes commerciales a
créé de nouvelles pièces sans réinitialiser les bases v2 : commande acheteur 2,
commande vendeur 2, BL `8507bb4f-9b08-4358-89d7-08d76faad5f6` et reçu
`7a4b7d32-b89a-44df-81e5-13ba68a5a32d`. La lecture indépendante confirme SHIPPED,
un mouvement POSTED, LIVRE et quantité prouvée 2. Les factures émises sont
`E2E-F-000002` (CRP) et `EC-V2-F-000002` (EC), avec les montants du tableau.
Le nouveau PDF EC émis nativement porte la marque, le pied de page et les
métadonnées EC, sans occurrence CRP. Les anciens PDF de test restent immuables.

Inventaire SQL candidat (filename:SHA-256 canonical LF trié) :
`fd161e2fb3c312351311afb4768edd5ee4d9a27ade62460ae17f081db4e41fd9`.
Les deux lignes TEST supplémentaires sont
`20261025_outillage_indicative_catalogue_prices_test_only.sql` et
`20261025_outillage_supplier_master_offers_test.sql` ; elles ne sont pas une
autorisation de reprise des données outillage en production.

Les helpers utilisent le conteneur local dédié `cerp-ec1454-fixture`, son label
`cerp-task=1454` et le port loopback 15464. Les anciennes bases sont préservées ;
les bases v2 sont des clones du nouveau baseline. Les tests d'identité utilisent
d'autres clones opaques et un annuaire jetable séparé. Aucun DSN, secret de
signature, mot de passe, document client ou tarif réel n'est versionné.

## Vérifications de code et d'interface

- Backend intégré : build complet réussi, contrat OpenAPI valide, 1 628 opérations
  inventoriées. La réception interentreprises déclare explicitement la signature
  HMAC du pair, indépendamment du Bearer utilisateur.
- Backend : 12 fichiers / 105 tests ciblés réussis, incluant entreprises,
  transport, reçus de livraison et contrat OpenAPI.
- Frontend : typecheck et build réussis ; 24 tests ciblés API demande/facturation
  réussis ; scénario Playwright sans retry réussi. La suite complète avant la
  dernière fusion a passé 633 fichiers / 4 336 tests. Une nouvelle passe globale
  des deux candidats intégrés est en cours ; ces résultats ne sont pas encore
  présentés comme une validation globale de la candidate.
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
