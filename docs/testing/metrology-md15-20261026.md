# Métrologie — profils MD15 et codes de parc

Demande utilisateur du 26 octobre 2026. Code Project Office proposé : `METROLOGY-MD15-20261026` ; suivi local, sans prétendre à une écriture sur l'API distante. Issue backend #1452 : « Métrologie : reprendre les fiches MD15 et les codes du registre qualité ». Branche locale `feature/1452-metrology-md15`, issue de `origin/dev` actualisé.

## Contrat et propriété des données

Le backend reste propriétaire du registre, des codes, des profils, des droits et des verdicts. `GET /api/v1/metrologie/v2/equipment-profiles` est soumis à la capacité `read`. Il décrit les familles documentaires `BF`, `BL`, `CA`, `JP`, `ME`, `MES`, `MI`, `OUT`, `PC`, `TF`, `TFD`, `TLD`, leurs catégories et les champs de la fiche. Le registre confirme `TFD` (tampon fileté double) jusqu'au numéro 03, même sans dossier dédié. Les références de cales comportant une date restent conservables sous `historique.COCONTR`, sans les transformer en nouveaux codes alloués.

La création v2 accepte un code historique canonique, par exemple `PC-01`, ou en attribue un dans le préfixe du profil. Les compteurs PostgreSQL natifs évitent de réémettre une valeur consommée après un échec. Les réservations agrégées des dossiers observés évitent de recycler les anciens numéros avant toute reprise des appareils. Aucun équipement ni relevé individuel du partage n'est importé.

`specifications.fiche_metrologie` conserve une version, le profil et les colonnes documentaires du registre. Elles ne remplacent pas la plage/résolution normalisée, la preuve conforme ou le statut serveur. Une mise à jour qui omet les spécifications conserve la fiche ; une incohérence entre code, profil et catégorie est refusée. Les codes déjà attribués ne sont jamais renommés.

`environnement.fiche_metrologie` conserve le visa, l'état mécanique et l'entretien de l'exécution. Le visa ne remplace pas l'identité de l'opérateur authentifié. La date de contrôle utilise `started_at` et le commentaire utilise `observations`. Le profil d'exécution doit correspondre à la fiche de l'instrument lorsqu'elle existe.

Les huit points de pied à coulisse et les deux points de jauge de profondeur reprennent la structure des fiches MD15. Le modèle ne contient ni nominal certifié, ni valeur mesurée, ni tolérance inventée. Les critères et références restent propres à l'appareil et aux preuves applicables. La qualité continue de référencer le même identifiant d'instrument et le même snapshot.

## Évolution SQL et activation

- Patch : `db/patches/20261026_metrology_md15_profile_codes.sql`.
- Vérification en lecture seule : `db/patches/support/20261026_metrology_md15_profile_codes.verify.sql`.
- Retour arrière : `db/patches/support/20261026_metrology_md15_profile_codes.rollback.sql`.

Le patch ajoute les scopes de compteurs `MTR:<famille>` au répartiteur existant et réserve leur plancher. Il conserve les scopes antérieurs et leur politique de permissions. Le retour arrière préserve les séquences consommées et les codes ; supprimer cette histoire casserait la traçabilité. Le code applicatif correspondant doit être retiré avant de retirer le scope du répartiteur.

La recette a été exécutée le 26 octobre sur PostgreSQL 17 (`postgres:17-alpine`, image `sha256:79bd7c99e923138f136f8009d6bffa66e21e9d4fda5c0c561b00fc9c90cfe537`) dans un conteneur éphémère, sans réseau ni port publié, avec une fixture minimale synthétique. Aucun conteneur, volume, port, API ni base CERP réelle n'a été utilisé. Le patch a été appliqué deux fois, le script de vérification a confirmé les 12 planchers et le garde d'immuabilité, puis le rollback a conservé les séquences PC et TFD consommées. Les deux allocations concurrentes ont retourné `PC-62` et `PC-63`; les prochaines valeurs vérifiées étaient `PC-61` et `TFD-04` avant ce test de concurrence. Les scripts synthétiques reproductibles sont sous `test-support/`; les sorties générées restent ignorées sous `test-results/`.

## Validation locale

- TypeScript global et build complet : réussis avec les dépendances du lockfile ; les dépendances du checkout partagé n'ont pas été modifiées.
- Trois suites ciblées : 136 tests réussis, incluant la compatibilité du code inchangé dans les mises à jour legacy, la famille TFD et les références historiques complètes.
- Les tests couvrent le DTO des nouvelles fiches, les préfixes/codes canoniques, les profils PC/JP, l'autorisation de lecture, la fusion des spécifications, la cohérence du profil d'exécution et deux allocations concurrentes sur une transaction simulée.
- Inventaire OpenAPI : 1 601 opérations, couverture 100 %, contrôle réussi.

La simulation unitaire de concurrence est complétée par la recette PostgreSQL isolée ci-dessus. Les captures et tests du vrai frontend sur API synthétique sont consignés dans le dossier frontend du même nom. Aucune migration de production ni modification du partage Z: n'a été effectuée.
