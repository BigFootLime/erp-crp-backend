# Bases Test gérées — #1568

Issue frontend : https://github.com/BigFootLime/crp-systems-web/issues/1568. Project Office `ERP-MULTITEST-20261014`. Branche `feature/1568-managed-test-databases`, dépendante du lot onboarding #1563. L’ADR-0074 et les configurations d’hébergement sont dans le dépôt frontend/gouvernance ; le code et l’autorité de provisionnement restent dans ce dépôt backend.

## Contrat

**Décision humaine finale :** comptes et entreprise communs/synchronisés ; nouvel annuaire vide, sans reprise des anciens comptes/sociétés. Le propriétaire KEENAN est ajouté par le bootstrap privé autorisé, avec MFA à sa première connexion, 39h/CDI/Responsable Informatique, avatar vide. Le login conserve sa disposition. L’autorité Auth/MFA/admin/entreprise/avatar est implémentée dans `src/shared-directory`, avec acteur global UUID et acteurs métiers locaux distincts. Le manager vérifie cette autorité et ses capacités avant activation ; le flag seul ne suffit pas.

Un contrôle SSH/PostgreSQL strictement READONLY a constaté18 comptes Prod/22 Test, dont18 identités communes, un factureur par base et aucune entreprise principale. Le choix est désormais explicite : ne pas importer ces anciens comptes. Un relevé complémentaire vérifie uniquement le propriétaire fourni, acteur1 actif sur Prod/Test. Sa liaison au UUID bootstrap est une approbation privilégiée explicite, jamais une équivalence automatique de noms/IDs. Les autres anciens acteurs et leurs FK restent intacts et exclus du nouvel annuaire.

Le serveur autonome `dist/managed-tests/index.js` écoute uniquement `127.0.0.1:8084`. Le registre privé JSON est remplacé atomiquement et synchronisé ; un verrou de processus interdit deux écrivains. Les numéros commencent à 2 et ne sont pas réutilisés après suppression. Les identités `cerp_test_<uuid32>` restent stables, distinctes des libellés Base Test 2.0, 3.0…

| Route | Politique |
|---|---|
| `GET /api/v1/test-databases` | Métadonnées publiques minimales : identité, numéro, état ; aucun acteur, port, secret ou chemin |
| `POST /api/v1/test-databases` | Corps vide strict, UUID de commande ; superadministrateur actif de la Test commune et MFA récente |
| `POST /api/v1/test-databases/:id/retry` | Même autorité ; reprise d’une création FAILED avec la même identité et le même numéro |
| `DELETE /api/v1/test-databases/:id` | Même autorité, UUID de commande et nom exact à recopier ; bases fixes exclues |

L’autorisation est relue auprès de l’API Test commune sur loopback (`environment`, `auth/me`, `auth/access-profile`). La base connectée doit être réellement `cerp_test`, l’utilisateur actif et le marqueur superadministrateur vrai. Une MFA de plus de cinq minutes renvoie le step-up existant. Un jeton d’une base supplémentaire ou Production ne devient pas un jeton de gestion.

Les routes HTTP et WebSocket des bases supplémentaires sont dirigées uniquement vers les ports loopback enregistrés READY. Une identité inconnue, invalide, supprimée ou en cours d’opération échoue explicitement. La suppression ferme les connexions de cette instance. Aucun chemin de repli vers Production n’existe dans ce routeur.

## Helper et modèle vide

Le routeur n’a aucune autorité PostgreSQL administrative. Il appelle uniquement le wrapper root revu `cerp-test-control` pour status/create/delete. Le wrapper efface l’environnement appelant, utilise une interprétation Node fixe et un verrou privé. La préparation du modèle est une commande root distincte non accordée au compte du routeur.

`host.json` et `api-template.env` doivent être privés, root, sans écriture de groupe. L’artefact API doit être root et immuable, avec un chemin de version physique ; un lien `current` ne doit pas servir d’identité de release dans le modèle. Le volume de données est un prérequis protégé avec sentinelle ; le helper ne fabrique pas un volume absent. Les fichiers privilégiés sont contenus sous des racines contrôlées, les liens refusés et les changements de propriétaire faits par des descripteurs vérifiés avant publication des permissions.

