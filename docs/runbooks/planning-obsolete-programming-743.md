# Charge de programmation après changement d’indice

La lecture du planning ne propose plus une programmation TODO d’un indice obsolète lorsque celle-ci n’a ni engagement, ni verrou, ni OF consommateur encore actif. La tâche et son historique restent en base. Les programmations engagées, verrouillées, commencées ou terminées restent visibles, ainsi que celles nécessaires à des OF qui conservent l’ancien indice.

Le libellé comporte l’indice externe et le numéro de révision interne pour distinguer deux révisions portant toutes deux A. Aucun changement de statut, annulation ou déplacement automatique n’est effectué.

Recette de référence : entretoise révision interne 1 obsolète sans OF consommateur, révision interne 2 applicable avec OF852. Une seule tâche non engagée doit être proposée. Le créneau engagé de Thomas pour la pièce support reste visible. Filtrer la file sur « Préparer le programme », calculer avec le bouton automatique, examiner la comparaison puis valider. Aucune migration.

Contrôles : TypeScript, tests existants de qualification des ressources ; comportement réel vérifié exclusivement dans l’interface cerp_test. UI-GOV / PROD-PREP-GROUP-01.
