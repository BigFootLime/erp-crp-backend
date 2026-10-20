# Revue de préparation — sécurité, GED et RGPD

Date de revue : 20 octobre 2026. Portée : code du backend présent, configuration et états de services lus sur HYPERBOX2. Cette note ne constitue ni une certification ISO 27001, ni une déclaration de conformité RGPD.

## Éléments confirmés

### Habilitations et MFA

- Le contrôle actuel est explicite par compte et par module : `access-control.service.ts` refuse un module actif sans décision `GRANTED`; un SuperAdmin demeure autorisé. La garde HTTP renvoie `403` si aucune décision autorisée n’est trouvée et `503` si l’infrastructure d’accès est absente. Les décisions sont relues à partir de PostgreSQL et le cache s’appuie sur l’epoch d’autorisation.
- La lecture live du 20 octobre à 11:15 CEST confirme : 1 compte actif, 1 SuperAdmin, 25 modules actifs, 7 attributions explicites, 0 refus explicite, 9 événements d’audit de la matrice. Le kill-switch `CERP_MODULE_ACCESS_GATE_DISABLED=1` n’est pas configuré dans les unités inspectées.
- Les capacités sensibles (journal global, gestion des demandes RGPD, données RH) existent et sont protégées par une vérification MFA. L’ADR-0078 documente chiffrement des graines TOTP, codes de secours hachés, anti-rejeu et révocation de session.

La note `docs/module-access-catalog.md` a été révisée : l’ancienne règle d’accès par défaut ouvert y est désormais explicitement historique. La procédure opératoire doit s’appuyer sur la règle actuelle, explicitement accordée par compte et module.

### Sauvegardes et GED

- À 11:14 CEST, les minuteries actives `cerp-backup-full` et `cerp-backup-shared-directory` avaient chacune leur dernier déclenchement réussi le même jour. La première est planifiée toutes les 30 minutes ; le miroir PostgreSQL vers Z a aussi réussi dans la nuit.
- Le service de sauvegarde complète mentionne la GED et les métadonnées récentes de sauvegarde portent un marqueur GED. Le code `scripts/backup/recovery-set.mjs` contrôle les tables GED, les références de stockage et impose une restauration vers une base isolée.
- Les minuteries GED dédiées `cerp-ged-backup@prod` et `cerp-ged-verify@prod` sont désactivées. Ce fait seul ne prouve donc pas une défaillance puisque la sauvegarde complète inclut la GED ; il retire toutefois une vérification indépendante périodique.
- Des preuves de répétition de restauration existent sur le serveur, les dernières identifiées datant du 14 et du 17 octobre.
- Le 20 octobre à 09:59 UTC, un exercice complet isolé a été exécuté depuis le jeu courant. La cible portait un nom de récupération dédié, distinct de la production et des tests, puis a été supprimée après contrôle. Les références GED ont été vérifiées par l’outil de reprise ; les empreintes du dump, du catalogue et des références de documents ont été vérifiées ; 703 tables métier et six comptages critiques concordaient après restauration. L’exercice a pris 37 secondes sur ce serveur, sans démontrer à lui seul un RTO de quatre heures en conditions d’incident ou une lecture authentifiée d’un document restauré.
- Le wrapper standard atteint la vérification GED mais tente de restaurer PostgreSQL avec le rôle applicatif, qui ne peut pas créer l’extension `btree_gist`. Pour l’exercice isolé, la restauration du dump a donc été finalisée sous le compte de service PostgreSQL, sans modifier aucun rôle ni base active. La procédure de restauration doit être corrigée et retestée pour intégrer ce cas sans intervention manuelle.

## Protections de l'assistant de reprise qualifiées en développement

La revue du 20 octobre couvre le nouveau circuit de préparation et de chargement, sur des bases locales isolées. Elle ne remplace pas une nouvelle recette des autres modules de l'ERP ni une preuve de déploiement.

