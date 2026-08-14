# Rapport d'exécution — SOL-26

- Date : 2026-08-14
- Issue backend : https://github.com/BigFootLime/erp-crp-backend/issues/473
- Branche de travail : `feature/473-sol26-einvoice`
- Référence de départ : `origin/main` au moment de la création du worktree
- Statut fonctionnel : socle fusionnable ; activation PA externe volontairement bloquée

## Diagnostic et cause racine

Le produit possédait des factures légalement figées et un état ADV interne
`READY_FOR_CONNECTOR`, mais aucun connecteur, stockage de preuve, cycle de vie
externe ou fournisseur réellement choisi. La cause n'était pas une panne d'API :
aucune Plateforme Agréée, aucun contrat, aucun certificat et aucun compte sandbox
n'existent dans le périmètre fourni. Une implémentation spécifique ou un test de
succès externe aurait donc fabriqué une réalité réglementaire.

## Choix d'architecture

Le socle est fournisseur-indépendant et échoue fermé. Un registre charge uniquement
des adaptateurs présents dans le binaire ; SQL doit en plus désigner une connexion
du même environnement, explicitement qualifiée et activée. Aucun adaptateur n'est
enregistré dans cette livraison. Les formats admis sont UBL, CII et Factur-X ; le
cycle de vie est limité aux codes officiels DGFiP 200 à 213.

La commande de dépôt est idempotente par acteur, clé et empreinte de requête. La
file utilise `FOR UPDATE SKIP LOCKED`, un claim expirant et la clé prestataire stable
`cerp-einvoice-<UUID>`. Les erreurs transitoires et limites suivent un backoff borné ;
les erreurs permanentes s'arrêtent avec message actionnable et expurgé. Webhooks et
rapprochements sont dédupliqués par identifiant+empreinte. Le webhook public conserve
les octets signés, exige la validation de l'adaptateur et passe par le rate limit
PostgreSQL distribué.

Référence détaillée : `docs/adr/ADR-0072-electronic-invoicing-provider-boundary.md`.

## Fichiers modifiés

- domaine, registre, service, repository, contrôleurs, validateurs et routes :
  `src/module/facturation/electronic-invoicing/` ;
- montage public signé et capture ciblée du corps brut : `src/routes/v1.routes.ts`,
  `src/config/app.ts`, `src/middlewares/requestId.ts` ;
- worker et arrêt propre : `src/index.ts` ;
- RBAC finance : `src/module/facturation/domain/finance-policy.ts` ;
- endpoints facture : `src/module/facturation/routes/factures.routes.ts` ;
- readiness ADV dynamique : `src/module/adv-reliability/repository/adv-reliability.repository.ts` ;
- rate limit distribué : `src/config/auth-rate-limit.ts` et middleware auth associé ;
- migration/support : `db/patches/20260814_electronic_invoicing_sol26.sql` et
  `db/patches/support/20260814_electronic_invoicing_sol26.*.sql` ;
- répétition/rollback : `scripts/migrations/release-gate.js` ;
- tests : domaine, worker, routes, RBAC et rate limit ;
- opérations : ADR-0072, runbook SOL-26 et preuves de répétition sous
  `docs/release/sol26-rehearsal/`.

## Migration et changements de données

Le patch crée cinq tables additives : connexions, documents normalisés, tentatives,
événements prestataire et reçus d'idempotence. Il ajoute des contraintes de format,
empreinte, statut, unicité et cohérence, ainsi que des triggers append-only sur les
preuves. Les contenus XML/PDF, pièces jointes et secrets ne sont pas stockés en SQL.

Aucune ligne prestataire n'est créée : il n'existe pas de PA qualifiée à enregistrer.
L'ancien binaire ignore les objets. La répétition a appliqué 17 patches sur une base
PostgreSQL 16 jetable issue du bootstrap réaliste, puis a validé le rejeu à zéro,
le rollback test-only et la restauration du dump. Empreinte source/restaurée :
`9c0e994251c8898b13f9fb106c7675a1fdccd5b98cb5f1a436cf9c2a409b97dc`.

La première tentative opérateur réelle a été arrêtée avant écriture : le patch
n'était pas encore inscrit dans la liste `--only` immuable de `db-patches.js`.
Le correctif `6510713` enregistre son SHA-256 canonique LF
`03da2f92e7c99e1ffe437fb5443517585a9c20765322d85ab0cb83e378f7968e`
et ajoute une garde de régression. Il a été promu par les PR #476 puis #477 ;
la `main` backend fonctionnelle correspondante est `84ed905f4f94b64d1d6b22b548597b65674f288e`.

Sur HYPERBOX2, les preflights PostgreSQL 17.10 ont réussi sur `cerp_test`
(146 MB) et `cerp_prod` (102 MB). Deux sauvegardes custom, catalogues lisibles
et permissions `0600 root:root`, ont précédé les écritures :

