# ADR-0983 — Projecteur transactionnel du CUMP Stock

Statut : lot de préparation. Issue backend #983 ; Project Office WP278. Le mode livré est **PREPARED**, sans activation ni CUMP publié. Les raccordements du flux complet #977 restent en cours.

## Propriétaire et preuves

Stock possède les états et les écritures de valorisation. La migration ajoute les entrées immuables, soldes par article/propriétaire/unité/devise, curseurs de frais de ligne fournisseur et de restitution. Aucun formulaire ni route HTTP ne fournit un coût ou une fiabilité. Le noyau décimal est partagé avec les preuves de réception #980 ; aucun montant financier n'est converti en `number` JavaScript.

Les ouvertures utilisent les observations figées #977. LEVEL contient déjà BATCH : la quantité CRP correspond au niveau utilisable moins les lots appartenant aux clients. Une réservation ne réduit pas cette quantité. Les codes client restent opaques et sensibles à leur casse. Un prix historique absent demeure inconnu. Les incohérences de lots, d'unité ou de précision bloquent la publication financière de l'article ; elles ne modifient aucun stock physique.

## Ordre et transaction

La séquence identity du journal n'est **pas** un ordre de commit. Lire les entrées supérieures au dernier curseur sans barrière pourrait manquer une séquence inférieure encore non commitée. Le worker ouvre une transaction **READ COMMITTED**, prend un verrou advisory Stock et le contrôle du projecteur, puis un verrou de relation **SHARE sur le seul journal** avant de lire la fenêtre. Le verrou attend les insertions en cours et empêche les nouvelles captures jusqu'au commit du lot. Aucun niveau, lot ou ligne physique n'est verrouillé. Une isolation REPEATABLE READ antérieure à cette barrière serait incorrecte.

Les ouvertures immuables sont rapprochées avant la barrière. Une fenêtre lit au plus 250 mouvements, 100 par défaut ; la boucle s'arrête entre deux mouvements après deux secondes. Le délai de verrou est de 500 ms et celui d'une instruction de huit secondes. Une contention laisse tout le lot inchangé pour le prochain passage. Une anomalie permanente de précision est isolée par savepoint et enregistrée comme UNRESOLVED ; une erreur SQL ou inattendue annule le lot entier.

Toutes les écritures, soldes, répartitions et le curseur sont commités ensemble. Un accusé de commit perdu détruit la connexion ; le prochain passage repart du curseur durable, sans rejouer une liste RAM. Les guards refusent les modifications/suppressions des preuves, un état sans son entrée immuable, une rupture de chaîne ou un curseur passant un mouvement sans entrée.

## Acquisitions, transferts et retours

Les prix proviennent uniquement de la source #980 figée avec la réception. Commande confirmée, article, unité, conversion, quantité et devise doivent concorder. Le prix reste DECLARED tant que la facture contrôlée n'est pas raccordée. Prix catalogue, dernier coût physique et taux de change supposé ne sont jamais des solutions de remplacement.

Les forfaits de ligne se répartissent sur un curseur cumulatif de quantité reçue, borné à la quantité commandée. Il est avancé une seule fois par source réception, indépendamment des portions et propriétaires. Les bases sont normalisées en décimal/unité/devise. Une base modifiée, un ancien reçu sans preuve ou une source précédente non comptée rend la répartition inconnue. Le reliquat final est exact. Le transport d'en-tête et les devises étrangères demandent encore leurs adaptateurs.

Un transfert est neutre seulement après lecture séparée de ses trois preuves complètes : parent, OUT et IN, mêmes périmètres et quantités. La pagination n'est pas une preuve de complétude. Les trois événements reçoivent chacun une entrée neutre, sans acquisition ni consommation en double.

Une inversion explicite doit trouver l'entrée originale exacte, antérieure, de même article/propriétaire/unité/devise et de sens opposé. Les retours reprennent sa valeur, avec un curseur cumulatif plafonné et le reliquat d'arrondi final. L'annulation d'une réception retire son montant original, pas le CUMP courant. Une valeur négative résultante reste inconnue.

## Activation et suite requise

Le worker lit PREPARED et quitte sans écriture de valorisation. Le présent lot n'active pas le mode ACTIVE. La frontière historique CAPTURE_ONLY #977 reste immuable. Avant activation : adaptateurs des chutes matière, réceptions de fabrication, corrections de facture et transport ; justification structurée des valeurs d'ouverture ; rapprochement avec les quantités physiques courantes ; projection honnête vers Stock/Marges et droits existants. Un solde stocké seul ne suffit pas à publier une fiabilité.

## Validation et récupération

TypeScript, build et compilation des SQL/migration en **ROLLBACK** font partie du contrôle de livraison. Les scénarios métier et concurrence sont préparés dans `docs/testing/stock-cump-projector-983.md`, **non exécutés**, conformément à la demande humaine de recette finale commune. Ils restent nécessaires avant activation.

La migration est additive. Le rollback vide Test/dev refuse tout état actif ou toute preuve financière. Après activation, conserver les tables compatibles avec l'ancien backend ou utiliser la sauvegarde pré-déploiement ; aucune preuve ne doit être effacée pour masquer une erreur.
