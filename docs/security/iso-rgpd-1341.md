# Correctifs de sécurité ISO/RGPD — #1341

État du 16 octobre 2026 : intégration préparée sur une branche isolée pour le lot 2.0.4. Cette fiche ne vaut ni certification ni attestation de mise en production.

## Changements

- Une capacité nominative et MFA sont nécessaires aux actions Finance sensibles, à la lecture du journal global et aux données RH privées. Le module ouvert ne suffit plus. Les fonctions de poste restent descriptives.
- L'absence du catalogue ou de l'infrastructure d'accès produit une indisponibilité explicite. Elle ne donne plus accès par défaut à une ressource inconnue.
- Les GET exacts `/conditions-paiement` et `/compte-vente` sont les deux lecteurs de référence partagés par Clients et Devis. Le gate retient le module réellement accordé dans le contexte de requête ; les chemins imbriqués, les écritures et le reste de Devis restent rattachés à leur module initial. Le lecteur refuse un contexte absent ou issu d'un autre module, sans repli sur un intitulé de rôle.
- Le routeur `/admin/reference-data` vérifie le marqueur SuperAdmin en base avant toutes ses opérations, capacités comprises. Sa position avant le routeur d'administration général ne doit pas lui permettre de contourner cette vérification. Les autres validations métier des changements de référentiel restent en place.
- Les événements envoyés par le client sont séparés des preuves serveur ; action, entité et identité serveur ne proviennent pas du navigateur. Chaque lecture du journal global produit une trace serveur avant de retourner les résultats, sans recopier le texte recherché.
- Les DTO de compte ordinaires masquent salaire, naissance, pièce d'identité et NIR. Les anciens formulaires vides n'effacent pas ces valeurs. Les chemins `/admin/users/:id/private-profile` exigent les capacités RH et tracent les accès.
- Le superAdmin reste soumis à l'autorité Directory et aux contrôles MFA durables. Cette intégration ne raccourcit pas la durée des JWT ni n'ajoute de renouvellement de session : ce chantier reste explicitement séparé.
- Le profil d'installation client exige UUID d'installation/entreprise, production, origines HTTPS explicites, limitations d'authentification et clés configurées. Les JWT sont rattachés à cette installation. Il ne crée aucun fonctionnement multi-sociétés.

## Configuration

`JWT_SECRET` doit contenir au moins 32 caractères hors tests isolés ; générer une valeur aléatoire forte distincte par installation, depuis le coffre opérateur. Une longueur suffisante ne prouve pas à elle seule l'entropie ou la confidentialité. `MFA_ROOT_KEY` encode exactement 32 octets ; son ancienne valeur publique de démonstration et les suites d'octets tous identiques sont refusées hors tests. Ne pas changer cette clé sans préserver les facteurs existants et vérifier leur déchiffrement.

Le profil client ajoute `CERP_DEPLOYMENT_PROFILE=customer`, `CERP_INSTALLATION_ID`, `CERP_ENTERPRISE_ID`, `NODE_ENV=production`, `CORS_ORIGINS` explicite et `AUTH_RATE_LIMIT_HASH_KEY`. Aucun secret n'est fourni dans ce document.

Le contrôle d'admission par processus précède les parseurs. `CERP_HTTP_MAX_IN_FLIGHT` vaut 256 et `CERP_HTTP_HEAVY_MAX_IN_FLIGHT` vaut 8 par défaut ; valeurs entières entre 1 et 4096. Les multipart, PDF, imports et exports concernés comptent dans le budget lourd. Une saturation donne HTTP 429 et `Retry-After: 5`, sans file d'attente illimitée. Cette admission HTTP ne constitue pas un quota disque global ni une limite des travaux qui continueraient après la fin d'une requête. Dimensionner et superviser l'installation réelle.

## Migration et habilitations

Appliquer `20261015_sensitive_account_capabilities_1341.sql` par le runner de patches habituel après sauvegarde cohérente vérifiée, avec ses scripts `preflight`, `verify` et `rollback` sous `db/patches/support/`. Le patch est additif ; il ne crée aucune attribution nominative. Ne pas modifier le checksum d'un patch historique.

Résoudre les comptes et leurs marqueurs superAdmin dans la source d'identité faisant autorité. Lorsque l'annuaire partagé est activé, une projection locale ne remplace pas l'identité commune. Conserver la matrice privée et l'accord métier, puis attribuer les capacités par l'API protégée, avec version attendue. Le compte cible doit être actif et disposer d'un facteur MFA. Révoquer et vérifier l'effet dans HTTP et Socket.IO.

## Ordre de livraison

1. Figer les deux versions et terminer le gate sur la pile isolée.
2. Vérifier le recovery set DB/GED et le coffre de secrets des services réels. Une restauration fictive n'est pas la sauvegarde de production.
3. Préparer la rotation des signatures insuffisantes sur toutes les API concernées. L'accès opérationnel au serveur local est indispensable ; ne pas déployer seulement le VPS avec une signature incompatible avec les autres services.
4. Appliquer et vérifier le patch additif, réconcilier les marqueurs et droits approuvés, puis publier les versions web/Electron et serveur compatibles. Prévoir une reconnexion avec MFA et le renouvellement des liens signés encore nécessaires.
5. Contrôler les versions et healthchecks, les cas autorisés/refusés, un parcours métier ordinaire et un document GED sain. Conserver les preuves du déploiement réel.

Le rollback de schéma fourni conserve les données de droits pour diagnostic ; il ne les supprime pas en cascade. Revenir à l'ancien code peut rouvrir les contournements connus. Si ce retour devient indispensable, limiter les fonctions sensibles le temps de corriger en avant. Une restauration de base n'est jamais un simple substitut au rollback applicatif si des écritures ont eu lieu.

## Qualification requise

Avant toute intégration, qualifier séparément les capacités sensibles, les refus Finance et journal, la gestion Directory des propriétaires, les ACL Socket.IO, les budgets HTTP et les profils privés. Les parcours 2.0.4 de demandes de compte et MFA restent des non-régressions obligatoires. La compatibilité avec l'intégration frontend audit, notamment tout fragment dépendant d'un renouvellement de session reporté, reste à qualifier et à isoler. La génération de l'inventaire OpenAPI et les gates complets se feront seulement sur le couple backend/frontend figé.
