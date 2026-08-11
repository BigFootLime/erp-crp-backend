# ADR-0060 — Centre de préparation de la production

- Statut : accepté
- Date : 2026-08-11
- Décideur métier : Keenan Martin
- Périmètre : calendriers de production, centres de frais et taux horaires
- Ticket : [BigFootLime/crp-systems-web#543](https://github.com/BigFootLime/crp-systems-web/issues/543)

## Contexte

Le gate SOL-06 sait interdire un lancement de production lorsque les référentiels indispensables sont absents. Les calendriers réels, les centres de frais et leurs taux horaires ne peuvent toutefois pas être inventés par une migration : un horaire fictif fausse la capacité et un taux nul fausse la valorisation.

Le défaut précédent était double : l'utilisateur découvrait le prérequis trop tard et le preflight de migration considérait l'absence de ces valeurs comme un motif empêchant d'installer le mécanisme qui devait justement les contrôler.

## Décision

1. La base et l'API restent la source autoritaire de l'état de préparation du flux `PRODUCTION`.
2. Le patch de structure peut être installé sans calendrier ni taux réel. L'absence est rapportée comme un état métier incomplet ; elle bloque les écritures critiques via les triggers existants, pas l'installation du gate.
3. Tout utilisateur du module Production voit une alerte persistante et un centre de préparation indiquant définition, unité, période, source, fraîcheur, fiabilité, valeur observée et valeur attendue.
4. Chaque manque fournit une action directe vers l'écran pertinent. L'action n'est proposée que si le rôle possède la capacité serveur correspondante.
5. Les calendriers sont saisis explicitement en fuseau `Europe/Paris`, avec jours ouvrés et plages horaires non préremplis. Les créations et fermetures sont idempotentes et auditées ; les mises à jour utilisent un verrou optimiste.
6. Les centres de frais conservent le RBAC Méthodes existant. Un taux courant doit être strictement positif et porter une source ; `0` est traité comme une donnée manquante.
7. Une valeur saisie par un responsable est qualifiée `DECLARED`. Les référentiels contrôlés par contrainte ou règle système sont qualifiés `VERIFIED`. Une absence n'est jamais convertie en zéro.
8. L'isolation actuelle est une base par société/environnement. Aucune donnée de préparation n'est partagée entre bases.

## Options écartées

- Seeder un calendrier ou un taux de démonstration : capacité et coûts mensongers.
- Bloquer uniquement dans le frontend : contournable par appel API ou job.
- Bloquer l'installation du patch si les valeurs manquent : empêche de déployer l'aide à la correction.
- Donner les droits financiers à tout responsable de production : violation de la séparation des responsabilités.
- Masquer l'alerte : reporte le défaut au moment le plus coûteux, le lancement de l'OF.

## Conséquences

Le déploiement est additif et compatible avec la version précédente. Une base incomplète reste utilisable pour la consultation et le paramétrage, mais les flux protégés refusent de démarrer avec un message actionnable. Les valeurs réelles restent à fournir par l'entreprise pilote.

## Déploiement et retour arrière

Le patch `20260811_production_readiness_center.sql` est appliqué après sauvegarde, preflight en lecture seule et vérification de son empreinte. La validation post-migration exécute le fichier `.verify.sql` puis les contrôles d'intégrité. Le rollback SQL fourni est réservé à `cerp_test`; en production, le retour arrière réaliste restaure la sauvegarde dans une base neuve puis redéploie l'artefact précédent.
