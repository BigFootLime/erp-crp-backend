# Poste opérateur tablette — socle serveur (#159)

- **Statut** : code implémenté en local, **non déployé**. Patch appliqué sur **cerp_test**
  puis, le 2026-07-26 à 20:09 et **hors de l'intervention qui a produit ce lot**, sur
  **cerp_prod** (même empreinte, `verify` 9/9 sur les deux bases, tables vides).
- **Frontend** : [crp-systems-web#289](https://github.com/BigFootLime/crp-systems-web/issues/289)
- **Décisions** : `crp-systems-web/docs/adr/ADR-0030-shopfloor-operator-station.md`,
  `ADR-0031-ot-it-gateway-dnc-telemetry.md`
- **S'appuie sur** : `ADR-0027` (source unique du temps de production) — **inchangé**

## Ce que ce module ajoute

La couche **appareil / session / dossier** qui manquait pour qu'une tablette d'atelier
remplace le dossier papier posé sur chaque machine.

## Ce que ce module n'ajoute PAS

Aucun moteur d'exécution. `production_pointages` (#274) reste la source de vérité unique
du temps, des quantités et des aléas. Ce module **lit** cet état et **pilote** ses
commandes existantes ; il n'en duplique aucune.

Un test le prouve : `POST /production/station`, `/pause`, `/resume`, `/stop` et
`/quantities` renvoient **404**.

## Fichiers

```
src/module/production/
├── domain/station.ts                              politiques pures, sans I/O
├── validators/station.validators.ts               Zod
├── repository/station.repository.ts               SQL, transactions, audit
├── services/station.service.ts                    orchestration
├── controllers/station.controller.ts              validation + délégation
├── routes/station.routes.ts                       montage et gardes
└── middlewares/station-authorization.middleware.ts session + capacités

src/sockets/sockeServer.ts                         autorisation des salons (corrigé)
src/routes/v1.routes.ts                            montage /production/station

db/patches/20260726_shopfloor_station_159.sql
db/patches/support/20260726_shopfloor_station_159.{preflight,verify,rollback}.sql

src/__tests__/shopfloor-station-159.{domain,routes,migration-guards}.test.ts
```

## Schéma

| Table | Rôle | Contrainte structurante |
| --- | --- | --- |
| `production_devices` | Tablettes d'atelier | `FIXED` ⇒ `machine_id` obligatoire (base) ; `REVOKED` définitif |
| `operator_badge_credentials` | Supports pseudonymisés | Empreinte `^[a-f0-9]{64}$` unique ; verrouillage après échecs |
| `operator_device_sessions` | Session de poste | **Une seule vivante par appareil** (index unique partiel) |
| `station_audit_events` | Journal appareil/session | **Append-only** (trigger) ; propriété `postgres` |
| `production_shift_handovers` | Transmission de poste | **Immuable** hors accusé de lecture (trigger) |
| `v_station_machine_occupancy` | Occupation machine | Vue dérivée de #274 |

Bornes serveur : `auto_lock_seconds` ∈ [30, 3600], `session_max_seconds` ∈ [300, 86400].
Une tablette ne négocie pas sa propre politique de sécurité.

### Pourquoi `station_audit_events` reste propriété de `postgres`

Un propriétaire peut supprimer ses propres triggers. Laisser `cerp_app` propriétaire d'un
journal append-only reviendrait à confier la serrure à celui qu'elle contraint. Même
règle que `erp_audit_logs` et `hr_time_events` : `cerp_app` n'a que `SELECT, INSERT`.

## Surface API

Voir `crp-systems-web/docs/architecture/shopfloor-operator-station-289.md` §3 pour le
tableau complet des routes et des capacités.

### Authentification — deux identités, jamais une troisième

| Famille | Identité | Vérification |
| --- | --- | --- |
| Routes de poste | **Session de poste** (`req.station`) | Jeton opaque → empreinte SHA-256 → ligne en base, **à chaque requête** |
| Routes d'administration | **JWT ERP** (`req.user`) | `authenticateToken` |

Le jeton de poste n'est **pas** un JWT. Un JWT n'est pas révocable ; une tablette volée
resterait valide jusqu'à expiration. Le prix payé — un aller-retour de base par appel —
est celui d'une révocation qui fonctionne vraiment, et la ligne était de toute façon
nécessaire pour porter la machine confirmée et l'état de l'appareil.

Transport : cookie `httpOnly; Secure; SameSite=None`, avec repli par en-tête
`X-Station-Session` quand un proxy supprime les cookies tiers.

## Configuration

| Variable | Obligatoire | Effet si absente |
| --- | --- | --- |
| `STATION_BADGE_PEPPER` | pour le badge | L'identification par badge est **refusée**, jamais dégradée en SHA-256 nu. Le bouton n'est même pas proposé. |

Le poivre doit faire au moins 16 caractères, être aléatoire, ne jamais être versionné, ni
journalisé, ni renvoyé. Le faire tourner invalide tous les supports émis : prévoir une
réémission.

## Application du patch

```bash
# 1) Sauvegarde
ssh … "sudo /usr/local/sbin/cerp-pg-backup.sh"

# 2) Preflight (lecture seule)
scp db/patches/20260726_shopfloor_station_159.sql \
    db/patches/support/20260726_shopfloor_station_159.{preflight,verify}.sql  …:/tmp/
ssh … "sudo -u postgres psql -d cerp_test -X -f /tmp/20260726_shopfloor_station_159.preflight.sql"

# 3) Application
ssh … "sudo -u postgres psql -d cerp_test -v ON_ERROR_STOP=1 -f /tmp/20260726_shopfloor_station_159.sql"

# 4) Enregistrement + verify
ssh … "sudo -u postgres psql -d cerp_test -c \"INSERT INTO public.cerp_schema_migrations(filename,sha256) VALUES('20260726_shopfloor_station_159.sql','<sha256>') ON CONFLICT DO NOTHING\""
ssh … "sudo -u postgres psql -d cerp_test -X -f /tmp/20260726_shopfloor_station_159.verify.sql"

# 5) STOP. cerp_prod uniquement après autorisation humaine explicite.
```

Résultat du 26 juillet 2026 sur `cerp_test` : appliqué, **rejoué sans erreur**,
`verify` **9/9**, dont la preuve sous le rôle `cerp_app` réel que
`station_audit_events` refuse `UPDATE` et `DELETE`, et qu'une tablette `FIXED` sans
machine est rejetée par la base. Aucune donnée de sonde persistée.

Le même patch a été appliqué sur `cerp_prod` à 20:09 le même jour, **hors de
l'intervention qui a produit ce lot**. Le `verify` y passe également **9/9**, propriétés
et droits `cerp_app` compris, et les cinq tables sont **vides**. Le schéma est donc en
avance sur le code — l'ordre normal d'un déploiement, sans effet tant que rien ne
l'interroge.

**Deux points de vigilance quand le code sera déployé :**

1. `STATION_BADGE_PEPPER` doit être provisionné **avant** que `/atelier` soit
   atteignable, sinon l'identification par badge est refusée ;
2. la correction d'autorisation des salons Socket.IO voyage **avec le code**, pas avec le
   patch : tant que le backend n'est pas déployé, `room:join` reste permissif en
   production.

SHA-256 du patch : `5425761780d1950f71585e6a160e879457444fa000e7931e9290654a3280d43a`

## Rollback

`db/patches/support/20260726_shopfloor_station_159.rollback.sql` — **destructif**, refuse
`cerp_prod`, et refuse de s'exécuter dès qu'une session, une transmission, un support ou
un événement d'audit réel existe. Un rollback qui efface l'historique d'un atelier n'est
pas un rollback.

## Tests

| Suite | Cas |
| --- | ---: |
| `shopfloor-station-159.domain.test.ts` | 63 |
| `shopfloor-station-159.routes.test.ts` | 51 |
| `shopfloor-station-159.migration-guards.test.ts` | 21 |
| **Suite complète** | **2 609 verts** |

Frontières vérifiées par test sur les requêtes SQL réellement émises pendant un parcours
complet : aucune écriture vers `hr_*`, `stock_movements`, `stock_reservations`, `lots`,
`bons_livraison`, `factures`, ni vers `production_pointages` /
`production_quantity_declarations` (qui restent pilotées par #274 seul).

## Limites connues

- **Recette contre données réelles impossible** : `cerp_test` et `cerp_prod` contiennent
  tous deux 0 machine et 0 ordre de fabrication.
- **Anti-rejeu QR non branché** : `assertNonceFresh()` est écrit et testé, le registre de
  nonces serveur reste à faire. Le mode QR est aujourd'hui équivalent au badge.
- **Attestation d'appareil non exploitée** : `enrollment_secret_hash` est en base, aucun
  flux ne l'utilise. L'autorisation vient exclusivement de la session utilisateur.
- **Aucune purge de rétention** : durées proposées dans
  `crp-systems-web/docs/gdpr/shopfloor-station-289.md`, à arbitrer avec le DPO.
- **Aucune intégration machine** : voir `ADR-0031`. Aucun connecteur, aucune simulation.
