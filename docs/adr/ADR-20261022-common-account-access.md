# ADR — Droits communs des comptes Production et Test

Date : 2026-10-22. État : implémenté, qualification de livraison requise.
Demande humaine explicite : mêmes comptes, PIN, MFA et accès pour toutes les
bases, comme le compte propriétaire. Issues backend #1407 / frontend #1725.

## Décision

Directory demeure seul propriétaire des credentials et facteurs. L'adhésion
Production active détermine les fonctions et le statut SuperAdmin des adhésions
Test actives, sur les bases authentifiées par leurs clés d'appel enregistrées.
Les adhésions explicitement bloquées/inactives restent prioritaires. Les comptes
Test indépendants restent isolés de Production.

L'API Production demeure propriétaire des ACL de modules et capacités sensibles
existantes ; aucune copie historique d'approbation ne remplace ses décisions.
Un endpoint privé signé lit un snapshot cohérent de l'époque et des droits,
Directory le relaie signé au Test cible, et celui-ci projette la sélection
fermée avant autorisation. Les deux signatures utilisent des domaines distincts
et lient le nonce de requête au corps exact. Le corps lie annuaire, profil, base,
époque, empreinte et instant de génération. La source est une façade locale fixe
8080, sans URL contrôlée par un client et sans redirection HTTP.

La projection utilise les tables existantes et journalise une action serveur
atomique avec ses écritures, attribuée au compte projeté. Cette action ne peut
pas être produite par la télémétrie publique, normalisée par clientAuditEvent.
Les époques anciennes et les empreintes contradictoires sont refusées. Une
source indisponible produit 503 ; aucune ancienne autorisation n'est réutilisée.
L'autorité SuperAdmin confirmée par Directory ouvre déjà le catalogue complet
et ne dépend pas de cette projection de module.

## Conséquences

Aucune migration ni réplication de secrets. Les droits se modifient en Production
et se propagent aux bases Test à leur prochain contrôle. L'API Test d'un compte
ordinaire dépend donc de l'API Production et de Directory pour chaque décision.
Le futur déploiement bleu/vert doit conserver la façade privée localhost8080.
L'ordre de déploiement doit rendre la source Production et le relais Directory
disponibles avant l'API Test correspondante.

L'installation appairée reste neutre : une création autorisée par Production
permet le même secret d'appareil sur les sites enregistrés, sans supprimer le
MFA du compte. Les défis et sessions restent liés à leur cible. La révocation
du secret/PIN garde son effet commun à toutes les bases.