La préparation utilise le schéma Test canonique et les catalogues app_roles/app_modules/ledger. Le helper `canonical-template-seeds` reconstruit les métadonnées GED, les singletons planning/Finance/Stock et curseurs vides, ainsi que neuf switches techniques connus et la politique planning déjà autorisée. Sa politique est figée dans le meta du modèle et revérifiée. EUR/u/familles machines restent canoniques ; CUMP reste PREPARED. Les triggers viennent après ces références. Aucune donnée métier, compte, société, machine, calendrier, contrat ou document n’est copié du site source.

Chaque création clone le modèle, enregistre un marqueur protégé et démarre une API/pool fixe, avec JWT et stockage propres. Le helper attribue aussi son caller key distinct vers l’autorité commune ; aucun password/facteur MFA commun n’est copié dans cette base. La source des credentials/MFA est un service privé1278085, rôle PG cerp_directory_app distinct, CONNECT retiré à PUBLIC/cerp_app. Les attributs globaux et profils horaires initiaux sont projetés avec nouveaux IDs locaux ; seul le propriétaire approuvé conserve son acteur historique. Les sessions/permissions sont liées à une base et validées en direct, HTTP/WebSocket/PIN/badges compris. Le retrait d’une instance retire sa clé de caller.

Les déploiements futurs ne modifient pas silencieusement les releases épinglées. L’opérateur qualifie schéma/migrations et artefact, puis prépare une nouvelle version de modèle et traite explicitement les instances existantes sous le gate de release. Le premier lot ne réécrit aucune instance existante.

## Suppression et conservation

La suppression exige un manifeste root, un nom PostgreSQL strict, son propriétaire et son commentaire partagé PostgreSQL correspondant à l’identité. Elle arrête l’API, sauvegarde avec `pg_dump`, vérifie tous les blocs via `pg_restore`, calcule SHA-256 et persiste la preuve avant retrait de la base. Une coupure après fermeture des connexions reste récupérable depuis cette preuve. Les fichiers sont déplacés dans une archive contenue sous la racine de données ; la configuration et le snapshot restent privés. Production et Test commune ne peuvent pas atteindre cette commande.

Le retrait rend la base inaccessible dans l’ERP ; il n’est pas une purge des sauvegardes. Archives et configurations contenant des données personnelles/secrets doivent suivre la politique de conservation des sauvegardes CERP, avec permissions root, accès opérateur audité et purge selon le processus existant. Aucun snapshot ni credential n’est versionné ou projeté dans les réponses publiques.

## Qualification locale

Les tests de registre, autorisation, identité physique et proxy couvrent concurrence, reprises, numéros non réutilisés, refus des bases fixes et routage HTTP/WebSocket. Les tests natifs distinguent deux bases ayant le même utilisateur et le même intent d’impression. L’UI est qualifiée à 375 px, tablette portrait et paysage ; ses sources sont synthétiques.

La preuve historique `managed-tests-1568-postgres.json` couvre le prototype de provisionnement/isolation, avant l’annuaire commun. `check-directory-sessions.cjs` qualifie désormais le vrai service HTTP/HMAC, MFA/codes uniques, refus interbases, invitations, société/historique/avatar, acteur propriétaire approuvé, lifecycle PIN/epoch et heures initiales sur PostgreSQL17 loopback15463 sous le rôle dédié limité :29 contrôles PASS, données synthétiques seulement. Son scanner est simulé ; aucun antivirus/tablette/imprimante physique n’est revendiqué. Le helper canonique est également qualifié sur schema-only PG17 par le chat d’audit. Les services Unix/proxies et le backup réel restent à contrôler dans la livraison coordonnée.

Aucune Base Test 2.0 métier, modification de production, publication Electron, déploiement Apache/Traefik ou configuration de credential réelle n’est revendiquée par le lot local. Le runbook frontend précise l’installation et les contrôles nécessaires avant activation.
