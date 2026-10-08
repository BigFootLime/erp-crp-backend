# ADR-0980 — Preuves d’acquisition des réceptions

Statut : capture prête à livrer, CUMP non activé. Suite #977, tâche métier 278, issue #980.

Le journal Stock #977 ne transporte pas les prix de commande et les entrées fournisseur ont un coût nul. La nouvelle migration conserve les faits d’acquisition dans une table append-only distincte, reliée à l’empreinte du mouvement. Elle ne modifie pas la migration #977 déjà déployée et ne reconstitue aucun ancien prix.

La capture démarre à sa propre frontière. Elle se déclenche dans la transaction du journal Stock différé, lorsque les liens réception/mouvement et les portions sont terminés. Quantités PostgreSQL, conversion figée, unités, article, propriétaire, commande et fournisseur, devise, prix, remise, frais de ligne et transport sont conservés. Aucune écriture financière d’un formulaire n’est acceptée. Les prix observés sont **déclarés**, sans prétendre être une facture approuvée. Aucun verrou tardif sur les commandes n’est ajouté au circuit physique.

Le résolveur interne contrôle les périmètres, les quantités et la conversion. Une portion corrobore une réception ; les deux ne sont pas additionnées. Une prestation sous-traitée sur un article différent, une propriété client, un transport non alloué, une devise différente ou un prix nul par défaut laissent le montant inconnu. Il n’invente ni gratuité ni conversion monétaire. Une facture reliée et contrôlée pourra fournir une preuve distincte.

Le forfait/minimum déjà intégré dans `commande_fournisseur_ligne.frais_ht` ne s’ajoute pas une seconde fois depuis le catalogue. Son allocation nécessite le curseur transactionnel du futur projecteur Stock, par ligne de commande. La différence entre deux allocations cumulées arrondies, plafonnées à la quantité commandée, préserve le montant exact sur des réceptions partielles et ne dépasse jamais le forfait, même en sur-réception. Aucun total de réception mutable ne tient lieu de ce curseur. Les frais de transport de l’en-tête attendent une règle d’allocation entre lignes.

La somme exacte est la source de valorisation. Le coût unitaire n’est qu’un dérivé affichable et peut rester nul s’il dépasse la précision supportée. Les calculs utilisent du texte décimal PostgreSQL et BigInt, sans nombre JavaScript financier.

Restent à raccorder : état/projecteur sous verrous, curseurs de frais, traitement des ouvertures inconnues, transformations et retours avec valeur d’origine, corrections de valeur par facture, projections Stock/Marges et justification contrôlée. **La capture seule ne valorise pas les sorties, ne publie pas de CUMP et ne suffit pas à annoncer le flux terminé.**

Recette préparée dans `docs/testing/receipt-acquisition-evidence-980.md`. Les scénarios métier restent réservés à la recette globale finale demandée par l’utilisateur.

Validation de livraison : TypeScript et build/OpenAPI (1 422 opérations) passent. Le DDL, les deux diagnostics et les deux SELECT de capture sont compilés sous `cerp_app` sur Test et Production, dans une transaction ROLLBACK. Aucune commande métier ni recette n’a été exécutée.
