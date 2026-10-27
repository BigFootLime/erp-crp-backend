# Multi-entreprises — runtime, administration et clients

Date : 2026-10-26. Backend #1454, frontend #1775. Travail local sur les branches
`feature/1454-multi-company-foundation` et `feature/1775-multi-company-foundation`.

## Comportement implémenté

L'entreprise est un contexte distinct de Production/Test. Un processus conserve
un seul pool et vérifie au démarrage sa base, son instance Directory, son UUID
entreprise et son environnement. HTTP, Socket.IO, téléchargements et caches
respectent ce contexte. Aucun header ne choisit une URL PostgreSQL ou un pool.

Le registre privé Directory porte les entreprises, instances et memberships.
Une membership active sans modules explicitement accordés ne donne aucun module.
La politique effective croise entreprise, accords du compte, refus et profil
commercial. Sa projection locale est signée, liée au nonce de requête, à l'autorité,
au profil, au runtime et aux versions ; elle est transactionnelle et auditée.
Elle n'accorde aucune capacité sensible ni aucun superadmin implicite. L'owner
CRP existant conserve ses droits ; le profil commercial reste limité à l'Accueil.

La bascule utilise un ticket de 60 secondes lié à la session source, aux versions
et à la cible. Une répétition identique retourne la même session pour récupérer
un accusé réseau perdu. La session source reste revalidée, l'âge MFA/tablette est
conservé et l'expiration cible est bornée à celle de la source. Le bearer source
n'est jamais envoyé au runtime cible. Les réponses tardives après déconnexion,
nouvelle connexion ou changement de contexte ne rétablissent pas une session.

Le sélecteur et l'administration réutilisent CERP. L'administration exige un
owner central et une MFA récente ; les mutations ont une version attendue et des
gardes contre la désactivation du contexte actif de son propre administrateur.
Les profils sont sélectionnés explicitement. Aucun nom ne donne un accès.
Déclarer une instance prépare son raccordement et ne crée pas sa base.

La connexion principale confirme l'entreprise fixe avant les identifiants. Un
lien `/login?company=<uuid>&environment=cerp_prod|cerp_test` permet aussi aux
comptes limités à EC de se connecter directement. L'indice de routage est distinct
du contexte autorisant. Un lien explicite invalide ne revient pas silencieusement
vers CRP ; l'utilisateur peut choisir explicitement la connexion principale.
La compatibilité avec un backend historique sur 404 est réservée au bootstrap
sans cible préexistante. La cible choisie est recoupée avec l'environnement.

Les clients existants restent professionnels. Un particulier porte un prénom et
un nom ; le serveur dérive son libellé historique et exclut les identifiants
fiscaux professionnels. Les transitions sont contrôlées sous verrou dans le même
UPDATE. Les deux formulaires existants, la liste et la fiche sont adaptés. Le
parcours réel `/clients/new` a été exercé jusqu'au POST de création en fixture.
L'identité légale et le paramétrage restent locaux à l'entreprise. Le wizard
commercial ne demande que l'identité et la facturation, sans atelier ou stock.

## Activation et migrations

L'activation est explicite : `CERP_BUSINESS_COMPANIES_ENABLED=true`,
`CERP_COMPANY_ID`, `CERP_COMPANY_ENVIRONMENT=cerp_prod|cerp_test`, Directory actif,
instance enregistrée et pool fixé sur cette instance. Le mode workers doit être
explicitement `off` ou `leader`. Aucun runtime ni worker n'est démarré par ce lot.

- `db/shared-directory/20261026_business_companies_1454.*.sql` : scripts réservés
  au Directory, séparés du runner métier. Rôles applicatifs métier exclus.
- `db/company-sites/20261026_company_directory_sites_1454.*.sql` : fondation des
  nouvelles instances opaques, hors runner automatique et sans import de comptes.
- `db/patches/20261026_company_policy_projections_1454.sql` : état local des
  politiques signées, avec préflight/verify/rollback dans `db/patches/support`.
- `db/patches/20261026_client_person_types_1454.sql` : identité client B2B/B2C,
  avec scripts de support distincts et rollback refusé en présence de particuliers.

Le [provisionnement](../company-site-provisioning-1454.md) part d'un schéma
qualifié et de patches sélectionnés, sans copie de données de production ni
ledger fabriqué. Aucun `up` global n'est lancé. La coordination du chantier
notifications signale en plus la réconciliation des compteurs suivie par #1458.
Les readiness GED, médias, antivirus, base et temps réel restent obligatoires.

Le générateur `scripts/entreprises/render-company-proxy.mjs` valide un manifeste
de destinations fixes et produit un fragment Apache à inspecter. UUID entreprise
et environnement canonique routent REST et Socket.IO. Les paires inconnues sont
refusées. Aucun fichier Apache actif n'a été modifié.

## Preuves et limites

Les suites ciblées couvrent contrats, runtime, middleware, API, annuaire, ACL,
MFA, rate-limit, sessions, Socket.IO sur loopback, commandes natives, B2C et
OpenAPI. Les tests navigateur interceptent leurs API et n'utilisent pas de base
réelle. Ils couvrent administration, bascule, navigation Clients EC et création
d'un particulier ; leurs captures sont locales au frontend dans `test-results`.

