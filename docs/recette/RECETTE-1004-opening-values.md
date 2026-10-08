# Recette 1004 — Valeur documentée du stock d'ouverture

État : **PRÉPARÉE, NON EXÉCUTÉE**. À intégrer à la recette commune finale avant activation financière. Utiliser des données jetables identifiées en Base test. Aucune déclaration d'un montant réel par l'agent.

1. Une ouverture LEVEL de 100 avec deux BATCH de 40 entreprise et 30 client propose 70 entreprise, pas 170 ni 100. Les réservations ne changent pas 70. Deux magasins de même unité se cumulent ; des unités distinctes ne se convertissent pas.
2. Capture ou SHA altéré, enfant sans LEVEL, unité divergente, propriétaire illisible, dépréciation incohérente, négatif, précision excessive, plus de 10 000 observations ou preuve dépassant 2 Mo : aucune quantité valorisable proposée. Un article sans ouverture ne propose aucun montant implicite.
3. Sélectionner un document actif de cet article et déclarer un total EUR avec la proposition SHA. Contrôler l'acteur, la quantité, le montant, les deux SHA et l'audit dans une même transaction. L'ouverture reste DECLARED. Un zéro explicite est possible et doit rester déclaré ; ce n'est pas une donnée manquante.
4. Aucun accès sans authentification/module autorisé. L'accès reporting seul permet la lecture suivant la politique existante, jamais une déclaration. Opérateur/méthodes sans capacité `snapshot` : refus d'écriture. Les réponses sont `no-store` et ne contiennent ni chemin serveur ni hash de demande interne.
5. UUID identique, même acteur et corps : résultat idempotent. Même UUID et acteur/corps différent : 409. Deux UUID concurrents pour un même périmètre : une seule base, aucune double écriture. Timeout/verrou : 409 et reprise de la même demande. Audit ou INSERT en échec : transaction annulée.
6. Document inactif, retiré, non lié à l'article ou SHA changé : 409. Aucun montant/quantité ne peut être injecté par des champs supplémentaires, ni unité alias arbitraire, devise ou propriétaire libre.
7. Initialisation et déclaration simultanées : le verrou du contrôle empêche une approbation tardive. Refus si ACTIVE, initialisé, curseur engagé ou article déjà projeté. Les retries déjà enregistrés demeurent idempotents après initialisation.
8. Dans une génération isolée de test, après activation explicitement approuvée, contrôler une entrée OPENING et son solde exact. Quantité, unité, devise, propriétaire, IDs d'ouverture, SHA ou montant divergents : garde SQL refuse. UPDATE/DELETE/TRUNCATE de base : refus. Réception, sortie et annulation conservent la chaîne, sans modifier les quantités physiques.
9. Base manquante/invalide : valeur UNKNOWN, jamais prix actuel ni zéro inventé. Stock client : aucune consommation de base entreprise. Erreur SQL réelle : propagée, sans faux succès monétaire.
10. Retour arrière manuel : refus si une base ou une entrée justifiée existe ; conserver les preuves. Sur schéma vide, restauration exacte de la garde #983 avant retrait des nouvelles structures.

Les contrôles techniques de déploiement ne remplacent aucun de ces scénarios. Les cinq fixtures Node sont des adaptateurs simulés et validators, pas une preuve PostgreSQL.
