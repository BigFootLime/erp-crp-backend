# Réception des pièces — mise en service #1069

Le BL constate la livraison et réduit le solde fournisseur. Pour les pièces achetées et les retours de sous-traitance, seule la commande explicite d’entrée, après contrôle et emballage, crée du stock **MP**. L’article fini, son historique et le propriétaire du lot ne sont pas reclassés.

## Contrats et registres

- Politique serveur figée sur la commande puis la réception : `STANDARD` ou `PIECES_CONTROLE_EMBALLAGE`. Le tag Consommables et le raccordement outillage conservent le parcours standard. Les achats de pièces, articles finis, achats/reventes et retours de sous-traitance prennent le parcours des pièces.
- Les quantités de traitement sont en unité de réception ; la conversion figée donne l’unité de stock et celle du contrôle. `stockée ≤ emballée ≤ acceptée ≤ reçue`. Plusieurs emballages et portions sont possibles.
- `quality_control` et ses décisions restent autoritaires. L’emballage conserve leurs identifiants ; chaque entrée crée ses sous-lots MP, sa généalogie et un seul mouvement. Les réservations des besoins OF suivent les portions MP, sans réserver le surplus dû au minimum ou au conditionnement fournisseur.
- L’outil utilise exclusivement `gestion_outils_stock` et son journal existant. Le raccordement à un article Consommables doit précéder son premier achat ; les références déjà utilisées demandent une reprise étudiée, sans fusion automatique des stocks.
- Une NC de rejet avant stock conserve sa disposition `SCRAP`/`RETURN_SUPPLIER` sans mouvement de sortie fictif. Sa quantité est limitée aux pièces non acceptées et non déjà traitées. La clôture attend le traitement et la clôture des NC.
- `article_client_links` porte les clients commerciaux multiples. `commercial_scope=CRP` exige `internal_reference` et aucun client. Les associations fiables de l’ancienne PT sont reprises ; les autres articles finis restent à qualifier.

## Déploiement

1. Sauvegarder la base et les documents, vérifier leur restauration dans un environnement isolé. Examiner les dépendances et les SHA-256 avec le runner canonique `scripts/db-patches.js` et l’inventaire `scripts/migrations/release-gate.js`.
2. Exécuter le précontrôle `db/patches/support/20260914_receipt_processing_1069.preflight.sql`. Corriger les instantanés d’unités manquants dans leur parcours de reprise existant. Exporter la liste des réceptions ouvertes et des quantités déjà stockées.
3. Pendant une fenêtre sans écritures de réception, appliquer la migration additive `20260914_receipt_processing_1069.sql` avec le runner canonique. Elle prend des verrous de tables/index ; `lock_timeout=10s` provoque un abandon transactionnel si nécessaire. Ne pas modifier un patch enregistré : utiliser un nouveau patch correctif.
4. Déployer le serveur compatible et ses protections communes, puis le web et l’APK Réception compatibles. Les anciennes routes d’entrée passent aussi par ces protections. Les anciens clients ne pourront pas mettre les pièces en stock avant la fin du nouveau parcours.
5. Exécuter le script `.verify.sql`, traiter la reprise ci-dessous, puis la recette. Les clients Android doivent être connectés, appairés et identifiés personnellement. Les règles de contrôle/libération et l’exception superadministrateur justifiée existante restent applicables.

## Réceptions ouvertes et historique

La migration ne crée ni contrôle accepté ni emballage pour l’historique. Les lignes ouvertes concernées sont marquées « reprise à vérifier ».

