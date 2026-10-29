# Modèles 3D privés des PT — #1489

La route `GET /pieces-techniques/:id/models-3d` reprend les contrôles du module pièces techniques et exige la capacité GED `download`. Elle ne livre pas le contenu CAO et n’écrit aucune donnée.

Réponse : `{ piece_technique_version_id: string | null, indice: string | null, models: [{ document_id, version_id, original_name, mime_type, sha256, size_bytes }] }`. Une PT absente retourne 404 ; une PT sans révision ou sans modèle compatible retourne une liste vide. Plusieurs modèles sont conservés pour que l’utilisateur choisisse explicitement.

La sélection de révision suit celle du dossier documentaire. La projection ne prend que les documents non archivés de classe `MODELE_3D`, liés à cette révision par `PIECE_TECHNIQUE_VERSION` et rôle `MODELE_3D`, dont la version courante est `APPLICABLE` et le dépôt scanné `clean` / `released`. Aucun ancien lien global vers la pièce n’est réinterprété. Les chemins de stockage ne quittent pas le serveur.

Le téléchargement passe toujours par `GET /ged/versions/:version_id/content` et ses contrôles existants (droits, parent, scan). Le frontend #1807 transforme le STEP en géométrie dans un worker local ; aucun convertisseur serveur, nouvelle dépendance backend ou migration n’est nécessaire.

Vérifications : tests ciblés du repository (absence de révision, filtres, liste multiple), TypeScript, inventaire OpenAPI et revue SQL `DISTINCT / ORDER BY` sur les alias projetés. Ces tests utilisent un mock de requêtes et ne constituent pas une exécution PostgreSQL de recette. Aucun modèle client ni PDF n’est ajouté aux fixtures.
