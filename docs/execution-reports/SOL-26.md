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

## Tests et résultats réels

| Commande/scénario | Résultat |
|---|---|
| `pnpm typecheck` | PASS |
| ciblés SOL-26 + RBAC | PASS — 136 tests |
| ciblés rate limit final | PASS — 26 tests |
| suite complète `vitest run` | PASS — 4 656 réussis, 4 ignorés, 0 échec |
| `pnpm build` | PASS — frontière données production validée |
| `pnpm db:migrations:rehearse` | PASS — backup, preflight, 17 patches, verify, replay 0, rollback, restore |

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
