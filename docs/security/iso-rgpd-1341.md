# Correctifs de sécurité ISO/RGPD — #1341

État du 15 octobre 2026 : préparés et testés localement, livraison coordonnée en cours de qualification avec le frontend #1592. Aucune certification ni mise en production n'est attestée par cette fiche.

## Changements

- Une capacité nominative et MFA sont nécessaires aux actions Finance sensibles, à la lecture du journal global et aux données RH privées. Le module ouvert ne suffit plus. Les fonctions de poste restent descriptives.
- L'absence du catalogue ou de l'infrastructure d'accès produit une indisponibilité explicite. Elle ne donne plus accès par défaut à une ressource inconnue.
- Les événements envoyés par le client sont séparés des preuves serveur ; action, entité et identité serveur ne proviennent pas du navigateur. Chaque lecture du journal global produit une trace serveur avant de retourner les résultats, sans recopier le texte recherché.
- Les DTO de compte ordinaires masquent salaire, naissance, pièce d'identité et NIR. Les anciens formulaires vides n'effacent pas ces valeurs. Les chemins `/admin/users/:id/private-profile` exigent les capacités RH et tracent les accès.
- Les nouveaux JWT durent quinze minutes. `/auth/session/renew` exige une session authentifiée et conserve les preuves et révocations, sans repousser le plafond de huit heures. Le superAdmin exige MFA indépendamment de la politique des comptes ordinaires. Socket.IO vérifie aussi l'assurance MFA, le facteur actif et sa version, puis déconnecte les sessions devenues invalides.
- Le profil d'installation client exige UUID d'installation/entreprise, production, origines HTTPS explicites, limitations d'authentification et clés configurées. Les JWT sont rattachés à cette installation. Il ne crée aucun fonctionnement multi-sociétés.
- Les dépendances Multer, qs et transitives vulnérables sont mises à jour dans les verrous pnpm et npm. La collecte Vitest est compatible avec la nouvelle version de son paquet.

## Configuration

`JWT_SECRET` doit contenir au moins 32 caractères hors tests isolés ; générer une valeur aléatoire forte distincte par installation, depuis le coffre opérateur. Une longueur suffisante ne prouve pas à elle seule l'entropie ou la confidentialité. Lorsque le VPS relaie des requêtes authentifiées vers l'API locale d'un même site, les deux composants de ce site doivent vérifier les mêmes jetons : comparer leurs secrets en mémoire par un préflight qui ne sort ni valeur ni empreinte. Ne jamais comparer ou recopier des secrets entre Production et Test. `MFA_ROOT_KEY` encode exactement 32 octets ; son ancienne valeur publique de démonstration et les suites d'octets tous identiques sont refusées hors tests. Ne pas changer cette clé sans préserver les facteurs existants et vérifier leur déchiffrement.

Le profil client ajoute `CERP_DEPLOYMENT_PROFILE=customer`, `CERP_INSTALLATION_ID`, `CERP_ENTERPRISE_ID`, `NODE_ENV=production`, `CORS_ORIGINS` explicite et `AUTH_RATE_LIMIT_HASH_KEY`. Aucun secret n'est fourni dans ce document.

Le contrôle d'admission par processus précède les parseurs. `CERP_HTTP_MAX_IN_FLIGHT` vaut 256 et `CERP_HTTP_HEAVY_MAX_IN_FLIGHT` vaut 8 par défaut ; valeurs entières entre 1 et 4096. Les multipart, PDF, imports et exports concernés comptent dans le budget lourd. Une saturation donne HTTP 429 et `Retry-After: 5`, sans file d'attente illimitée. Cette admission HTTP ne constitue pas un quota disque global ni une limite des travaux qui continueraient après la fin d'une requête. Dimensionner et superviser l'installation réelle.

## Migration et habilitations

Appliquer `20261015_sensitive_account_capabilities_1341.sql` par le runner de patches habituel après sauvegarde cohérente vérifiée, avec ses scripts `preflight`, `verify` et `rollback` sous `db/patches/support/`. Le patch est additif ; il ne crée aucune attribution nominative. Ne pas modifier le checksum d'un patch historique.

Résoudre les comptes et leurs marqueurs superAdmin dans la source d'identité faisant autorité. Lorsque l'annuaire partagé est activé, une projection locale ne remplace pas l'identité commune. Conserver la matrice privée et l'accord métier, puis attribuer les capacités par l'API protégée, avec version attendue. Le compte cible doit être actif et disposer d'un facteur MFA. Révoquer et vérifier l'effet dans HTTP et Socket.IO.

## Ordre de livraison

1. Figer les deux versions et terminer le gate sur la pile isolée.
2. Vérifier le recovery set DB/GED et le coffre de secrets des services réels. Une restauration fictive n'est pas la sauvegarde de production.
3. Pour toute rotation ou modification de signature, exécuter avant redémarrage le préflight de cohérence par site (VPS Production avec HYPER Production, séparément de Test), sans afficher de secret ou d'empreinte. L'accès opérationnel au serveur local est indispensable ; ne pas déployer seulement le VPS avec une signature incompatible avec les autres services. Prévoir la reconnexion des sessions antérieures. Le 15 octobre, l'alignement de Production a été contrôlé en privé puis appliqué ; il ne vaut pas validation des secrets ou du login Test.
4. Appliquer et vérifier le patch additif, réconcilier les marqueurs et droits approuvés, puis publier les versions web/Electron et serveur compatibles. Prévoir une reconnexion avec MFA et le renouvellement des liens signés encore nécessaires.
5. Contrôler les versions et healthchecks, les cas autorisés/refusés, un parcours métier ordinaire et un document GED sain. Conserver les preuves du déploiement réel.