Résultats de qualification locale du 26 octobre (sans base ni API réelle) :

| Vérification | Résultat |
|---|---|
| Backend : entreprises, Directory, onboarding, B2C, commandes natives, ACL, sessions, Socket.IO, rate-limit, temps réel et OpenAPI | 400 tests, 54 fichiers, tous réussis |
| Régression acteur Directory / absence de copie CommonAccess en mode entreprise | 3 tests acteur réussis ; le test de projection légale a aussi été rejoué |
| Frontend : auth, HTTP, contexte, login, clients, administration, paramètres et onboarding | 316 tests, 49 fichiers, tous réussis |
| Playwright Chromium, API interceptée sur Vite loopback | 1 scénario réussi : administration, bascule, navigation EC et POST B2C |
| Générateur de routage fixe Apache | 6 tests Node réussis |
| Build backend et inventaire OpenAPI | Réussis ; 1 611 opérations inventoriées, contrat validé |
| Build web et frontière données source/bundle | Réussis ; avertissements Vite de taille de chunks conservés |
| Typecheck frontend complet (`tsc -b`) | Réussi après correction des types du bootstrap et de la fixture |
| Collection backend | 894 fichiers collectés ; ce contrôle n'exécute pas l'ensemble des tests |
| ESLint des fichiers source TypeScript modifiés/ajoutés, architecture, secrets | Réussis |

Les journaux de tests négatifs (401, ACL, annuaire indisponible, retry temps réel)
sont attendus. Les tests de fiches/paramètres existants émettent aussi des
diagnostics de réseau simulé et React `act` ; aucune erreur non traitée Vitest
n'est présente dans le résultat final. Le contrôle documentaire valide son
baseline contrôlé mais ne détecte pas le diff local : il ne constitue pas une
preuve de couverture documentaire du lot.

Les scripts PGlite exécutent du SQL PostgreSQL sur des fixtures synthétiques :

```text
scripts/e2e/business-companies-1454-pglite.mjs
scripts/e2e/read-switch-state-1454-pglite.cjs
scripts/e2e/company-directory-sites-1454-pglite.mjs
scripts/e2e/client-person-types-1454-pglite.mjs
```

Ils vérifient notamment contraintes, permissions, garde de rollback, assurance
MFA nullable complète, deux branches de `readSwitchState` et INSERT client natif.
Le script de vérification Directory est exécuté ; retirer seulement SELECT
alors qu'INSERT/UPDATE subsistent doit le faire échouer. Les quatre harnesses
terminent avec succès. Ils utilisent une dépendance PGlite temporaire hors dépôt,
désignée par `CERP_PGLITE_NODE_MODULES`, sans modifier le manifest ni le lockfile.
Le garde de nom des bases dédiées est testé puis neutralisé uniquement dans la
copie en mémoire de la fixture ; le fichier source n'est pas modifié. PGlite
Windows émet des diagnostics de chemin de son runtime, malgré la réussite des
assertions et un exit code 0. Ces scénarios ne prouvent ni le routage de vrais
services, ni des transactions concurrentes multi-processus, ni une restauration.

Le correctif temps réel `f15d7738` et la supervision `b347cdf6` sont préservés
dans les commits locaux séparés `afb82bf6` et `6a6a0ddf`. Les 30 tests Python de supervision passent.
Aucun constat de santé serveur frais n'est déduit de ces tests locaux.

## Travail commercial restant

Le bridge achat EC → demande CRP, approbation, reprise native, confirmations
d'expédition, projection de stock et documents EC n'est pas raccordé. Les
contrats purs constituent la spécification, pas un échange inter-bases déployé.
Une première ébauche non qualifiée a été retirée. La création de commande native
a seulement été extraite en primitive transactionnelle, avec le corps métier
ordinaire conservé ; aucun raccourci financier ou industriel n'est actif.

La boutique finale est un chantier ultérieur. Les tarifs CRP → EC et la présence
des références/variantes dans le catalogue CRP restent à préciser. Aucun tarif,
client, fournisseur, mapping de pièce ou compte réel n'a été inventé.

La prochaine tranche doit résoudre les identifiants client/fournisseur et les
bindings de références côté serveur, capturer les prix/TVA/conditions applicables,
puis créer la commande CRP via la primitive native dans la transaction de
consommation idempotente. Les notifications utilisent l'outbox native et une
action relative filtrée par module. Le BL, l'expédition et la facturation doivent
rejoindre leurs workflows existants ; ils ne peuvent pas être simulés par un
simple changement de statut de la demande inter-entreprises.

Les accès demandés pour Ghislaine, Thomas, Clément, Nizier, Lambert, Jean-Marie
et KEENAN restent à affecter aux profils réels lors d'une mise en service qualifiée.
Pas de migration réelle, de modification de services ou de production, de push,
de publication d'installateur ou d'écriture sur `Z:\CERP-INSTALLATION`.
