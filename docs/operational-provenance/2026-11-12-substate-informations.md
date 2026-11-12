# Informations des sous-états — livraison du 12 novembre 2026

L’utilisateur a explicitement autorisé l’ajout de la colonne facultative et le déploiement de CERP 2.0.84. Le changement est limité aux validateurs et au dépôt Stock natifs, à leurs types, au routeur de compatibilité EC et à la migration additive. Aucun changement d’authentification ou de permissions n’a été introduit.

- Source applicative backend : `9f1153d858f8bf27f666946f41866b77cdc21cf3`.
- Source applicative frontend : `89823700d65e0b9bd846dbe475b48020c1f7da7f`.
- Paquet backend SHA-256 : `8a98503ce18caae6d89d8449286c7a0e3292c548476c4dba9910e0cdc42a43d3`.
- Index frontend SHA-256 : `09e57c8ab9d8ef8173ebd4c18133821351c0c14149ac542c1101bd82e1088c19`.

Les bases CRP et EC, Test puis Production, présentent `informations text NULL` et la contrainte `stock_sous_etats_informations_length_check`. Les sauvegardes protégées et comparaisons avant/après sont conservées sur l’hôte dans `/mnt/data/cerp/backups/substate-informations-20261112-8a98503/`. Les valeurs préexistantes ont été comparées en excluant la seule nouvelle propriété nullable.

Les runtimes CRP natifs sont les copies `20261112-substate-informations-8a98503-crp-test/runtime` et `20261112-substate-informations-8a98503-crp-prod/runtime`. EC utilise les copies du runtime de compatibilité suffixées `substate-informations-8a98503` et `substate-informations-8a98503-prod`. Les drop-ins `~~substate-informations-8a98503.conf` changent uniquement ExecStart ; les répertoires de travail et fichiers d’environnement sont conservés. Les MainPID exécutés ont été contrôlés, les readiness répondent 200 et les requêtes anonymes aux sous-états restent à 401.

Le slot API VPS `cerp-api-substate-information-9f1153d8` reprend la configuration et les montages du slot précédent, avec uniquement les trois fichiers JavaScript Stock modifiés. Son inventaire de routes complet est conservé. Après readiness 200, refus anonyme 401 et vérification de l’identité de l’annuaire par appel signé, le proxy a été basculé atomiquement vers ce slot et l’interface `cerp-ui-substate-information-2.0.84-89823700`.

L’API VPS se connecte au même cluster et à la même base Production que CRP natif ; il n’existe pas de cinquième migration indépendante. L’annuaire et son fichier `recovery-email.env` restent hors périmètre.

Retour arrière : restaurer `/var/lib/cerp-release-backups/substate-informations-20261112/active-pair-before.yaml` pour le couple public, et retirer uniquement les nouveaux drop-ins ExecStart des services natifs avant reload/restart. Garder la colonne et sa contrainte pour éviter toute perte d’informations saisies après livraison.
