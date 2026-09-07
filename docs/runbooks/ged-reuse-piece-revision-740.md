# Réutiliser un plan entre révisions d’une pièce

Une pièce peut recevoir une nouvelle révision interne sans changement de plan. Redéposer les mêmes octets rencontre alors la déduplication GED. Le parcours de réutilisation rattache explicitement le document existant à la nouvelle révision, sans fichier, version ou approbation supplémentaire.

`GET /api/v1/ged/piece-revisions/:revisionId/reusable-documents` propose au maximum les 100 plans récents de cette même pièce (classes PLAN_CLIENT et GAMME_DOC). Les documents archivés, obsolètes, sans scan propre ou portant un lien étranger sont exclus. Le droit GED upload et le module pièces techniques sont exigés.

`POST /api/v1/ged/documents/:id/revision-links` reçoit revision_id, expected_version_id, link_role (PLAN_CLIENT ou PLAN_FABRICATION) et reason (3–500 caractères). Sous transaction, le document, la version, le verdict antivirus, les liens et les révisions sont relus et verrouillés. Une version changée, une cible obsolète ou une autre pièce refuse l’écriture. Une répétition du même rattachement renvoie created=false sans second audit.

Le document conserve son identité et ses liens historiques. Le journal CHECKIN porte action=REVISION_LINK_ADDED et le motif. Son statut reste inchangé : EN_REVUE nécessite toujours un autre approbateur ; aucun lancement de fabrication n’est autorisé par cette action.

La livraison des octets accepte plusieurs liens de révision uniquement lorsqu’ils se résolvent tous vers la même pièce existante et autorisée. Les liens mixtes, inconnus, manquants ou entre pièces distinctes restent refusés par une réponse opaque 404.

Aucune migration ni reprise de données. Déployer le backend avant le frontend. En cas de retour à l’ancien backend, les documents ayant plusieurs liens seront temporairement non téléchargeables : conserver les liens et remettre le correctif, sans supprimer l’historique.

Validation : tests ciblés ged-revision-links et ged-core.routes, TypeScript et inventaire OpenAPI. Recette dans cerp_test exclusivement par l’interface : ancien et nouvel indice retrouvent le même DT, téléchargement identique et circuit d’approbation conservé.
