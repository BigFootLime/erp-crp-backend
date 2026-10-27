# Qualification locale du flux interentreprises — #1454 / #1775

État au 27 octobre 2026. Cette recette est exclusivement synthétique et locale.
Elle ne constitue pas une mise en service d'Esprit Carabine.
Les preuves locales ci-dessous ne remplacent pas le verdict de la gate complète
sur le couple de SHAs finalement retenu. La qualification navigateur reste ouverte.

## Socle conservé

Les branches de travail partent des sources publiées en 2.0.27 (backend
`f796d2e5`, frontend `d743bd48`). Le correctif frontend 2.0.28
`22ba11e3` est intégré par `a80b160e` pour conserver les dialogues matière et
l'ordre des champs corrigés. La fenêtre urgente de publication 2.0.28 a été
libérée par son opérateur ; aucun déploiement EC ne s'est déroulé en parallèle.
Les candidats d'intégration conservent désormais aussi les mains Métrologie
2.0.29 : backend `870c7ed0`, frontend `3be3fe7a`. La candidate EC est préparée en
2.0.30. La livraison Métrologie 2.0.29 est confirmée et sa fenêtre libérée ;
aucune nouvelle publication dans ce chat n'est annoncée depuis.

## Frontières réellement exercées

| Contrôle | Résultat et portée |
| --- | --- |
| Migration métier à froid | 337 patches de l'inventaire candidat intégré présents, zéro manquant et zéro mismatch après recréation du seul baseline synthétique PostgreSQL 17. Le ledger contient aussi deux patches explicitement TEST outillage, soit 339 lignes. |
| Commande EC, achat CRP et demande vendeur | Chemins natifs exercés sur deux bases PostgreSQL distinctes : outbox achat, inbox vendeur, notification, décision, création de commande vendeur et retour de décision. Ce helper SQL ne constitue pas à lui seul une preuve du transport HTTP entre processus fixes. |
| Livraison | Passage natif complet obtenu : AR archivé/envoyé vers un récepteur mail loopback TEST, prélèvement validé, BL SHIPPED et un mouvement POSTED. Reçu externe et historique LIVRE côté acheteur, sans mouvement local. Contre-vérification indépendante via `intercompany-durable-proof-1454.ts`. |
| Identité et basculement | Vrai Directory RPC puis vraies API Express de deux runtimes fixes : connexion acheteur, création du ticket, échange vendeur et contexte vendeur. Un en-tête d'une autre entreprise est refusé (403) ; le Bearer acheteur présenté au vendeur est refusé (401). Le rejeu avec la même clé est idempotent. |
| Transport HTTP | Deux processus fixes distincts (18081 acheteur, 18082 vendeur), chacun vérifiant sa propre base v2. Vrai routeur HMAC et worker natif : un achat et deux retours vendeur acquittés durablement, zéro échec. Rejeu de l'inbox vérifié ; signature, destination et environnement modifiés refusés en 403 dans les deux directions. Cette passe transporte des événements déjà appliqués par la recette SQL et exerce donc le rejeu réel, sans recréer les pièces métier. |
| Transport HTTP, première application fraîche | Nouvelle commande acheteur 24, commande vendeur 20. `PURCHASE_SUBMITTED`, retour `ORDER_DECIDED`, puis `SHIPMENT_DISPATCHED` livrés par les vrais workers HTTP. Pour chacun, absence de l'enveloppe cible avant son transport, puis application unique constatée. L'acceptation utilise le flux natif CRP, sans appliquer directement l'événement au destinataire. Livraison et deux factures de cette même paire sont prouvées ci-dessous. |
| Tarification publiée | Transaction PostgreSQL annulée : l'ancien prix publié est conservé après hausse du tarif courant ; une révision inexistante est refusée. Helper `intercompany-supplier-price-freeze-1454.ts`, commit `16cfc4ee`. |
| Premier catalogue EC | Publication CRP v2 avec variante/options et liaison technique résolue côté serveur, projection EC, création automatique du vrai article local `PURCHASED/achat/stock_managed=false` et de la référence fournisseur. Commande EC puis acceptation CRP `STANDARD`. La continuation de ces mêmes commandes passe jusqu'à la livraison et aux deux factures. Aucun faux sous-type fabriqué EC n'est créé. |
| Interface | Playwright isolé avec API simulée : connexion, administration entreprise, acceptation de demande avec référence/variante/options/prix et adresse, basculement vers l'accueil EC, absence devis/production et création d'un particulier. Ce test visuel ne remplace pas la recette API métier. |
| Factures | Deux émissions natives sur le même scénario : CRP → EC, 2 × 70 = 140 HT / 168 TTC ; EC → particulier, 2 × 120 = 240 HT / 288 TTC, fiscalité professionnelle du particulier absente. Numérotations et émetteurs distincts, allocations consommées une fois, deux PDF archivés et récupérables. Prix exclusivement synthétiques. |
| Profil purement commercial | Preuve PostgreSQL : lecture workflow et tentatives industrielles EC laissent checkpoints, affaires, réservations et OF à zéro ; workflow CRP standard conservé. Édition, duplication, suppression/annulation locale non synchronisées d'une commande transmise sont refusées explicitement. L'interface et les guides EC suivent cette limite. |
| Invariants industriels | Les lignes `STANDARD` exigent toujours le sous-type fabriqué. Les inserts achetés et bascules sans mapping sont refusés. Suppression du sous-type référencé refusée, y compris après blocage concurrent `KEY SHARE`; update sans changement d'identifiant permis. Les gardes sont des migrations additives, sans modification des anciens checksums. |

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

