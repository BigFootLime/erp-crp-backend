# ADR-0977 — Journal CUMP sous propriétaire Stock

Statut : première étape de capture prête à livrer, projection CUMP non activée. Méthode métier acceptée dans ADR-0061. Issue #977, Project Office tâche 278.

## Sources constatées

Les estimations #967 utilisent une preuve de dernier mouvement et déclarent explicitement l'absence de CUMP. `postReceiptStockTx` prépare ses entrées avec un coût et une devise nuls. `repoPostMovement` centralise les mouvements standards, mais les transferts internes, ouvertures historiques et certains ajustements d'inventaire ont des écrivains POSTED propres. Un journal déclenché seulement au changement de statut d'un en-tête manquerait leurs lignes insérées ensuite. Leur inventaire et leur raccordement transactionnel sont nécessaires avant activation.

La réconciliation facture/réception des marges (#947) n'affecte pas des valeurs aux lots ni au stock. Elle ne peut donc pas servir silencieusement de journal de valorisation. Une commande ou un tarif proposé restent déclarés ; une valeur vérifiée nécessite son document effectivement contrôlé et relié. Aucune source catalogue ne remplace un prix de réception absent.

## Noyau déterministe préparé

`stock/domain/cump-valuation.ts` travaille en texte décimal PostgreSQL et BigInt, avec douze décimales internes. Il rejette un exposant, une virgule ou une précision excédentaire au lieu d'arrondir les entrées. La valeur de sortie partielle est proportionnelle à la valeur du stock avant sortie ; la dernière sortie reprend le reliquat exact. Le coût unitaire affichable est dérivé et arrondi, il ne doit pas remplacer le montant exact du journal.

Le périmètre inclut article, propriété COMPANY/CLIENT, unité canonique et devise. Aucune conversion ni répartition de frais n'est inventée par le noyau. Un transfert interne ne change pas la quantité et la valeur totales ; une restitution prend le coût de sa sortie originale fourni par l'adaptateur Stock. Une entrée sans prix, une ouverture OLD sans valeur justifiée ou un stock négatif laissent le CUMP inconnu. Un stock physiquement vide vaut zéro pour l'état futur ; cela ne valorise jamais rétroactivement les sorties inconnues.

Les fonctions sont internes, sans route HTTP ni activation de projection. `sourceRef` et `VERIFIED` seront produits par l'adaptateur, jamais acceptés d'un formulaire. Le noyau ne vérifie pas un document ni un lien original en base ; les propriétaires devront le faire sous verrous avant de l'appeler.

Le schéma réel Test/Production confirme des quantités et prix `numeric(18,6)`, des articles/mouvements/lots UUID, et une propriété client `lots.client_proprietaire_id` **varchar**. Le noyau conserve ce véritable code client sans le convertir en UUID ni modifier sa casse. Sa quantité financière devra correspondre à `qty_total - qty_depreciated` : SCRAP/DEPRECIATE diminuent le stock utilisable, en conservant le total physique. Les réservations ne diminuent pas la valeur.

## Capture transactionnelle future

La migration `20261008_stock_valuation_journal_977.sql` installe deux triggers de contrainte **différés en fin de transaction**, sur insertion POSTED ou transition vers POSTED. Ils capturent les lignes finalisées et enregistrent une preuve par mouvement, avec quantités/coûts en texte décimal, unités, propriété client, acteur original, documents, transfert et mouvement inversé. Le journal possède une empreinte SHA-256 ; ses guards empêchent une écriture de formulaire et toute modification/suppression/TRUNCATE d'une preuve.

Le guard des lignes verrouille leurs en-têtes dans l'ordre UUID et relit le journal : une modification concurrente ayant vu DRAFT avant la comptabilisation ne peut passer après sa capture. L'ajout tardif d'une ligne est couvert aussi. Les contrôles métier, droits et écritures physiques restent chez leurs propriétaires.

La migration attend les transactions de mouvement précédentes avec un verrou de relation borné à dix secondes. Elle fige les quantités d'ouverture des niveaux et des lots, puis installe la capture dans la même transaction. Les observations LEVEL contiennent déjà leurs BATCH et ne sont **jamais additionnées**. Aucune ouverture sans preuve ne reçoit un prix. La séquence représente l'ordre de capture, pas une date métier ni une valorisation rétroactive.

Les entrées restent `PENDING_VALUATION` ou `SOURCE_INCOMPLETE`. **Ce journal ne publie aucun CUMP, ne remplit aucun coût de sortie et n'améliore pas encore les marges.** Son diagnostic SQL est interne, sans nouvelle route HTTP.

| Écrivain POSTED | Propriétaire couvert par la capture |
| --- | --- |
| Standard, ouverture historique, transfert et inventaire | `stock/repository/stock.repository.ts` |
| Réception de fabrication | `production/repository/production-receipts.repository.ts` |
| Dispositions qualité | `qualite/repository/qualite.repository.ts` |
| Livraisons, allocations, annulations | `livraisons/repository/livraisons.repository.ts` |
| Expédition | `livraisons/repository/livraisons-shipment.repository.ts` |
| Réceptions fournisseur, consommables, débits, retours montage | Transactions utilisant Stock, parfois avec client PostgreSQL partagé |

## Raccordements restant nécessaires

1. Résoudre l'ouverture par article/propriétaire/unité, avec rapprochement LEVEL/BATCH et valeur historique inconnue conservée. Séparer la monnaie de valorisation des devises d'acquisition sans conversion implicite.
2. État et écritures de valorisation append-only sous verrous stables, avec quantités/montants exacts et versions de formule. Aucun CUMP connu si le delta physique n'est pas couvert. Les deux jambes de transfert doivent être neutres, les retours reliés au montant exact d'origine.
3. Montant d'acquisition justifié de réception, devise et conversion dans l'unité stock. Distinguer quantité commandée, reçue, facturée, frais/forfait alloués et propriété client. Les unités de lignes de mouvement existantes ne transportent pas nécessairement la précision du journal : lire son montant exact pour les marges.
4. Compensation/restitution reliée exactement à la sortie d'origine, transferts internes neutres et corrections de valeur append-only avec preuves. Idempotence transactionnelle et aucun coût libre opérateur.
5. Projections stock/marges honnêtes avec les droits existants ; interface structurée de justification des ouvertures inconnues ; aucun statut VERIFIED avant les preuves réellement raccordées.

## Validation

TypeScript passe. Les DDL et le diagnostic SQL ont été compilés sur Test et Production dans une transaction **ROLLBACK**, sans commande métier ni activation conservée. Scénarios Vitest et recette transactionnelle préparés dans `docs/testing/stock-valuation-journal-977.md`, **non exécutés**, suivant l'instruction humaine de recette finale commune. Cette étape de capture seule n'établit pas la conformité CUMP du flux complet.

Le rollback vide est réservé à Test/dev et refuse d'effacer un journal contenant une preuve. Après capture réelle, conserver les tables compatibles avec l'ancien backend ou utiliser la sauvegarde pré-déploiement selon la procédure de récupération.
