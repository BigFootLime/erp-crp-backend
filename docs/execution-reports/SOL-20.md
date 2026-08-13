# SOL-20 — Outillage, pièces techniques et GED (backend)

- Date : 2026-08-13
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/438
- Branche : `feature/438-sol20-tooling-technical-ged`
- Base initiale : `origin/main` (`6824f9587d13e4b60abdfbc1fef6dc81a3a474f0`)
- ADR : `docs/adr/ADR-0066-tooling-technical-ged-boundary.md`

## Diagnostic et cause racine

Les routes historiques `/sortie` et `/retour` modifiaient seulement le stock. Elles
ne rattachaient pas obligatoirement la consommation à une pièce, un indice et un
OF, n'avaient ni réservation, casse/usure, idempotence ni historique de cycle. Le
résumé ne pouvait donc pas produire de disponibilité active fiable. Le dossier
technique et la GED centrale étaient solides, mais non rapprochés : un composant
existant ne prouvait ni complétude ni verdict antivirus exploitable.

## Choix d'architecture et résultat

- machine d'états serveur pour réservation, sortie, retour, casse, usure et
  libération, avec verrou de stock, transaction, audit, outbox et idempotence ;
- refus d'une nouvelle sortie sur indice obsolète/non courant, sans empêcher le
  retour d'une sortie antérieure ;
- exigences d'outil immuables dès publication de l'indice ;
- snapshots datés du coût, de la devise, de la source, de la fraîcheur, de la
  fiabilité et de la durée de vie ;
- disponibilité, consommation, durée observée et coût/pièce sans zéro fabriqué ;
- matrice de complétude serveur : indice, plan GED propre, gamme, contrôle,
  matière, outillage et documents obligatoires ;
- réutilisation des statuts antivirus/quarantaine SOL-11 et des versions GED ;
- RBAC serveur combinant droit de module et rôle, y compris cas négatif standard.

## Fichiers modifiés

- `src/module/outils/domain/outillage-lifecycle.ts` ;
- `src/module/outils/validators/outillage-lifecycle.validators.ts` ;
- `src/module/outils/repository/outillage-lifecycle.repository.ts` ;
- `src/module/outils/controllers/outillage-lifecycle.controller.ts` ;
- routes Outillage et Pièces techniques ;
- tests domaine et gardes de migration SOL-20 ;
- seed E2E isolé avec pièce, indices, gamme, contrôle, outil, OF et GED propre ;
- patch, preflight, verify et rollback SOL-20 ;
- runner de répétition enrichi d'une preuve de retrait des objets SOL-20 ;
- ADR-0066, runbook opérateur et présent rapport.

## Migration et changements de données

Migration additive : quatre tables (`outillage_tool_parameter_versions`,
`piece_version_tool_requirements`, `outillage_allocations`,
`outillage_lifecycle_events`), trois colonnes d'identité outil et six colonnes
d'audit de mouvement. Aucune ligne métier ni verdict documentaire n'est créé.
Les événements sont append-only, les périodes de paramètre ne peuvent se chevaucher
et les liens GED canoniques sont validés.

Répétition PostgreSQL 16.14 jetable finale :

- état réaliste : 140 patchs appliqués, 11 attendus, 0 checksum divergent ;
- sauvegarde : 1 954 052 octets, SHA-256
  `7dd8de175577c5d04a1f62cdea190ec53a4b4b5f4b9405ec35ee2a2e1a6c86a4` ;
- migration : 349 ms ; verify bloquant : 157 ms ; rejeu zéro : 117 ms ;
- rollback test-only : 165 ms, objets SOL-20 explicitement absents ;
- restauration : 3 905 ms, comptages identiques ;
- après migration : 151 patchs, 0 attendu ; environnement tmpfs détruit.

Aucune base HYPERBOX2/Coolify/production n'a été lue ni écrite.

## Tests exécutés et résultats

| Contrôle | Résultat réel |
|---|---|
| tests domaine + gardes SOL-20 | PASS — 11 tests |
| suite backend Vitest complète | PASS — 941 suites, 4 546 réussis, 4 ignorés, 0 échec, 24,58 s |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS — frontière production, 660 sources + 660 fichiers émis |
| `pnpm audit --audit-level high` | PASS — aucune vulnérabilité connue |
| `pnpm db:migrations:rehearse` | PASS — backup, preflight, migration, verify, replay, rollback SOL-20, restore |
| Playwright inter-dépôts isolé | PASS — 2/2 en Chromium, 7,4 s |

Le backend ne possède pas de script lint déclaré ; typecheck, build et tests sont
les contrôles disponibles. Le build frontend émet des avertissements de chunks
historiques supérieurs à 500 kB, sans lien avec SOL-20.

## Vérification navigateur/E2E

Playwright a compilé les deux applications, créé PostgreSQL et la GED jetables,
appliqué les 151 migrations et chargé sept utilisateurs. Il a vérifié dossier
complet, plan propre, retry de réservation sans doublon, refus d'un indice
obsolète, sortie, usure, retour, historique, disponibilité, durée observée,
coût/pièce et ses preuves. Un utilisateur standard reçoit `403`. Le premier run a
révélé une syntaxe SQL incorrecte dans l'agrégat de fraîcheur ; la requête a été
corrigée puis le scénario complet a été rejoué sans assouplissement métier.

Après rebase sur la nouvelle `main`, le rehearsal a aussi révélé que le seed Qualité
tentait d'utiliser son schéma v0437 avant l'application du patch correspondant. Le
seed vérifie désormais la présence de la colonne versionnée et reste compatible
avec l'état pré-migration comme avec l'état courant.

La suite complète a ensuite détecté un second défaut connexe de cette même `main` :
l'image Docker épinglait ClamAV `1.4.6-r0`, tandis que le contrat et la documentation
attendaient encore `1.4.5-r0`. Test et documentation ont été alignés sur l'image,
puis les 4 550 tests ont été rejoués avec zéro échec.

## Risques, compatibilité et travail restant

- les anciens mouvements ne peuvent pas être rétroactivement reliés à une pièce,
  un indice ou un OF : ils restent historiques, sans fiabilité SOL-20 ;
- l'isolation société/site reste celle de la base, faute d'axe tenant commun dans
  le modèle Outillage existant ;
- les outils sans ligne de stock ou paramètres datés affichent `indisponible` ; le
  responsable référentiel doit les compléter avant la première réservation ;
- l'E2E couvre un verdict GED `clean`. Les autres verdicts restent protégés par la
  suite SOL-11 centrale, réutilisée sans duplication ;
- la migration de production reste à exécuter dans une fenêtre autorisée selon le
  runbook, après sauvegarde DB + GED vérifiée.

## Rollback

Avant toute preuve, le rollback support retire les quatre tables, triggers et
fonctions SOL-20. Après une ligne métier, il refuse la perte. Redéployer alors
l'ancien backend, qui ignore les objets additifs. Pour retirer le schéma : geler
les écritures, restaurer le dump pré-migration dans une nouvelle base, vérifier
checksum/comptages et cohérence GED, puis promouvoir explicitement cette base.
