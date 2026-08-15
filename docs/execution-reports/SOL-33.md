# SOL-33 — Centre des données de référence

- Date d'exécution : 2026-08-15 (Europe/Paris)
- Propriétaire : Keenan Martin
- Issues : backend `#529`, frontend `#737`
- Branche backend : `feature/529-reference-data-center`
- Branche frontend : `feature/737-reference-data-center`

## Diagnostic et cause racine

Les valeurs critiques existaient dans leurs domaines, mais leur gouvernance
était fragmentée : écrans et APIs séparés, comparaison non uniforme, pas de
file commune d'approbation, et aucune empreinte empêchant d'appliquer une
proposition devenue obsolète. Les snapshots métiers étaient parfois confondus
avec des paramètres maîtres.

La solution conserve chaque source canonique et ajoute un plan de contrôle
commun. L'ADR-0079 et `docs/release/REFERENCE_DATA_GOVERNANCE.md` consignent la
frontière, les propriétaires et l'inventaire des valeurs dispersées.

## Changements livrés

- migration additive SOL-33 avec propositions, versions immuables et décisions
  append-only ;
- preflight, post-vérification et rollback gardé ;
- API `/api/v1/admin/reference-data` : capacités, catalogue, détail, comparaison,
  import/export, proposition, décision et application ;
- RBAC serveur, quatre yeux, idempotence et contrôle de concurrence SHA-256 ;
- validation des unités, conversions, dates, chevauchements, calendriers,
  dépendances et doublons ;
- interface fonctionnelle Administration → Données de référence, sans retouche
  graphique finale ;
- tests unitaires, intégration DB, RBAC, contrats frontend et migration.

## Migrations et données

Le patch `20260815_reference_data_center_sol33.sql` est additif. Il ne crée et ne
modifie aucune valeur métier. La répétition isolée a migré une base complète de
140 à 163 patches, puis rejoué zéro patch. La sauvegarde/restauration du banc a
réussi. Une répétition d'intégration supplémentaire a appliqué le patch, chargé
le seed déterministe et exécuté le workflow quatre yeux sur une base jetable.

Le premier essai global a révélé que le preflight référençait l'ancien nom
`audit_logs`. Il a été corrigé vers `erp_audit_logs`, puis toute la répétition a
réussi. Le SHA-256 canonique du patch est enregistré dans le runner immuable.

## Tests exécutés avant promotion

- backend typecheck : réussi ;
- suite backend complète : 1 048 suites, 4 761 tests réussis, 8 tests
  d'intégration explicitement ignorés hors environnement isolé, zéro échec ;
- tests ciblés SOL-33 + runner : 28 réussis ;
- intégration PostgreSQL isolée : 2 réussis, incluant rejeu idempotent,
  auto-approbation refusée, application transactionnelle et source concurrente
  refusée ; après ajout du contrôle de dépendance, répétition sur une base neuve :
  3 réussis, dont l'unité inconnue refusée avant proposition ;
- répétition migrations : réussie, restauration réussie, rejeu sûr ;
- build backend : réussi, 1 069 opérations OpenAPI inventoriées à 100 %, contrat
  valide et 737 fichiers source/émis conformes à la frontière production ;
- frontend typecheck et lint : réussis ;
- suite frontend complète après correctifs : 298 fichiers et 2 508 tests
  réussis en 93,80 s ;
- build frontend : réussi, 11 887 modules sur la pile E2E et frontière production
  validée ; les avertissements de taille des chunks sont préexistants ;
- Playwright isolé : 1 scénario réussi en 6,3 s. Il couvre rendu administrateur,
  source/fiabilité, validation de dépendance en 422, responsive desktop/tablette
  et refus 403 d'un utilisateur standard.

Le premier passage Playwright a échoué sur un sélecteur ambigu qui trouvait le
même titre dans la carte et le panneau ; la capture montrait l'écran correct.
Le sélecteur a été resserré sur le rôle de titre, puis le scénario a réussi sur
une base jetable neuve. Aucun timeout ni assertion métier n'a été assoupli.

Les promotions et déploiements réels seront ajoutés au même rapport après leur
exécution ; ils ne sont pas déclarés réussis par anticipation.

## Risques, compatibilité et rollback

Les consommateurs existants restent compatibles car aucune source canonique
n'est déplacée. Les anciennes lignes et snapshots ne sont pas recalculés. Les
tables spécialisées SOL-13/SOL-19 sont affichées comme indisponibles si leur
patch historique n'est pas encore présent sur une instance.

Avant toute preuve SOL-33, le rollback SQL peut supprimer les objets ajoutés.
Dès qu'une proposition ou décision existe, le script refuse et impose la
restauration du dump pré-migration dans une base neuve. Un rollback applicatif
peut redéployer le SHA précédent tout en conservant les tables additives.

## Reste réellement à faire

- promouvoir les deux dépôts vers `dev` puis `main` ;
- sauvegarder, appliquer avec `--only` et vérifier le patch sur `cerp_test` puis
  `cerp_prod` ;
- redéployer et vérifier Coolify et HYPERBOX2 ;
- compléter ce rapport avec les SHA, sauvegardes et preuves live exactes.
