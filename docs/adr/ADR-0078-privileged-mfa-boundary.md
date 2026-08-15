# ADR-0078 — Frontière MFA des comptes privilégiés

- Statut : accepté
- Date : 2026-08-15
- Décisionnaire : Keenan Martin
- Portée : SOL-32

## Contexte

Les sessions CERP+ reposaient sur le mot de passe et un JWT. Les actions les
plus sensibles étaient protégées par le RBAC serveur, mais un mot de passe ou
un jeton volé suffisait encore à exercer les privilèges d’un superadministrateur.
Le produit est servi depuis plusieurs origines (Coolify, HYPERBOX2, Electron et
loopback), ce qui rend un premier déploiement WebAuthn dépendant d’une politique
de domaines et de RP ID qui n’est pas encore stabilisée.

## Décision

Tout compte actif dont `users.is_superadmin` vaut vrai doit posséder un facteur
TOTP RFC 6238 actif. Le marqueur persistant est l’autorité ; aucun nom de rôle
frontend ne peut rendre ou retirer cette obligation.

Après validation du mot de passe, l’API ne délivre pas de session privilégiée :
elle crée un challenge opaque, court, stocké uniquement sous forme SHA-256 et
limité en débit. Le premier accès impose l’enrôlement TOTP. Les accès suivants
acceptent un TOTP dans une dérive de ±30 secondes ou un code de secours à usage
unique. Un pas TOTP déjà accepté ne peut pas être rejoué.

Le JWT final contient la méthode, la date, l’identifiant et la version du
facteur. À chaque requête, le backend compare ces preuves au compte et au
facteur actifs en base. La révocation, le remplacement ou la récupération hors
bande invalide les anciennes sessions via `realtime_session_epochs`.

Les mutations administratives, de contrôle d’accès, de portail client et de
webhooks demandent en plus une preuve MFA datant de moins de cinq minutes. Une
réponse `428 MFA_STEP_UP_REQUIRED` déclenche une boîte de confirmation puis un
unique rejeu de la requête originale avec le nouveau jeton.

## Secrets, codes et anti-bruteforce

- les graines TOTP sont chiffrées AES-256-GCM avec AAD ;
- `MFA_ROOT_KEY` contient exactement 32 octets et reste dans le gestionnaire de
  secrets, séparé des sauvegardes ; `MFA_KEY_ID` trace la version active ;
- le service refuse de démarrer en production si la clé est absente ou invalide ;
- les codes de secours ont 80 bits issus du CSPRNG, sont retournés une seule
  fois et stockés sous HMAC-SHA-256 normalisé ;
- cinq échecs verrouillent facteur et challenge pendant quinze minutes ; la
  limite de débit distribuée de l’authentification s’applique aussi aux routes
  MFA ;
- les graines, QR codes, codes, mots de passe et jetons ne sont jamais audités
  ni journalisés.

Une clé est commune uniquement aux instances qui lisent la même base. Les clés
des environnements séparés restent distinctes. Une rotation de clé racine exige
une fenêtre opérateur et le remplacement contrôlé des facteurs ; changer la clé
seule rendrait les graines existantes indéchiffrables et est interdit.

## Cycle de vie et récupération

L’utilisateur peut remplacer son facteur ou régénérer ses codes après mot de
passe et MFA courante. La révocation du dernier facteur d’un administrateur
privilégié est refusée. Le seul secours est la commande hors bande documentée :
elle est en lecture seule par défaut, exige `--apply`, un acquittement daté, un
motif, verrouille les lignes, révoque le facteur, invalide les sessions et écrit
un audit durable. Le prochain login impose un nouvel enrôlement.

## Conséquences et rollback

La migration ajoute trois tables sans réécrire `users`. Avant tout enrôlement,
le rollback SQL peut supprimer ces tables. Dès qu’une preuve active ou révoquée
existe, le rollback SQL se ferme volontairement : revenir au logiciel précédent
doit conserver les preuves et s’accompagner d’une restauration cohérente si le
schéma doit réellement être retiré.

WebAuthn reste une évolution possible lorsque les origines officielles et le
cycle des clés matérielles seront contractualisés ; TOTP est aujourd’hui le
facteur interopérable entre les cibles existantes.