Le rollback de schéma fourni conserve les données de droits pour diagnostic ; il ne les supprime pas en cascade. Revenir à l'ancien code peut rouvrir les contournements connus. Si ce retour devient indispensable, limiter les fonctions sensibles le temps de corriger en avant. Une restauration de base n'est jamais un simple substitut au rollback applicatif si des écritures ont eu lieu.

## Preuves disponibles

Suite serveur finale de cette branche : 8 307 tests réussis, aucun échec, 257 tests d'intégration préexistants ignorés ; ceux-ci ne sont pas déclarés validés. Contrôle de types et build passent. Le catalogue HTTP comprend 1 532 opérations inventoriées. La recette navigateur complète coordonnée avec le frontend reste à terminer avant publication.

Une preuve antérieure distincte a rejoué 313 patches sur un cluster PostgreSQL 18 jetable : elle couvre des grants, révocations et concurrences de son périmètre, des ACL de registre, de l'audit serveur et le masquage/conservation RH. Sa restauration fictive a contrôlé DB, document, configuration, déchiffrement MFA et le rejet d'une archive altérée. Elle ne qualifie ni cette branche rebasée, ni le serveur client, ni la recette finale des commits publiés.

Le 15 octobre 2026, `scripts/managed-tests/check-directory-superadmin-1341.cjs` a exercé uniquement `setProductionSuperadminMembership` contre PostgreSQL 16 jetable, sur un réseau Docker interne et une base UUID temporaire, avec le rôle applicatif sans privilège `cerp_audit_app`. Ses huit contrôles comprennent deux contrôles d'identité et de connexion du fixture, puis une concurrence de même version (un commit et un refus de version obsolète), une trace d'audit et un événement d'outbox, l'auto-retrait refusé, une MFA révoquée avant la relecture verrouillée, et le dernier owner simulé par un trigger de fixture avec rollback. Ils ne qualifient pas le workflow HTTP de statut, ni une promotion complète, ni l'annuaire distant. La protection transactionnelle `repoUpdateUser` est couverte séparément par un test unitaire qui traverse l'enveloppe transactionnelle réelle avec un client synthétique : `BEGIN`, verrou global, verrou membership/utilisateur, refus, `ROLLBACK`, sans `UPDATE`. La preuve privée ne contient aucune identité réelle ; la base, le conteneur et le réseau sont supprimés en fin de test. Aucune de ces preuves n'autorise une mutation de comptes réels sans intégration, revue et recette.

## Limites et conditions de bascule annuaire

Les habilitations sensibles sont conservées par site tandis que la MFA et le statut SuperAdmin sont canoniques. Avant une écriture locale, le service relit la cible et l'opérateur dans l'annuaire après les verrous locaux ; une MFA ou une autorisation devenue invalide refuse l'écriture. Cette double vérification réduit la course entre les deux systèmes, sans constituer une transaction distribuée. Une bascule qui doit modifier à la fois SuperAdmin et des habilitations nominatives sans interruption exige donc une opération d'onboarding atomique dédiée, revue avant livraison.

Une identité historique n'est jamais rapprochée automatiquement par nom ou par courriel. La projection ne réutilise une ligne locale que via une liaison approuvée, liée au profil canonique, à l'autorité attendue et aux identifiants attendus. La procédure doit provisionner le profil canonique, créer cette liaison, vérifier l'enrôlement MFA, puis seulement attribuer les habilitations. Aucune mise à jour SQL cosmétique ou copie de mot de passe ne constitue une migration admissible.

**Condition de bascule — comptes historiques.** Le contrôleur d’authentification délègue toutes les connexions à l’annuaire lorsqu’il est activé ; il n’existe pas de repli silencieux vers le mot de passe local. Pour l’inventaire opérationnel actuel des comptes historiques concernés, ne pas activer l’annuaire dans une version 2.0.4 tant que chaque compte concerné n’est pas soit rattaché, invité et enrôlé MFA, soit explicitement exclu par une transition validée. Cette condition est un prérequis de déploiement, non une migration automatique. La preuve de fixture vérifie la conservation d’un identifiant local et de son historique par liaison privilégiée, mais ne qualifie pas encore le futur protocole d’adoption ni une bascule réelle.

Les réponses d'erreur d'administration et de gestion MFA passent par des listes fermées de statuts et messages publics ; les détails reçus de l'autorité ne sont pas renvoyés. Une confirmation MFA devenue trop ancienne pendant l'attente d'un verrou administratif demande la confirmation habituelle en HTTP 428, sans mutation. Les tests traversent le vrai `DirectoryClient`, la façade ou le contrôleur, puis le gestionnaire HTTP. Les 23 cas MFA et quatre cas de transport administratif ciblés passent ; la qualification complète de ces nouveaux ajouts reste à terminer. L'inventaire préparé comprend désormais 1 532 opérations, dont le contrat strict `PATCH /admin/users/:id/administrative-level` avec version attendue et erreurs documentées. Le responsable a par ailleurs confirmé une connexion Production/GED puis une connexion Base Test fonctionnelles après la release serveur ciblée du 15 octobre, distincte de ce lot complet.
