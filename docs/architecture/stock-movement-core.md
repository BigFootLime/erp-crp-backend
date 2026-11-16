# Noyau des mouvements de stock

L'incrément U11 #1512 isole le noyau transactionnel des mouvements de stock
dans `stock-movement-core.repository.ts`. La façade historique
`stock.repository.ts` conserve tous ses exports publics et ses signatures par
des imports et réexports nommés explicites. Les services et les autres
consommateurs conservent donc leurs imports existants.

Le noyau possède la création, la comptabilisation et la lecture de retour d'un
mouvement, avec leur fermeture de verrous, idempotence, audit, outbox, CUMP,
matière, assemblage et contrôles de réception. Les corps SQL, paramètres et
politiques restent identiques. Lorsqu'un client PostgreSQL est fourni, le noyau
ne commence, ne valide, n'annule ni ne libère de transaction : le propriétaire
reste l'appelant. Sans client fourni, le comportement historique de transaction
propriétaire est conservé.

La répartition d'une réception vers ses pistes importe ce noyau directement.
Le graphe runtime compilé ne peut ainsi plus atteindre la façade Stock depuis
`receipt-lane-transfer.repository.js`; il supprime le chemin ciblé
réception-piste → Stock façade. La réconciliation de lots libérés, hors de ces
commandes, possède désormais une feuille de production dédiée ; ses effets
métier restent conservés.

Cette étape est structurelle : routes, API, SQL, droits, règles OF/Qualité,
ordre des verrous, audit, idempotence et effets stock restent inchangés. Les
autres travaux U11 sur le cycle de commandes, ainsi que les grands dépôts
Commandes et Livraisons, restent ouverts.

Le lot #1562 donne aux dix operations Magasins/Emplacements un proprietaire
`stock-locations.repository.ts`, importe directement par le service Stock et
les traitements de reception concernes. La facade garde ses exports publics.
Le proprietaire locations ne depend ni de la facade ni du noyau des mouvements.

`stock-persistence.repository.ts` porte une seule definition d'AuditContext,
du predicat d'unicite PostgreSQL et de l'insertion d'audit. Le noyau importe et
reexporte directement ces memes liaisons pour ses consommateurs historiques.
`stock-query.repository.ts` porte les deux fonctions partagees de tri et de
filtre, utilisees par la facade et le proprietaire locations, sans copies.
Les declarations, corps SQL, parametres et frontieres transactionnelles restent
identiques. Les tests de routes simulees et de transactions simulees ne sont
pas presentes comme des executions PostgreSQL reelles ; celles-ci ont leurs
recus de fixture isolee distincts.

La consolidation #1562 complète cette répartition sans changer l'API publique :

| Ressource | Propriétaire |
|---|---|
| Référentiels et familles matière | `stock-material-referentials.repository.ts` |
| Création, sous-types, versions et cycle de vie des articles | `stock-article-lifecycle.repository.ts` |
| Sessions et lignes d'inventaire | `stock-inventory-sessions.repository.ts` |
| Inventaire consolidé, balances, analyses et liste des mouvements | `stock-reporting.repository.ts` |
| Écritures et téléchargements de documents | `stock-documents.repository.ts` |
| Lecture des documents article partagée avec les inventaires | `stock-document-reads.repository.ts` |
| Ouvertures historiques OLD/NEW | `stock-historical-openings.repository.ts` |
| Prévisualisation, compensation et annulation des mouvements | `stock-movement-corrections.repository.ts` |
| Lots, généalogie et libération qualité | `stock-lots.repository.ts` |

`stock-article-projection.ts` possède une seule projection matière historique et
une seule définition de `pieceClientCodeSql`. Les lectures consolidées et les
ouvertures historiques dépendent directement de cette feuille stable. Le cycle
de vie des articles conserve ses liaisons de compatibilité vers ces mêmes
fonctions ; il ne les recopie pas. `stock-schema.repository.ts` porte l'unique
détection de colonne partagée.

`production-receipt-lot-reconciliation.repository.ts` porte la réconciliation
des réceptions libérées et ses aides, sous le client transactionnel de l'appelant.
Les consommateurs Qualité importent cette feuille sans déplacer leurs contrôles
d'accès, verrous, réservations, allocations, audit ou outbox. La préparation et
la validation d'un OF restent accessibles à tout utilisateur authentifié ayant
accès à cet OF ; aucun visa Qualité n'est réintroduit.

Les anciennes façades restent des points d'entrée de compatibilité vers les
mêmes liaisons nommées. Les contrats de lecture, les liens optionnels
sous-état/état, les paramètres SQL et la propriété des transactions sont conservés.
Les preuves de source, tests simulés et tests PostgreSQL détenus sont consignés
séparément. Cette documentation décrit la source de consolidation non publiée,
sans autoriser de déploiement, migration ou publication d'installateur.
