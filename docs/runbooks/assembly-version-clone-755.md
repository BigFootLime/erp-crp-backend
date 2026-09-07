# Révisions d'assemblages — #755

La recette manuelle du 7 septembre 2026 a révélé un conflit `ux_ptec_nom_parent_rang` lors de la copie d'une nomenclature versionnée. Le rang est unique par pièce, toutes versions confondues. La copie conservait le rang de la source et échouait, y compris en choisissant un nouvel indice externe.

Le clonage réserve désormais de nouveaux rangs après le maximum de la pièce, dans l'ordre relatif de la source. Il conserve composants, versions des composants, articles, quantités, repères et désignations. Un verrou transactionnel par pièce est partagé avec les ajouts et modifications de nomenclature. La version source reste inchangée. Aucun patch de schéma ni reprise de données n'est nécessaire.

Un conflit de contrainte restant n'est plus systématiquement présenté comme un indice déjà existant. La transaction est annulée intégralement.

Validation : tests ciblés des versions et de la transaction ; reprise manuelle du palier de recette et comparaison des composants après déploiement. Les tests de repository ne remplacent pas cette preuve PostgreSQL obtenue par l'interface.

Récupération : revenir au commit serveur précédent, sans suppression de versions créées. Les données utilisent le même schéma.
