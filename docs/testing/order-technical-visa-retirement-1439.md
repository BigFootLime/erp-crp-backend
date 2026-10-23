# FLOW221 — Commandes sans visa technique supplémentaire

Décision explicite de l’utilisateur du 23/10/2026 : retirer la validation manuelle
Analyse technique de la commande. La préparation technique de l’OF conserve ses
contrôles et ses interdictions de planifier/fabriquer ; aucune conformité qualité
ou validation de dossier n’est inventée.

Le contrat backend retire le checkpoint et son action. L’administratif mène au
stock, les créations et duplications externes commencent à ATTENTE_STOCK ; les
internes commencent au lancement ATTENTE_OF. Les avertissements techniques après
lancement restent sur les OF, sans réouvrir le visa de commande.

Compatibilité : lors de la lecture transactionnelle verrouillée du workflow,
l’ancien checkpoint actif/pending/blocked est repris vers stock, lancement ou
planning selon les preuves existantes (stock déjà contrôlé, OF non annulé,
commande interne). La ligne ancienne est conservée skipped, sans completed_by
ni signature ajoutés. Les notes, échéances et affectations sont conservées sur
le successeur ; un blocage explicite reste bloqué, avec un statut de reprise
adapté. L’événement TECHNICAL_REVIEW_RETIRED explique la politique. Les anciennes
validations terminées restent intactes et ne sont plus proposées dans le flux.

Le statut actuel est ajouté à l’historique par la transition dédiée
technical_review_retired. Aucun ancien événement n’est réécrit. Les commandes
déjà au-delà de cette étape et les blocages d’une autre étape sont inchangés.
La reprise et l’action opérateur utilisent le même verrou de commande, dans une
transaction ; les appels simultanés ne peuvent doubler la reprise.

Pas de patch de schéma ni de changement RBAC. La livraison réutilise le même
code sur Test, production et futures bases Test. Le lot est suivi localement
FLOW221 et par les issues backend #1439 / frontend #1756, sans prétendre avoir
écrit dans Project Office (session non authentifiée).

Vérifications ciblées : 81 cas backend sur les transitions, le stock seul,
la reprise, l’idempotence, les blocages, la suppression initiale et les gardes
de démarrage des opérations. Qualification SQL réelle et reçus de déploiement
à consigner après exécution ; ces tests unitaires ne les remplacent pas.
