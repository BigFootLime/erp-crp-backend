# Ordre des montages HTTP et compatibilité des rôles

`src/routes/v1.routes.ts` est une frontière de compatibilité Express : deux
routeurs qui partagent un préfixe sont résolus dans leur ordre de montage. Les
groupes où une route spécialisée doit précéder un routeur historique sont donc
déclarés avec `mountOrderedRouteGroup`. Le helper n'ajoute ni middleware, ni
préfixe, ni politique ; il appelle `router.use(prefix, child)` une fois par
entrée, dans l'ordre du tableau littéral.

Les routes publiques restent physiquement avant `authenticateToken`. Toutes
les routes métier restent après `authenticateToken` puis `moduleAccessGate`.
Cette séparation est intentionnelle : transformer ces deux gardes en données
génériques risquerait de changer la sémantique de l'arrêt de chaîne Express.
Les tests de contrat et les scénarios Supertest vérifient ces trois frontières,
la priorité spécialisée et le refus historique pour une route non spécialisée.

Les routeurs Production et Qualité utilisent encore des noms de rôle hérités
comme compatibilité locale. `hasLegacyRoleFragment` centralise exactement leur
normalisation existante (absence, `trim`, minuscules, recherche de fragment).
Les listes de fragments et les contrôles de capacité restent dans les routeurs
consommateurs. Une autorisation de module explicitement accordée conserve son
contournement historique. Ce changement n'ajoute aucun visa Qualité aux OF et
ne modifie pas Planning.

L'inventaire OpenAPI est généré depuis les montages Express. Son analyse AST
reconnaît les groupes ordonnés uniquement si chaque entrée est un objet
littéral avec `prefix` littéral et identifiant de routeur résoluble. Un spread,
un préfixe dynamique, un getter, une propriété calculée ou un routeur non
résolu échoue au build au lieu de retirer silencieusement des opérations. Les
provenances de ligne peuvent changer lors d'un regroupement ; les méthodes,
chemins, middlewares, état d'authentification et RBAC du contrat généré restent
inchangés.

Le générateur reconnaît l’import nommé, son alias et l’import d’espace de noms
du module canonique `src/routes/route-mount-order.ts`. L’appel doit rester une
expression directe au niveau du module ; captures, références indirectes,
réaffectations et accès calculés échouent explicitement. Le contenu du helper
consommé participe à l’empreinte : modifier son implémentation invalide aussi
les artefacts générés, même si le fichier de montage n’a pas changé.
