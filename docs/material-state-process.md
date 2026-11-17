# État / procédé matière — lot 2.0.88

Autorisation utilisateur du 17 novembre 2026, chat `01a1e9b8-9ede-7750-bb9a-a366be7c75aa`. Source minimale depuis la production `93c84b24548058fd8904bba0b7f7095fc950c6fb`, sans nettoyage global.

Le champ historique `sous_etat_id` désigne le procédé d’obtention de la matière. Les requêtes de création et d’aperçu conservent leurs noms et schémas existants : `etat_id: null` signifie « Pas d’état », `sous_etat_id: null` signifie « Pas de procédé ». Le formulaire exige un choix explicite pour chacun ; les champs HTTP optionnels restent compatibles avec les clients historiques.

Le générateur commun `buildMaterialArticleCode` omet chaque segment absent, sans mot de remplacement ni tiret vide. Exemple : `MP-RO-316L-20`, ou `MP-RO-316L-H9-LAMINE-20` si état et procédé sont renseignés. Désignation et empreinte d’aperçu suivent les mêmes entrées. Nuance, profils particuliers, collision de référence, vérification de l’aperçu et autorisations restent en vigueur. Les mises à jour d’information ne changent pas l’identité d’un article existant.

Vérification ciblée : tests du générateur et contrats HTTP (quatre combinaisons, valeurs nulles, nuance obligatoire), contrôle TypeScript et compilation. Le module baseline compilé correspond octet pour octet aux cinq modules effectivement exécutés lors du préflight (4 services LAN et API publique), SHA-256 `2c828625d8d4833936cc598db5a86b568fa9831d67fce4dfc2a01d83d32b736f`.

Le paquet opérationnel superpose le seul fichier `dist/shared/codes/material-article-code.js` à une copie de chaque runtime effectif. Les repositories, adaptations EC, dépendances, paramètres de service et sources d’environnement restent propres à chaque variante. Aucun changement SQL ni écriture métier nécessaire. Les scripts et manifestes bornés doivent être revus avant activation ; retour au runtime précédent en cas d’échec. Cette note ne certifie pas un déploiement.