### Scénario final depuis une offre publiée

La commande EC **23** utilise un nouvel article acheté et non stocké créé depuis
l'offre publiée, au tarif synthétique de vente 149,50 HT. Son achat transmet
85,50 HT à CRP, avec la référence technique, la variante et les options publiées.
L'acceptation crée la commande CRP **19** en mode `STANDARD`.
La fixture fournit un vrai lot OLD qualifié **avant** le contrôle stock natif,
puis utilise AR, planning, prélèvement, dossier qualité, pack et expédition.
Une précédente tentative avait légitimement déclenché un OF faute de stock ;
ses états n'ont pas été réécrits pour contourner ce comportement.

Le BL `d635655e-67b5-4d8c-b203-b14d0e51e92e` est `SHIPPED`, avec un unique
mouvement stock `POSTED`. Le reçu EC
`feca9e57-bab9-478a-a2b0-6d72034ad551` est unique, prouve une quantité de 1 et
place la commande en `LIVRE`, avec zéro mouvement stock local EC. Les lecteurs
natifs de livraison et pack utilisent le destinataire final figé :
`TEST final customer`, `1 rue Fixture TEST`, `69001 Lyon`. L'adresse maître EC
chez CRP reste distincte et intacte.

Les factures sources de ces mêmes pièces sont `E2E-F-000007` côté CRP
(85,50 HT / 102,60 TTC) et `EC-V2-F-000008` côté EC
(149,50 HT / 179,40 TTC). Les allocations sont consommées une seule fois sur
le BL/reçu concerné, leurs PDF sont archivés et les parties fiscales sont
distinctes : CRP → EC professionnel, puis EC → particulier final. Le vrai schéma
HTTP finance canonicalise la remise UI `"0"` et les quantités à trois décimales
avant preview, brouillon et émission. Le contrôle indépendant ne sélectionne
pas simplement les deux dernières factures : il impose leurs sources communes
avec le reçu et le BL testés.

Helpers : `intercompany-commercial-catalogue-v2-1454.ts` avec
`--defer-industrial-launch`, puis
`intercompany-catalogue-existing-delivery-1454.ts`,
`intercompany-billing-1454.ts`, `intercompany-invoice-archive-1454.ts` et
`intercompany-durable-proof-1454.ts` avec les montants attendus explicites.

Inventaire SQL candidat, format explicite v2 : prendre les couples
`filename:sha256` renvoyés par `scripts/db-patches.js`, les trier avec
`Array.sort()` lexical JavaScript, joindre par LF et ajouter un LF final, puis
hacher le texte UTF-8 en SHA-256. Empreinte des 337 patches :
`fe17625705276099fd628190eab8155f67d087606db648afdc0ea5dca2e217e4`.
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

### Parcours frais complet par transport HTTP

Sur le backend source `cf52bfc7`, le run synthétique
`d40cf269-e35d-461c-bc39-eb8ffa6aaf86` crée la commande EC 24, son achat et la
demande CRP; la décision native crée la commande CRP 20. Les processus pairs
restent fixés chacun à leur propre base. Les préconditions de première
application distinguent cette preuve des replays historiques du tableau.

Le BL `a1a9318b-bf55-471b-8a2a-a7c4f394d801` est réellement expédié avant
transport de `f7d27202-72c0-4b05-a87e-13b54080e309`. Juste avant le worker, EC
ne possède ni cette inbox ni ce reçu; après, chacun existe une fois, la commande
EC est LIVRE, le BL CRP est SHIPPED, avec un mouvement POSTED côté CRP et aucun
mouvement EC. Les documents portent l'émetteur EC et la destination finale
synthétique; la destination native du colis correspond au snapshot.

Les deux factures natives sont émises et leurs PDF officiels archivés puis
récupérés avec vérification SHA-256 et signature PDF : CRP `E2E-F-000008`,
85,50 HT / 102,60 TTC, source DELIVERY_LINE; EC `EC-V2-F-000009`,
149,50 HT / 179,40 TTC, source EXTERNAL_FULFILMENT_RECEIPT_LINE.
Chaque allocation consomme exactement la quantité 1 de ce BL/reçu, avec
émetteurs, destinataires et numérotations distincts. Les montants restent
strictement synthétiques.

