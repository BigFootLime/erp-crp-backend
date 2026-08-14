# ADR-0075 — Frontière d’isolation du portail client

- Statut : accepté
- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Périmètre : `/api/v1/portal`, `/api/v1/admin/client-portal`, GED et projections commerciales

## Contexte

Un compte ERP donne accès à des modules internes, des données transverses et un choix de base. Le réutiliser pour un client externe rendrait une erreur de permission trop dangereuse. Les commandes, livraisons, factures et documents contiennent en outre des états internes ou provisoires qui ne doivent pas être présentés au client.

## Décision

1. Une identité portail est distincte de `users`. Elle est rattachée à exactement un `client_id` et ne reçoit aucun rôle ERP, aucun sélecteur de base et aucun accès websocket interne.
2. Le portail utilise un secret JWT dédié, l’audience `cerp-client-portal`, l’émetteur `cerp-api`, un objet `client-portal-session-v1` et une durée de 15 minutes. Le middleware vérifie à chaque requête le statut `ACTIVE`, le client et `session_epoch` en base. Suspension, révocation ou changement de mot de passe invalide donc immédiatement les sessions existantes.
3. Le navigateur ne fournit jamais `client_id` pour filtrer les listes. Le dépôt le prend exclusivement dans l’identité vérifiée et applique `WHERE client_id=$1`. Un paramètre `client_id` inattendu est rejeté par la validation stricte.
4. Les vues PostgreSQL `client_portal_orders_v`, `client_portal_deliveries_v` et `client_portal_invoices_v` sont des projections en liste blanche avec `security_barrier`. Les brouillons ne sont pas exposés. Le code ne permet pas de choisir arbitrairement une table ou une vue.
5. Les documents ne sont visibles qu’après une publication explicite vers le même client. Une publication exige une version GED courante, applicable, non archivée et reliée au client, à sa commande, sa facture ou son bon de livraison. Le téléchargement exige en plus un verdict antivirus sain et une quarantaine libérée.
6. Les états documentaires publics sont `AVAILABLE`, `PENDING_SCAN`, `QUARANTINED`, `EXPIRED`, `REPLACED`, `UNAVAILABLE` et `REVOKED`. Un état non disponible n’est jamais remplacé par une version précédente ni converti en succès vide.
7. Création, invitation et publication administratives exigent un superadministrateur ERP et une `Idempotency-Key` UUID. Le reçu persistant associe acteur, action, empreinte de requête et résultat ; un retry identique rejoue le résultat et une charge différente retourne un conflit.
8. Invitation et récupération sont des jetons à usage unique. Seul leur SHA-256 est stocké. L’invitation expire après 24 heures, la récupération après une heure. Les mots de passe ont au moins 12 caractères avec les quatre classes et sont hachés en bcrypt coût 12.
9. Les réponses de connexion et de récupération ne révèlent pas l’existence d’un compte. Les limites sont persistées en PostgreSQL et sérialisées par verrous consultatifs : connexion 5 tentatives/identifiant et 30/IP sur 15 minutes ; récupération 4/identifiant et 20/IP par heure ; activation ou reset 8/jeton et 30/IP par heure.
10. Connexion, invitation, activation, récupération, changement d’état, publication, révocation, téléchargement, échec d’intégrité et accusé de lecture sont audités. L’audit conserve un hash d’IP et une famille d’agent, jamais l’adresse email, le mot de passe, le jeton, le contenu ou la clé de stockage.
11. Les reçus de commande, accusés et événements d’audit sont append-only. Un trigger PostgreSQL refuse en plus tout accusé entre un compte et une publication de clients différents.
12. Le pilote est strictement consultatif : aucune mutation de commande, validation contractuelle, signature ni paiement. La MFA n’est donc pas imposée au pilote. Elle devient un prérequis avant toute extension à une action engageante ; le choix cible est WebAuthn/passkey avec TOTP de secours, et non SMS.

## Session navigateur et risque résiduel

Le jeton portail est conservé dans un espace navigateur dédié, séparé du jeton ERP, et supprimé à son expiration. Sa durée courte et la validation en base limitent le rejeu, mais un script injecté dans la même origine pourrait le lire. La politique CSP, l’absence de HTML non fiable et la protection XSS restent donc obligatoires. Une session serveur en cookie `HttpOnly` ou un schéma BFF doit être retenu avant ouverture multi-domaines ou ajout d’actions engageantes.

## Conséquences

- Une fuite par simple filtre de requête est bloquée à la fois dans le contrôleur, le dépôt et, pour les accusés, par la base.
- Les champs publics sont intentionnellement moins nombreux que les modèles internes ; toute extension nécessite une revue de cette ADR et des tests inter-clients négatifs.
- `CLIENT_PORTAL_JWT_SECRET` doit être une valeur aléatoire d’au moins 32 caractères, distincte de `JWT_SECRET`, et être provisionnée séparément sur chaque environnement.
- Le retrait SQL n’est possible qu’avant toute preuve portail. Après usage, on désactive les routes et on conserve les comptes, publications et audits.
