# Comptes communs à Production et aux bases Test — #1407

Project Office : `CERP / AUTH-DUAL-ACCESS-20261022`, suivi local en l'absence de
session Project Office. Issue frontend associée : #1725. Livraison 2.0.15
autorisée par Keenan ; le bleu/vert est suivi séparément par le chat d'audit.

## Cause et décision

L'inventaire en lecture seule a confirmé cinq comptes approuvés avec adhésion
Production active sans adhésion Test. Seul le propriétaire recevait
automatiquement les deux accès. Les mots de passe, PIN et facteurs étaient déjà
uniques dans Directory ; il ne faut pas les recopier ou les réinitialiser.

Une approbation prépare puis active Production et le Test fixe atomiquement.
Les autres Test enregistrés créent leur adhésion au premier accès depuis
l'adhésion Production active, avec les mêmes fonctions et le véritable statut
SuperAdmin. Les statuts Test explicitement inactifs/bloqués restent prioritaires.
Une inscription uniquement Test ne peut pas créer d'adhésion Production.
La désactivation Production rend les sessions de ses bases Test inutilisables.

Les droits fermés de modules et les capacités sensibles courants proviennent de
Production, et non de l'ancienne décision d'approbation. Directory les demande
à l'API locale `http://127.0.0.1:8080/internal/cerp/common-access-v1`, puis les
relaie au Test authentifié. MAC distincts pour source et relais, nonce propre
à chaque requête, profil/annuaire/base/horodatage et empreinte lient la réponse.
Le snapshot PostgreSQL est cohérent avec l'époque d'autorisation de Production.
Une transaction de projection locale ferme les modules absents, remplace les
capacités et journalise l'époque et l'empreinte. Une ancienne réponse ne peut
pas rétablir un droit révoqué. La télémétrie publique est normalisée par
`clientAuditEvent` et ne peut pas forger l'action serveur de projection.

L'opération précède l'émission du JWT et les contrôles HTTP/acteur temps réel.
Les propriétaires dont le statut SuperAdmin est confirmé par Directory ne
dépendent pas d'un catalogue local pour leur accès complet. Les modifications
de modules/capacités se font en Production. Une indisponibilité de source donne
503 sans convertir le problème en mot de passe invalide ou supprimer la session.

Une preuve d'installation appairée depuis Production (ou créée par un
propriétaire Production) sert sur les bases réellement enregistrées. Les
inscriptions Test indépendantes ne peuvent pas créer de preuve valable pour
Production. Secrets d'appareil et révocations restent communs ; chaque défi MFA
et session reste lié à la base cible. Aucun choix d'utilisateur n'est ajouté
au parcours PIN seul.

## Qualification

Tests unitaires : protocole MAC, rejouabilité, binding, panne de source,
projection fermée, révocation, fonctions et appairage. Le script
`scripts/managed-tests/check-common-access-http-1407.cjs` utilise uniquement le
cluster Docker jetable possédé `cerp-dual-access-1407-pg`, lié à
`127.0.0.1:28647`, avec mots de passe synthétiques non affichés. Son template
est reconstruit du cache de schéma seul SHA-256
`c01b68778568d0569eb0bc10773ed0e46108e63a8469837aef3a510a1a0b5475` ; aucune
donnée métier n'est importée. Il exerce les vraies fonctions PostgreSQL et les
appels HTTP signés sur Production, Test fixe et un Test supplémentaire.

Premier passage complet Windows : 8 464 tests réussis, trois délais de scans
de sources dépassés sous concurrence ; les sept contrôles concernés réussissent
en relance ciblée. Le gate canonique sur les sources figées reste requis.

## Livraison et retour

Aucune migration de schéma. Conserver Directory PIN-v2 et sa clé, facteurs,
credentials et appareils. Préparer les sources depuis les main publiés 2.0.14
pour exclure la reprise métier non livrée de dev ; reporter ensuite le correctif
dans dev. Qualifier les branches release puis les arbres main identiques.

L'API Production portant la source de droits et le Directory portant le relais
doivent être disponibles avant qu'une API Test 2.0.15 l'utilise. Le futur
bleu/vert doit préserver la façade privée stable localhost8080. Ne pas lancer
deux API 2.0.14 sous des variables de standby que cette version ne comprend pas.
Réconcilier les adhésions manquantes des cinq comptes approuvés par ajout
conditionnel audité, en préservant les statuts explicites et les credentials.
Essai PostgreSQL/HTTP isolé : 35 contrôles réussis, incluant approbation,
trois bases, un seul facteur, mot de passe et PIN sans changement de compte,
appairage commun, défis liés à leur cible, révocation avec session existante,
idempotence, panne temporaire, blocage explicite et refus de base inconnue.
Les preuves de qualification locale ne constituent pas une preuve de déploiement.