La contre-vérification versionnée `intercompany-durable-proof-1454.ts`, exécutée
indépendamment en lecture seule, passe sur ce reçu frais et sur l'ancien reçu
`feca9e57-bab9-478a-a2b0-6d72034ad551`. L'ancien BL et ses deux factures restent
intacts après le drainage des outboxes. Les reçus d'exécution, adaptations TEST
et PDF sont conservés hors Git, sans donnée ni secret de production.

### Contrôles de code déjà acquis

- Backend intégré : build complet réussi, contrat OpenAPI valide, 1 628 opérations
  inventoriées. La réception interentreprises déclare explicitement la signature
  HMAC du pair, indépendamment du Bearer utilisateur.
- Backend global après les correctifs de catalogue et de finance : 883 fichiers,
  8 828 tests réussis, 261 ignorés et zéro échec. Les derniers ajouts SQL de
  verrouillage sont aussi vérifiés dans PostgreSQL réel et les 27 tests du runner
  avec la cohorte figée de 14 patches entreprise. Build complet réussi.
- Frontend : typecheck et build réussis ; 24 tests ciblés API demande/facturation
  réussis ; scénario Playwright sans retry réussi. La suite complète avant la
  dernière fusion a passé 633 fichiers / 4 336 tests. La passe frontend finale
  passe 637 fichiers / 4 351 tests, zéro échec et zéro test ignoré, avec le chemin
  de corpus explicite et la concurrence CI bornée. Les deux parcours natifs
  Electron (Accueil et reprise API/session) passent sans retry après alignement
  de leur réponse de fixture sur le vrai contrat `LEGACY`.
- Le scénario navigateur a permis de corriger le type de l'identifiant natif
  de commande et l'affichage automatique du tutoriel par-dessus la demande.

### Protection des paiements et remboursements historiques

Le premier gate complet a détecté une régression SQL : la nouvelle source EC
avait remplacé le validateur d'allocations sans conserver le calcul cash/avoirs/
remboursements de CUSTOMER-REFUND-1268. La migration additive
`20261027_zzzzzz_intercompany_refund_allocation_guard_1454.sql` restaure ce corps
canonique et conserve la branche dédiée aux reçus externes. Aucun patch déjà
appliqué ni checksum historique n'a été modifié.

La recette PostgreSQL transactionnelle crée un avoir de 100 et son remboursement
de 100, accepte le paiement net de 102,60, puis refuse une sur-allocation, une
conversion de paiement legacy et un avoir lié à un autre client. Elle se termine
par ROLLBACK sans désactivation des triggers. Le reçu EC déjà consommé est
également refusé par le preview (`SOURCE_FULLY_INVOICED` et
`SOURCE_QUANTITY_EXCEEDED`). La preuve indépendante du BL et des deux factures
archivées reste passante. Le support verifier 1268 et la répétition officielle
de migration/rejeu/restauration passent après le correctif. Le gate global reste
à terminer sur le dernier candidat figé, sans présenter ces contrôles partiels
comme son verdict final.

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
La lecture des 13 classeurs XLSX et de l'export XLS historique n'a trouvé aucun
mapping explicite entre les 16 références tarifaires et les anciens plans ECxxxx.
Les correspondances de noms CAD seules ne sont pas utilisées comme versions
techniques approuvées.
L'utilisateur demande de créer les 16 fiches avec leurs tarifs, puis de compléter
la technique dans l'ERP. La reprise initialise donc des fiches à compléter sans
inventer de plan, gamme ou variante; les contrôles techniques natifs restent
applicables avant tout lancement qui en dépend.

L'utilisateur confirme que le SIRET définitif EC n'est pas encore disponible et
qu'il sera renseigné dans le paramétrage ERP de l'entreprise. Une identité de
démonstration peut être utilisée pour la recette. Aucun identifiant légal réel
n'est inventé ou déduit du bon de commande de 2023.

Les paquets Windows intermédiaires ne sont pas retenus comme livraison finale.
Le paquet final devra contenir l'export renderer de la gate réussie, avec contrôle
du manifeste, du payload extrait, du SHA de source, de l'API relative et du feed.
Aucun installateur EC n'a été installé ni publié.

L'utilisateur confirme KEENAN SuperAdmin sur CRP/EC et tous leurs paramètres.
La mise à jour d'une membership ou la réactivation d'une instance opaque préserve
un rôle SuperAdmin déjà configuré dans Directory; une nouvelle membership reste
non SuperAdmin tant qu'une attribution explicite auditée n'est pas faite.
Les tests ciblés des deux UPSERT et le typecheck backend passent. Aucun contrôle
de membership active, de modules, de session ou de MFA n'est contourné.
NIZIER et LAMBERT sont différés à sa demande, sans création ni activation.

Les affectations réelles des autres utilisateurs demandés, le provisionnement EC,
le catalogue réel et la livraison coordonnée restent ouverts. Le site e-commerce
final fera l'objet du travail ultérieur demandé par l'utilisateur.