| Base | Sauvegarde | Taille | SHA-256 |
|---|---|---:|---|
| `cerp_test` | `/var/backups/cerp/cerp_test_pre_sol26_20260814-163137.dump` | 72 972 417 octets | `176e6fe78feb125ca9f5d756e47f87a093bb1e3dcd439950ea100f4818017de7` |
| `cerp_prod` | `/var/backups/cerp/cerp_prod_pre_sol26_20260814-163137.dump` | 49 501 647 octets | `7ed98ad63fbf51dcf7a2c17efc425a9320582aac0b9154edab7bece54ff86ca9` |

Le dry-run immuable a sélectionné exactement un patch. L'application a duré
0,09 s sur chaque base. Le post-contrôle confirme cinq tables, zéro statut,
empreinte ou événement invalide, zéro connecteur configuré et zéro divergence de
checksum. Le rejeu a appliqué zéro patch. États du registre après SOL-26 :
`cerp_test` 137 appliqués / 20 historiques en attente ; `cerp_prod` 133 appliqués /
24 historiques en attente. Ces autres patches restent hors périmètre SOL-26.

## Tests et résultats réels

| Commande/scénario | Résultat |
|---|---|
| `pnpm typecheck` | PASS |
| ciblés SOL-26 + RBAC | PASS — 136 tests |
| ciblés rate limit final | PASS — 26 tests |
| suite complète `vitest run` | PASS — 4 656 réussis, 4 ignorés, 0 échec |
| `pnpm build` | PASS — frontière données production validée |
| `pnpm db:migrations:rehearse` | PASS — backup, preflight, 17 patches, verify, replay 0, rollback, restore |
| gate `db-patches --only` | PASS — 23/23 après correction de la sélection immuable |

Preuve humaine et machine :
`docs/release/sol26-rehearsal/MIGRATION_REHEARSAL_SOL_06.md` et `.json`.

## Vérification navigateur/E2E

Le frontend exécute deux scénarios Playwright Chromium sur build de production et
API interceptée au niveau contrat : PA absente explicitement indisponible sans
bouton d'envoi ; PA qualifiée avec POST UBL, clé `Idempotency-Key`, invalidation et
lecture du document persistant. Résultat : 2/2 PASS, 32,0 s. Le panneau possède en
plus 3 tests composants PASS.

Un E2E contre le sandbox réel d'une PA n'a pas été exécuté : aucun fournisseur ni
credential n'existe. Ce manque n'est pas masqué par un mock et interdit l'activation.

## Promotion et vérification déployée

Le socle a été intégré par la PR #474 (`dev` `dba5c75`) puis promu par la PR
#475 (`main` `4ca5d94`). Le correctif du gate migration a suivi par #476
(`dev` `92dbdc1`) et #477 (`main` `84ed905`). Les branches locales officielles
ont été avancées en fast-forward et vérifiées à `0/0` de leurs références distantes.

HYPERBOX2 exécute l'artefact immuable `/srv/cerp/releases/20260814-84ed905f`
sur `cerp-api-test` et `cerp-api`. Les deux services sont actifs, publient le SHA
complet et retournent readiness `200` avec PostgreSQL, GED, ClamAV et temps réel
`up`. La route e-invoicing anonyme retourne `401`; aucun warning n'est présent
dans les journaux depuis les redémarrages.

Le premier webhook Coolify a livré le socle fonctionnel `4ca5d94` et l'a déclaré
healthy. Le contrôle public retourne live/readiness `200`, les quatre dépendances
`up`, l'origine CORS exacte `https://cerp.croix-rousse-precision.fr`, et `401`
pour l'accès anonyme. La promotion documentaire/corrective suivante doit faire
converger le SHA Coolify sans modifier le comportement du connecteur.

## Risques et compatibilité

- P0 externe : sélectionner et contractualiser une PA officielle.
- P0 avant activation : écrire l'adaptateur spécifique, fournir certificats/secrets
  sandbox, valider XSD/règles DGFiP et exécuter la matrice de qualification de l'ADR.
- Le schéma applicatif ne fournit pas de dimension société/site exploitable sur la
  facture ; aucune isolation multi-société fictive n'est revendiquée.
- Le rate limit protège la charge mais ne remplace ni signature, ni mTLS, ni liste
  réseau éventuellement exigée par la PA.
- Les dates réglementaires et la version V3.2 doivent être revérifiées avant mise
  en production du connecteur spécifique.

## Rollback

Le rollback normal désactive la connexion puis redéploie le SHA précédent en
conservant toutes les preuves. Le script SQL refuse une base non test et refuse
toute suppression si un document électronique existe. En production, restaurer la
sauvegarde pré-migration dans une base neuve, vérifier comptages/empreintes, puis
promouvoir explicitement cette base. Voir le runbook
`docs/runbooks/electronic-invoicing-provider-sol26.md`.

## Reste réellement à faire

1. Keenan Martin choisit la PA et fournit un compte sandbox.
2. Implémenter puis qualifier l'adaptateur de cette PA sur émission, réception,
   avoir, pièces jointes, doublons, rejets, timeout après commit et webhooks.
3. Réaliser la revue sécurité/DPD et la rotation des certificats/secrets.
4. Activer sandbox, signer la preuve métier, puis seulement planifier production.

La configuration Project Office n'était pas disponible dans cet environnement ;
les issues GitHub ci-dessus et ce rapport constituent la traçabilité de reprise.
