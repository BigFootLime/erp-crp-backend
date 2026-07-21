# Affaires — contrat HTTP (#169)

Base : `/api/v1/affaires`. Toutes les routes exigent `authenticateToken` et une **capacité RBAC**
distincte (refus par défaut). Le serveur est l'autorité : codes, statuts et dates sont attribués par
le serveur ; le frontend ne calcule ni code, ni statut, ni agrégat.

## Modèle

L'affaire est le dossier opérationnel 360 de la commande à la clôture. Elle **n'invente ni ne recopie**
de totaux métier modifiables : les agrégats (production, achats, planning, qualité, livraison, facture)
proviennent de read-models calculés depuis les modules propriétaires (`/command-center`, `/:id/operations`).

- `reference` : code métier **`AFF-AAAA-NNNN`**, attribué par le serveur via la séquence transactionnelle
  centrale (`generateAffaireCode` → `fn_next_issued_code_value`). **Immuable**, jamais une clé étrangère,
  jamais fourni par le client.
- `statut` : `OUVERTE | EN_COURS | SUSPENDUE | CLOTUREE | ANNULEE`. N'évolue que par `/transition`.
- Verrou optimiste : `updated_at` (jeton `expected_updated_at`).

## Capacités RBAC

`read` (lectures) · `write` (création / édition métadonnées / aperçu) · `transition` · `close` · `reopen`
· `archive` · `allocate` · `finance`. Chaque capacité correspond à un ensemble de rôles ; le refus est
renvoyé côté serveur indépendamment de la visibilité des boutons.

## Endpoints

### Lectures (`read`)
- `GET /affaires` — liste paginée (filtres q / client / statut / type / dates, tri, `include=client`).
- `GET /affaires/command-center` — command center avec rollups production / livraison / facturation /
  contrôle, segments, `next_action`, `risk_flags`, traçabilité.
- `GET /affaires/:id` — fiche (`include=client,commande,devis`).
- `GET /affaires/:id/operations` — détail 360 : allocations par ligne, OF, livraisons, factures,
  documents, timeline (event-logs + audit).

### Aperçu de création (`write`) — aucun effet de bord
`POST /affaires/preview`
```json
{ "client_id": "001", "commande_id": 123, "type_affaire": "livraison", "commentaire": null }
```
→ `200` `{ code_format: "AFF-YYYY-NNNN", type_affaire, client, commande, warnings[], blockers[], can_create }`.
Ne consomme **pas** la séquence de code, ne crée rien. Avertissements : `COMMANDE_ALREADY_HAS_AFFAIRE`,
`CLIENT_MISMATCH`. Bloqueurs : `CLIENT_NOT_FOUND`, `COMMANDE_NOT_FOUND`.

### Création (`write`)
`POST /affaires`
```json
{ "client_id": "001", "commande_id": 123, "type_affaire": "livraison", "date_ouverture": "2026-07-21", "commentaire": null }
```
→ `201` `{ id, reference, updated_at }`. Le `statut` initial est `OUVERTE` (serveur). Une `reference`
fournie par le client est **ignorée**. `client_id` requis pour `livraison`, optionnel pour `projet`.

### Édition métadonnées (`write`)
`PATCH /affaires/:id`
```json
{ "commentaire": "note", "date_ouverture": "2026-07-21", "expected_updated_at": "<updated_at reçu au GET>" }
```
→ `200` `{ id, statut, updated_at }`. `statut` et `reference` **non modifiables** ici (ignorés). Corps sans
champ modifiable → `400`. Jeton périmé → `409 CONCURRENT_MODIFICATION`.

### Transition d'état (`transition` / `close` / `reopen`)
`POST /affaires/:id/transition`
```json
{ "to": "CLOTUREE", "reason": null, "expected_updated_at": "<jeton>" }
```
→ `200` `{ id, statut, updated_at }`. `reason` obligatoire pour `SUSPENDUE` et `ANNULEE`. Transitions
autorisées : OUVERTE→{EN_COURS,SUSPENDUE,CLOTUREE,ANNULEE} · EN_COURS→{SUSPENDUE,CLOTUREE,ANNULEE} ·
SUSPENDUE→{OUVERTE,EN_COURS,CLOTUREE,ANNULEE} · CLOTUREE→{OUVERTE,EN_COURS} (**réouverture auditée**) ·
ANNULEE→∅ (terminal). Transition interdite → `422 INVALID_TRANSITION` (`details.allowed`). La capacité fine
(close / reopen / cancel) est renforcée côté serveur une fois le statut courant connu.

### Archivage (`archive`) — aucune suppression physique
`POST /affaires/:id/archive`
```json
{ "reason": "dossier soldé", "expected_updated_at": "<jeton>" }
```
→ `200` `{ id, statut: "ANNULEE", updated_at, already_archived }`. Idempotent (une affaire déjà archivée
renvoie son état sans nouvelle écriture). La ligne et **toute la traçabilité** (mappings commande↔affaire,
OF, BL, factures) sont conservées.

## Ne fait jamais
Aucune création automatique de BL ou de facture. Aucune écriture d'un total métier modifiable. Aucune
suppression physique d'affaire. La génération depuis une commande reste orchestrée par le moteur commande
(`POST /api/v1/commandes/:id/generate-affaires`, idempotent, transaction unique).

## Codes d'erreur
`400` (validation / aucun champ) · `401` · `403 FORBIDDEN` (capacité manquante) · `404` · `409
CONCURRENT_MODIFICATION` · `422 INVALID_TRANSITION` · `5xx` générique (message masqué, corréler via
`X-Request-Id`).
