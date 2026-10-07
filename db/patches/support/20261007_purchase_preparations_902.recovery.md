# Préparations d’achat avant fournisseur — WP-284 / #902

Migration additive : aucun stock, aucune allocation, aucun ordre d’achat existant modifié.

Avant Test puis Production : sauvegarde PostgreSQL custom vérifiée par son empreinte et son catalogue ; préflight, application par le runner canonique, verify sous le rôle de runtime, replay sans nouvelle migration et compilation SQL. Conserver les anciennes releases. Les checks de migration et de compilation ne constituent pas la recette métier différée par Keenan.

Les deux tables distinguent demande préparée, brouillon fournisseur, attendu et stock physique. `scope_key` identifie la source/version de l’OF ou l’article partagé GLOBAL_PACK. Quantité inconnue = NULL avec action explicite. Les événements sont immuables ; les préparations ne se suppriment pas. La matière client n’entre pas dans ce registre.

Repli préféré : revenir au binaire précédent en conservant le schéma et toute l’histoire. Le script de retrait ne s’utilise que tables vides, runtime arrêté ; il refuse de supprimer une préparation ou un événement. Ne jamais restaurer une sauvegarde au-dessus d’écritures industrielles postérieures sans décision de réconciliation.

Après déploiement : vérifier les versions des interfaces et backends Test/Prod, santé prête, paramètres existants des terminaux conservés. Aucun achat réel, email, réception ou mouvement de stock n’est requis pour cette bascule.
