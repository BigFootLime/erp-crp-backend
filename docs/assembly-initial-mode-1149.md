# Mode initial d’un assemblage — #1149

Le premier indice créé par le parcours PT omettait `manufacturing_mode` et prenait
le défaut SQL `SIMPLE`, même lorsque `ensemble` était vrai. La création inscrit
maintenant `ASSEMBLY` pour un ensemble et `SIMPLE` sinon, avec `MAKE_TO_ORDER`.
L’API de création d’un premier indice déduit également le type du parent lorsqu’il
n’est pas précisé. Une décision explicite et le clonage d’une définition source
restent prioritaires.

La correction d’un brouillon utilise le PATCH de version existant : transaction,
verrou de ligne, contrôle `expected_updated_at`, audit avant/après des décisions.
Les définitions applicables et obsolètes restent verrouillées. Aucun rattrapage SQL
des versions historiques, aucun remplacement d’indice, aucune migration n’est
nécessaire.

Les tests ciblés vérifient les deux types initiaux, le défaut de l’API, la décision
explicite, la correction conservant l’identité, le plan et la gamme, le refus des
versions figées et des révisions périmées. Les doubles de transaction ne remplacent
pas la recette avec PostgreSQL et l’interface réelle sur Base Test.
