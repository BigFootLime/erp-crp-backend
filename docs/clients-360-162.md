# Client 360 — durcissement et extension (#162)

Référence : BigFootLime/crp-systems-web#162 (parent #161). ADR côté frontend :
`docs/adr/ADR-0017-client-360-contract.md` (crp-systems-web). Deux commits :

1. `security:` — durcissement P0 (aucune dépendance schéma, déployable seul).
2. `feat:` — extension 360 (requiert le patch ci-dessous, à appliquer AVANT le code).

## Contrat `/api/v1/clients` après #162

| Route | Auth | Rôles écriture | Notes |
|---|---|---|---|
| GET `/`, `/analytics`, `/:id`, `/:clientId/contacts`, `/:clientId/addresses` | Bearer requis | — | Liste sans IBAN/BIC/téléphone personnel ; détail IBAN masqué (`iban_masked`) hors rôles finance |
| POST `/` | Bearer | Directeur, Administrateur Systeme et Reseau, Secretaire | `client_code` fourni → 400 `CLIENT_CODE_READONLY` ; SIRET en conflit → 409 `CLIENT_SIRET_EXISTS` (+`details`) ; `Idempotency-Key` UUID → rejeu 200 |
| POST `/duplicate-check` | Bearer | — (lecture) | Corps `{siret?, vat_number?, company_name?, exclude_client_id?}` → `{candidates[]}` minimisés |
| PATCH `/:id` | Bearer | idem écriture | `client_code` → 400 `CLIENT_CODE_IMMUTABLE` ; statut actif efface `archived_at` |
| DELETE `/:id` | Bearer | idem écriture | **Archivage logique** : `status='inactif'`, `blocked=true`, `archived_at/by` — aucune destruction |
| POST `/:id/archive` | Bearer | idem écriture | Archivage horodaté |
| PATCH `/:id/contact` | Bearer | idem écriture | Zod + appartenance au client sous transaction → 422 `CONTACT_NOT_OF_CLIENT` |

Réponse d'erreur : `errorHandler` ajoute `details` pour les 4xx volontaires (ex. fiche en
conflit SIRET). Les logs (requestLogger, morgan, auth middleware, contexte d'audit) ne
portent plus de query string (PII des recherches).

## Patch SQL additif

`db/patches/20260720_clients_360_hardening.sql` — idempotent, strictement additif :
`clients.client_uuid` (cible d'identité), `archived_at/archived_by`,
`created_at/updated_at/created_by/updated_by` (+ backfill `creation_date`, trigger
`tg_set_updated_at` si présent), `devise/encours_max/incoterm/langue`,
`contacts.archived_at`, table `client_create_idempotency`, index `clients_siret_idx`.

- Verify : `db/patches/support/20260720_clients_360_hardening.verify.sql` (contrôles + décompte
  des doublons SIRET legacy : l'index UNIQUE n'est créé qu'à décompte zéro).
- Rollback : `db/patches/support/20260720_clients_360_hardening.rollback.sql` (perte assumée
  des seules données nouvelles).
- **Jamais appliqué en production par la session IA.** Ordre de release : `cerp_test`,
  verify, puis production par un humain, puis déploiement du code.

## Code mort supprimé

`nextClientId` (MAX+1), `client.service.createClient` (MAX+1 inline),
`updateClientPrimaryContact` (sans contrôle d'appartenance), `repoUpdateClient`
(remplacement complet + suppression physique de contacts) — tous non routés, vérifié.

## Suivis documentés (non inclus volontairement)

- Endpoint de désactivation de contact (`contacts.archived_at` prêt en base).
- Index UNIQUE SIRET après nettoyage des doublons legacy (verify fourni).
- Upload logo sécurisé (CA-APP-05) — route commentée conservée.
- Chiffrement IBAN au repos après stabilisation du schéma.
- `swagger.ts` non mis à jour pour les nouveaux champs/en-têtes.

## Vérification

`npm run build` ✅ · `npm run test:run` : 59 fichiers / 359 tests ✅ (dont
`src/__tests__/clients-360-hardening.routes.test.ts` : 37 tests couvrant 401/403, DTO
minimisés, masquage IBAN par rôle, code serveur sans MAX+1, 409 SIRET, duplicate-check,
contact principal transactionnel, archivage logique, logs sans query, finance structurée,
idempotence, horodatage d'archivage).
