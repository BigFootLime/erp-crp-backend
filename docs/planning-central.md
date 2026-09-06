# Planning central — première publication (#717)

L’API `/planning/v2` lit les opérations canoniques, conserve les commandes avec pièce brouillon et propose des créneaux avant validation. Les commandes de simulation/application sont transactionnelles, versionnées, idempotentes et soumises aux droits existants. Un pointage ou une modification de ressource invalide un aperçu devenu ancien.

Le calcul reprend l’ordre des phases de gamme en l’absence de dépendance explicite. Il choisit une machine qualifiée selon priorité, échéance, ancienneté puis identifiant stable. Machines et postes liés partagent la capacité. Les absences et événements de maintenance sont soustraits aux calendriers. Une affectation de calendrier explicite prime ; à défaut, le calendrier atelier actif est repris uniquement s’il est unique. Aucun horaire n’est inventé lorsqu’il manque.

Cette publication couvre les vues et la planification validée. Les écritures de couverture future, les modifications des réceptions/contrôles qualité et l’apprentissage continu restent hors de ce lot. La réponse indique `coverageAvailable: false` et ne publie pas une projection inachevée. Le moteur statistique pur reste testé mais non raccordé aux observations canoniques. Ne pas activer `EXECUTE` ou `LEARN` pour cette livraison.

## Mise en service et récupération

Avant migration : sauvegarde locale atelier, intégrité du dump, lecture des scripts `db/patches/support/20260906_planning*.preflight.sql` et contrôle de la base sélectionnée. Appliquer les trois patches dans l’ordre central, batch_constraints, resource_invalidation avec `node scripts/db-patches.js up --only <nom-exact.sql>` (d’abord `--dry-run`). Le runner vérifie les empreintes immuables, conserve le verrou et enregistre chaque patch avec son empreinte dans la même transaction ; exécuter ensuite les scripts `verify.sql`. Ne pas appliquer les autres patches en attente dans cette fenêtre. L’activation reste `OBSERVE` par défaut. Après déploiement et contrôle authentifié de la nouvelle API, progresser vers `READ`, `SIMULATE`, puis `COMMIT`.

Récupération : revenir à `OBSERVE` et redéployer les deux artefacts précédents identifiés par SHA. Les créneaux canoniques et les métadonnées sont conservés. Aucun retour arrière SQL destructif n’est requis. Une restauration complète de données reste une opération distincte à autoriser.

## Validation

Le contrôle de release a détecté les avis [fast-uri](https://github.com/advisories/GHSA-5jgf-p345-68v8) et, côté frontend, [Browserslist](https://github.com/advisories/GHSA-c83g-rgw3-j3cx). Les résolutions transitives utilisent respectivement 3.1.6 et 4.28.7, avec verrouillage pnpm ; le seuil de sécurité du contrôle reste inchangé.

Tests du calendrier civil, du choix qualifié, des dépendances, de la capacité partagée, de l’idempotence, de la concurrence et de la conservation des engagements. La recette PostgreSQL locale utilise uniquement une instance jetable explicitement identifiée ; le contrôle de release complet reste exigé avant publication.