- **Aucune entrée historique** : rattacher la référence MP et, pour la sous-traitance, les origines. Joindre les preuves au BL. Une personne habilitée confirme « Valider la reprise » avec sa justification ; cette action seule ne libère rien. Réutiliser le contrôle existant valide ou le réaliser, puis saisir et valider les emballages réellement constatés. Enfin confirmer l’entrée MP.
- **Retour déjà enregistré dans le dossier de sous-traitance** : sélectionner son événement RETURN, puis les lots ISSUE. Le service rattache l’événement disponible, sans répéter le retour. Un dossier clos ou une origine ambiguë reste à examiner.
- **Entrée historique totale ou partielle** : conserver les mouvements, les catégories et les consommations. La reprise automatique est volontairement refusée. La liste `HISTORICAL_STOCK_REVIEW` sert au rapprochement par le magasin et la qualité. Documenter les contrôles/emballages retrouvés, l’état physique, les réservations et les éventuelles corrections nécessaires. Tout ajustement de stock doit passer par le circuit de correction audité existant, avec un cas de reprise spécifique validé avant migration complémentaire ; ne jamais effacer le mouvement initial ou fabriquer une preuve. Une ligne partiellement stockée reste bloquée jusqu’à ce rapprochement.
- **Emballage erroné avant stock** : annuler cet emballage avec un motif, puis enregistrer le bon. Un emballage ayant alimenté le stock ne peut plus être annulé.
- **Après stock** : conserver la chaîne et utiliser une correction de stock tracée. Une diminution ne rend pas à nouveau la quantité réceptionnée stockable. Une augmentation directe sur le lot reçu ou sa portion est refusée ; il faut un nouveau parcours de réception justifié pour une nouvelle quantité.

En cas de difficulté de mise en service, suspendre les écritures et conserver les protections serveur. Le script de rollback refuse volontairement de supprimer ces protections. Restaurer une sauvegarde seulement dans le cadre d’une intervention approuvée, après prise en compte des écritures postérieures.

## API

Base web : `/api/v1/receptions`. Base tablette : `/api/v1/terminals/reception`, avec secret d’appareil et session personnelle. Les droits de réception commandent les écritures ; les capacités Qualité restent distinctes.

`GET /processing?q=...&stage=TO_PACK&page=1&pageSize=30` expose les quantités, blocages, actions autorisées et versions. Une ligne peut figurer dans plusieurs files de quantités. La recherche accepte une référence ou une étiquette CERP active d’article, lot, commande ou OF. `GET /:id/lines/:lineId/processing` relit la ligne avant action.

Les POST `/:id/lines/:lineId/{action}` exigent `idempotencyKey` (UUID) et `expectedVersion` :

| Action | Données supplémentaires |
|---|---|
| `pack` | `quantity`, `packaging`, `packageCount`, `notes?` |
| `stock` | `quantity`, `magasinId`, `emplacementId` |
| `tool-stock` | `quantity` |
| `stock-article` | `stockArticleId` |
| `subcontract-origins` | `origins: [{issueEventId, quantity}]`, `returnEventId?` |
| `reconcile-processing` | `reason` |
| `void-packaging` | `packagingId`, `reason` |

Après perte réseau, réutiliser la même clé et le même corps ; après conflit de version, relire avant nouvelle confirmation. Aucun état optimiste ne prouve une écriture. La réponse d’emballage n’est pas une entrée en stock. Le contrat OpenAPI généré décrit ces opérations ; le terminal prolonge les API Qualité existantes sous `/quality/executions`.

## Recette obligatoire

Effectuer un achat de pièces et un retour de sous-traitance. Après BL : zéro stock. Après contrôle seul : stock refusé. Après emballage : zéro stock jusqu’à confirmation explicite. Rejouer `100 reçues / 60 acceptées / 50 emballées`, une tentative de 51, deux confirmations simultanées et une réponse réseau perdue. Vérifier MP, généalogie, OF/opération/ISSUE/RETURN, destinataires des besoins, BL mixte et stock outillage sans doublon. Vérifier le rejet pré-stock et la clôture avec NC ouverte/close. Tester CLIENTS avec plusieurs clients, CRP sans clients et les combinaisons refusées.

Répéter avec les rôles réels, le web et **une tablette Android physique**, y compris photo, scanner, PDF, déconnexion et changement d’opérateur. La tablette n’était pas disponible pendant l’implémentation : cette recette physique reste un critère de livraison non validé.

La répétition technique utilise uniquement `cerp_1069_test`, une copie de schéma sans données utilisateur. Lancer `node scripts/e2e/receipt-processing-1069.js` avec `DATABASE_URL` vers cette base dédiée après migrations. Ne jamais utiliser les anciennes suites PG à schéma réduit contre cette base complète.

Le déploiement de production et la synchronisation Project Office ne sont pas réalisés par ce travail local. Référence : issue frontend #1069, clé de travail `RECEPTION-PACKAGING-20260914`, CERP/WP-256.
