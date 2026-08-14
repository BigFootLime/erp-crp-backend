# ADR-0067 — Frontière planning, capacité et exécution atelier

- Statut : accepté
- Date : 2026-08-14
- Décideur technique : CERP+
- Contrat : `CERP-PRODUCTION-PLANNING-1.0.0`
- Issue : https://github.com/BigFootLime/crp-systems-web/issues/638

## Contexte

Le planning possédait les créneaux prévus et l'atelier les pointages constatés,
mais aucun contrat commun ne qualifiait le respect du planning, le WIP, le rebut,
les arrêts ou la capacité. Les couleurs client restaient locales au navigateur et
la file atelier ne distinguait pas suffisamment le travail déjà engagé du prochain
ordre réellement prêt. Une absence de calendrier, de temps ou d'unité pouvait
donc être interprétée à tort comme une valeur nulle.

## Décision

- `planning_events` et `of_operations` portent le prévu ;
  `production_pointages` et `production_quantity_declarations` portent le réel.
  `of_time_logs` reste un adaptateur de compatibilité, jamais une seconde vérité.
- Chaque KPI publie définition, unité, période, sources, fraîcheur, fiabilité et
  éléments manquants. Une donnée absente produit `null`, `PARTIAL` ou
  `UNAVAILABLE`, jamais un zéro de remplissage.
- Le respect du planning rapporte les opérations distinctes terminées avant la fin
  de leur créneau aux opérations distinctes arrivées à échéance. Le débit compte
  les opérations terminées. Le WIP compte les OF non terminés ayant une opération
  ou un pointage en cours. Le WIP âgé utilise le premier démarrage traçable.
- Le rebut est calculé uniquement sur une unité homogène : rebut / (bon + rebut),
  après compensations. Une unité absente ou plusieurs unités empêchent le taux
  global.
- La capacité hebdomadaire vient du calendrier actif, diminué des fermetures et
  indisponibilités machine. Zéro ou plusieurs calendriers actifs rendent la cellule
  indisponible. La charge est explicable par un drill-down jusqu'aux OF.
- Les seuils de lecture sont : chargé à partir de 80 %, surcharge au-dessus de
  100 %, goulot au-dessus de 120 % ou charge positive sans capacité disponible.
- Les conflits sont calculés côté serveur : ressource indisponible, chevauchement
  explicitement forcé, ressource réelle différente, pointage ouvert plus de 12 h
  et temps prévu manquant. Chaque conflit fournit cause, gravité et prochaine action.
- Les préférences et couleurs sont persistées par utilisateur, validées côté
  serveur, auditées et protégées contre les mises à jour concurrentes. Le stockage
  navigateur n'est qu'un cache.
- La file atelier place d'abord l'exécution en cours, puis les opérations prêtes,
  les saisies en attente et les blocages. Le même identifiant canonique sert au
  texte, au QR code et au code-barres CODE128.
- La file hors ligne existante reste l'unique moteur : stockage IndexedDB chiffré,
  clé d'idempotence stable, horodatage client, reprise ordonnée, revalidation de
  session, conflit explicite et état de synchronisation visible.
- Les rôles opérateur, superviseur et planificateur sont contrôlés dans l'API en
  plus du droit de module. Un simple accès générique au module n'élève pas un
  opérateur vers la lecture de capacité.

## Conséquences

Le cockpit fonctionnel peut expliquer toute valeur et remonter jusqu'aux OF sans
devenir une seconde interface de saisie. Le poste atelier sait distinguer encours,
prochain travail, blocage et saisie à synchroniser. Les calendriers réels restent
un prérequis métier : le système signale leur absence au lieu d'inventer une
capacité.

## Migration et retour arrière

La migration est additive : table `planning_user_preferences`, fonction de
validation des couleurs, contrainte de provenance étendue à `OFFLINE_STATION` et
privilège de lecture minimal sur `machines` pour la vue d'occupation du rôle
applicatif. Elle n'insère aucune valeur métier.

L'ancien backend ignore la table additive. Le rollback destructif exige d'abord
l'export explicite des préférences ; il ne réécrit ni pointage ni planning. Après
usage réel, le retour sûr consiste à redéployer les artefacts précédents en
conservant le schéma. Toute suppression de données exige un gel des écritures et
la restauration vérifiée du dump pré-migration dans une nouvelle base.
