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
commandes, reste dans la façade Stock et les effets métier ne sont pas retirés.

Cette étape est structurelle : routes, API, SQL, droits, règles OF/Qualité,
ordre des verrous, audit, idempotence et effets stock restent inchangés. Les
autres travaux U11 sur le cycle de commandes, ainsi que les grands dépôts
Commandes et Livraisons, restent ouverts.
