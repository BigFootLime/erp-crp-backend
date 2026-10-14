# Bases Test gérées — #1568

Issue frontend : https://github.com/BigFootLime/crp-systems-web/issues/1568. Project Office `ERP-MULTITEST-20261014`. Branche `feature/1568-managed-test-databases`, dépendante du lot onboarding #1563. L’ADR-0074 et les configurations d’hébergement sont dans le dépôt frontend/gouvernance ; le code et l’autorité de provisionnement restent dans ce dépôt backend.

## Contrat

**Révision humaine :** comptes et entreprise communs/synchronisés, Production comme référence initiale, aucune donnée de compte/société fictive préremplie. Le login doit conserver sa disposition actuelle. Le prototype de provisionnement et ses preuves d’isolation ci-dessous ne qualifient pas encore cette nouvelle exigence. L’entrée runtime `managed-tests/index.ts` ferme les commandes réelles même si le flag est ouvert, jusqu’à l’intégration/qualification de l’autorité commune Auth/MFA/entreprise. Aucune copie indépendante de comptes ne doit être livrée.

Un contrôle SSH/PostgreSQL strictement en lecture seule le 14 octobre a constaté 18 comptes Production et 22 Test, dont 18 identités communes avec IDs correspondants, ainsi qu’un factureur par base mais aucune entreprise principale configurée. La preuve ne contient que des agrégats : `docs/testing/evidence/shared-directory-1568-readonly.json`. Aucun mot de passe, secret MFA ou champ personnel n’a été exporté, aucune donnée ni permission n’a été changée. Le choix départ vide/reprise des comptes existants doit être précisé avant une réconciliation ; les IDs locaux ne sont jamais rapprochés automatiquement.

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

La préparation utilise le schéma PostgreSQL canonique de la Test commune et les seules données des catalogues `app_roles`, `app_modules` et du ledger de migrations. EUR, unité `u` et les cinq familles machines génériques proviennent des migrations CERP. Les singletons planning/temps réel sont réinitialisés pour une base neuve, avec une provenance de départ vide. Les triggers sont installés après ces références pour préserver leur comportement sans lancer des jobs pendant l’amorçage. Toutes les autres tables publiques doivent être vides. Aucun compte, société, machine, contrat RH, document, coût ou configuration d’entreprise n’est repris.

Chaque création clone le modèle validé, enregistre un marqueur PostgreSQL protégé et démarre une API avec son pool fixe. La release et le modèle sont épinglés ensemble. JWT, clé MFA et clé de hachage des limitations de débit sont propres à la base ; les racines documentaires le sont aussi. Les identifiants de la connexion applicative existante restent ceux du rôle CERP, avec les ACL canoniques clonées ; aucune nouvelle permission CRUD globale n’est accordée. Les credentials de mail sont retirés. Le service vérifie la base réelle, l’identité attendue et le marqueur avant ouverture de son port loopback.

Les déploiements futurs ne modifient pas silencieusement les releases épinglées. L’opérateur qualifie schéma/migrations et artefact, puis prépare une nouvelle version de modèle et traite explicitement les instances existantes sous le gate de release. Le premier lot ne réécrit aucune instance existante.

## Suppression et conservation

La suppression exige un manifeste root, un nom PostgreSQL strict, son propriétaire et son commentaire partagé PostgreSQL correspondant à l’identité. Elle arrête l’API, sauvegarde avec `pg_dump`, vérifie tous les blocs via `pg_restore`, calcule SHA-256 et persiste la preuve avant retrait de la base. Une coupure après fermeture des connexions reste récupérable depuis cette preuve. Les fichiers sont déplacés dans une archive contenue sous la racine de données ; la configuration et le snapshot restent privés. Production et Test commune ne peuvent pas atteindre cette commande.

Le retrait rend la base inaccessible dans l’ERP ; il n’est pas une purge des sauvegardes. Archives et configurations contenant des données personnelles/secrets doivent suivre la politique de conservation des sauvegardes CERP, avec permissions root, accès opérateur audité et purge selon le processus existant. Aucun snapshot ni credential n’est versionné ou projeté dans les réponses publiques.

## Qualification locale

Les tests de registre, autorisation, identité physique et proxy couvrent concurrence, reprises, numéros non réutilisés, refus des bases fixes et routage HTTP/WebSocket. Les tests natifs distinguent deux bases ayant le même utilisateur et le même intent d’impression. L’UI est qualifiée à 375 px, tablette portrait et paysage ; ses sources sont synthétiques.

`scripts/managed-tests/check-fixture.cjs` prépare réellement un modèle depuis un cluster PostgreSQL de qualification sur loopback 15463, puis exécute le worker, le registre, le proxy et les services Auth/MFA avec des processus API indépendants. Il vérifie les comptes réutilisant un userID, les refus entre bases, le contrat RH propre, la sauvegarde, la suppression et la restauration. La preuve et son statut réel sont dans `docs/testing/evidence/managed-tests-1568-postgres.json`. Sous Windows, systemd et les identités Unix sont adaptés ; cette preuve ne certifie pas les permissions POSIX ni les proxies déployés. Les fichiers et bases de qualification restent identifiés et séparés des environnements métier.

Aucune Base Test 2.0 métier, modification de production, publication Electron, déploiement Apache/Traefik ou configuration de credential réelle n’est revendiquée par le lot local. Le runbook frontend précise l’installation et les contrôles nécessaires avant activation.
