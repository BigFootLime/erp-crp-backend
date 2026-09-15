# Apprentissage des durées — #965 / backend #717

Implémentation locale du 15 septembre 2026, branche `feature/965-duration-learning`.
Le backend reste propriétaire des mesures et des estimations. Le frontend affiche
les résultats et appelle les commandes auditées. Aucun service d’IA externe.

## Périmètre et calcul

Une observation représente une fabrication terminée, sur une opération et un contexte
exact : pièce, version technique figée, phase, machine physique, configuration.
Le temps de fabrication est l’union des intervalles machine productifs : les
opérateurs simultanés ne multiplient pas le temps. Le réglage est mesuré séparément ;
un réglage absent reste inconnu. Les catégories sont figées à la saisie.

Les pointages doivent être fermés et validés. Les attentes, pauses, contrôles et
autres activités non productives ne nourrissent pas la cadence. Les contextes mixtes,
historiques non attribuables, chevauchements réglage/fabrication, reprises et quantités
en attente de contrôle sont exclus avec un motif. Les compensations sont signées.
Une quantité liée à un pointage annulé exige une réconciliation avant réutilisation.
Les liens explicites de correction sont suivis ; un prédécesseur de session ne suffit pas.

La politique `cerp-duration-v2` conserve les vingt dernières observations éligibles
du contexte, hors opération évaluée. La médiane des minutes par pièce est pondérée
avec la gamme par `n/(n+5)`. Les réglages ont leur propre effectif. La confiance
est initiale sans historique, limitée de 1 à 9, consolidée à partir de 10.
Les segments courants fermés avec quantités directement attribuables peuvent ajuster
provisoirement le restant, avec un poids `q/(q+10)`. Ils ne deviennent pas pour autant
des observations historiques validées.

## Flux et cohérence

`pointages / déclarations / opération → invalidation transactionnelle → file dédiée
→ observation remplaçable → lecture groupée → estimation → prévision`.

La migration additive `20260915_duration_learning_965.sql` crée la file durable,
les métadonnées de provenance et le lien explicite de correction. Les mutations
invalident immédiatement les anciennes contributions et changent la révision centrale.
Le consommateur traite au plus 100 opérations toutes les 15 secondes ; verrou
transactionnel, reprise après panne, source hash et UPSERT empêchent le double comptage.
Sa file est distincte de celle des prévisions. Les GET ne reconstruisent ni ne persistent
les observations. Les lectures regroupent les tâches et ressources, sans un aller-retour
historique par tâche. Chaque machine candidate reçoit son estimation propre.

L’activation `LEARN` existante pilote l’utilisation de l’historique. Le worker de
prévision existant (et son activation du workflow matière) traite ensuite les projections.
La gamme, les affectations et les créneaux engagés restent sous les commandes existantes.
Une simulation fondée sur une ancienne révision est refusée.

## Corrections et API

- `GET /planning/v2/operations/:operationId/observations?offset=0&limit=20` :
  droit planning en lecture, pagination, sources, exclusions, échantillon retenu.
- `POST /production/execution/:id/correct` : droit `correct`, motif, patch et
  `expected_updated_at` facultatif pour compatibilité. Le nouveau frontend transmet
  cette version et une clé d’idempotence. Original conservé, nouvelle version non validée.
- L’annulation supervisée d’un pointage validé conserve ses horaires et sa validation
  initiale pour l’audit ; son statut annule sa contribution. Réessai sans double événement.
- `POST /production/execution/quantities/:id/compensate` : droit `correct`,
  `Idempotency-Key` obligatoire, corps `{reason}`. Déclaration inverse, jamais de
  suppression. Une réception, un débit matière, un contrôle qualité déjà créé, un
  transfert libéré, une opération aval commencée ou une non-conformité associée
  bloquent la compensation. La réconciliation aval suit son circuit.

Les droits existants, la séparation saisie/validation et le journal restent applicables.
Les observations ne recopient pas les identités des opérateurs ; leurs identifiants
de sources conservent la traçabilité sous les droits du module.

## Reprise et exploitation

1. Sauvegarder la base cible et vérifier la restauration selon le runbook de l’environnement.
   Aucune sauvegarde ni migration de production n’a été exécutée pour cette livraison locale.
2. Exécuter le preflight, puis `node scripts/db-patches.js up --only 20260915_duration_learning_965.sql --dry-run`.
   Appliquer cette même sélection sans `--dry-run`, puis exécuter verify. Le runner
   contrôle l’empreinte immuable et l’inventaire ; le verrou SQL expire après dix secondes.
3. Après build backend, utiliser `node dist/module/planning/cli/duration-learning.js --limit 100`.
   Par défaut, le programme analyse sans écrire et détaille les motifs d’exclusion.
4. Ajouter `--apply --run` pour mettre la page en file et traiter un lot. Continuer avec
   `--after <nextCursor>` jusqu’à `hasMore=false`. Le curseur n’est annoncé qu’après succès.
   Réexécuter une page est sûr. Le worker normal traite aussi les éléments restants.
5. Lire `--status` : date, file restante, plus ancien élément, erreurs, effectif traité et précision.
6. Activer `LEARN` selon le circuit d’administration existant après recette. En cas de
   problème, le rollback fonctionnel repasse en `EXECUTE`, conserve toutes les données
   et remet les prévisions en file.

La première prévision faite avant tout pointage est figée pour mesurer les erreurs
futures. Le rapport compare la médiane de l’erreur unitaire de l’estimation et celle
de la gamme, sur les mêmes opérations terminées et comparables. Un effectif nul
signifie « pas encore mesurable », jamais une erreur nulle. L’historique repris ne
sert pas à prétendre mesurer une amélioration passée.

## Validation locale

Tests de domaine : intervalles, réglages, quantités signées, contexte, filiation,
mesures provisoires. PostgreSQL isolé : apprentissage, corrections concurrentes,
revalidation, annulation, compensation, rollback d’un lot en erreur, reprise,
simulations périmées et prévision figée avant exécution.

Les scripts SQL preflight/verify/rollback sont sous `db/patches/support/`.
Les preuves finales frontend/backend et la recette visuelle figurent dans
le compte rendu frontend `docs/task-reports/duration-learning-965.md`.