- Les collaborateurs n'accèdent qu'aux domaines qui leur sont attribués. Les rapprochements vers des fiches CERP existantes, les justificatifs, les exports complets, les validations et les chargements restent réservés au SuperAdmin ; les actions sensibles exigent un MFA récent.
- Les contrôles de saisie sont appliqués côté serveur : champs autorisés, types, dates réelles, quantités et reliquats cohérents, décimales sans arrondi implicite, unités du référentiel, familles d'articles actives et cibles natives confirmées. Une fiche incomplète peut rester en brouillon ; elle ne peut pas être chargée.
- Une transaction unique conserve les écritures natives, les correspondances, les sources et le reçu d'application. Les essais couvrent les relances concurrentes, le retour arrière sur échec, l'accusé de validation perdu et les anciennes références différentes désignant un même client et PO.
- Sur une copie vide de la structure réelle (703 tables), le parcours client → pièce technique → article → commande de reliquat a été exécuté avec les validateurs et les écritures natifs. Les liens réels concordent ; aucun OF, BL, mouvement de stock ou AR n'est créé par cette préparation de commande.
- Les essais OLD matière et pièce finie vérifient le lot, l'unité, la propriété, la version technique exacte et la conservation des références de traçabilité. Une unité incompatible ou une version appartenant à une autre pièce est refusée sans mouvement créé.
- Les justificatifs liés à une fiche de reprise restent privés au SuperAdmin, y compris les métadonnées, l'historique, le contenu et la quarantaine antivirus. Les empreintes et versions utilisées sont figées dans la préparation.
- Le premier dépôt de préparation place un verrou financier persistant en `PREPARING`, dans la même transaction que le dossier. Le client affiche l'avertissement avant dépôt ; le serveur refuse alors les nouvelles émissions jusqu'à l'activation distincte des séries vérifiées. Une nouvelle reprise ne remet jamais une série `ACTIVE` en préparation. Les migrations seules laissent le verrou `IDLE` et ne suspendent pas une installation existante.

Les états d'encours et financiers restent des états à rapprocher : ils ne reprennent pas automatiquement un OF en cours ni une écriture comptable native. Les durées de conservation et le traitement des demandes portant sur les sources de reprise doivent être inclus dans la politique RGPD restant à approuver. Les numéros proposés ne constituent pas des compteurs activés.

## Écarts et actions avant de déclarer une conformité

| Priorité | Écart à fermer | Preuve attendue |
|---|---|---|
| Haute | Finaliser la qualification de restauration : le test isolé courant a validé les blobs/références GED, empreintes et base ; il reste la lecture authentifiée d’un document restauré et la correction du wrapper pour les extensions PostgreSQL. | Rapport daté de `recovery-set`, hash du dump, résultat GED, lecture authentifiée et approbation opérateur. |
| Haute | Définir et tester le retour des données de bascule. Le bleu/vert logiciel ne remplace pas ce retour. | Procédure arrêtée, sauvegarde pré-import, exercice sur base isolée et décision de correction ciblée après ouverture. |
| Haute | Établir le registre des traitements réellement exercés par Croix-Rousse Précision : salariés, clients/contacts, fournisseurs, pointages, GED, authentification, télémétrie. | Registre daté avec finalité, base légale, catégories, destinataires, durée, mesures et responsable. |
| Haute | Mettre à disposition les mentions d’information et le circuit de traitement des demandes d’accès, rectification, opposition, effacement ou limitation. Une capacité nommée `privacy.manage` ne constitue pas à elle seule un processus de droits des personnes. | Page/notice, canal de réception, responsable, registre des demandes et modèle de réponse. |
| Moyenne | Fixer et appliquer les règles de conservation par catégorie, y compris journaux, comptes inactifs, documents GED et données RH. | Politique approuvée, paramètres/tâches de purge, exceptions légales et preuves d’exécution. |
| Moyenne | Réviser la documentation d’accès ancienne et conserver la matrice nominative approuvée, avec revue périodique. | Version de la matrice, événement d’audit et revue signée. |
| Moyenne | Qualifier les routes de chaque module sur la version figée : accès accordé, accès refusé, lien direct, WebSocket et erreur sans fuite de données. | Résultat de recette 200/403/503 par périmètre et version. |

## Références externes à utiliser pour la gouvernance

- Le [registre des activités de traitement de la CNIL](https://www.cnil.fr/fr/RGPD-le-registre-des-activites-de-traitement) couvre notamment finalités, catégories de données, destinataires, durées et mesures de sécurité.
- La [CNIL sur les durées de conservation](https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees) rappelle que les données ne doivent pas être conservées indéfiniment et que la durée dépend de la finalité.
- Le [guide de sécurité des données personnelles de la CNIL](https://www.cnil.fr/fr/guide-de-la-securite-des-donnees-personnelles) recommande notamment la traçabilité des opérations et la capacité à traiter les incidents.
- Les articles 5, 30, 32 et 33 du [RGPD (règlement UE 2016/679)](https://eur-lex.europa.eu/eli/reg/2016/679/oj) cadrent respectivement les principes, le registre, la sécurité et la notification des violations.

## Décision de publication

Les protections techniques observées soutiennent une publication contrôlée de l’assistant de reprise, mais l’organisation ne doit pas annoncer une conformité ISO 27001 ou RGPD complète tant que les preuves et actions ci-dessus ne sont pas fermées. Aucun réglage de production, donnée métier, compte ou planification n’a été modifié dans cette revue.
