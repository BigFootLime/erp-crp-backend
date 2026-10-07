# WP275 — homologation par domaine d’achat

Backend #852 ; frontend #1134 ; note N15. Le contrôle global L7 ignorait les décisions de domaine : une homologation globale valide pouvait permettre une prestation suspendue.

Les transitions soumission, approbation et envoi, la préparation documentaire et la réémission officielle relisent les décisions courantes sous verrou fournisseur et commande. La décision globale s’applique toujours ; les décisions des domaines concernés s’appliquent aussi. Les dates sont inclusives, calculées en Europe/Paris. Une suspension, réserve, qualification en cours, refus ou expiration bloque la transaction sans changement de statut.

La catégorie structurée de l’article (matière première, traitement de surface, sous-traitance, consommable) prime sur les types génériques de catalogue et de ligne. Le catalogue précise notamment l’outillage et les services. Une ligne libre non classée reste visible dans le diagnostic ; aucun domaine ni agrément client n’est inventé. Une décision non configurée reste `NOT_CONFIGURED`, avec avertissement, et ne constitue pas une homologation.

`GET /commandes-fournisseurs/:id/qualification` utilise la capacité `read` existante et une transaction cohérente en lecture seule. Il expose les périmètres et décisions nécessaires, sans prix, notes internes ou chemins de stockage. Les écritures recontrôlent sous leurs propres verrous ; le diagnostic n’est pas une autorisation.

Le document préparé conserve chaque décision complète (identifiant, version, statut, référence, périmètre, validité, document lié, dernière modification) et une empreinte de périmètre. L’envoi refuse une préparation devenue obsolète, y compris lorsqu’une décision est modifiée sans changer son numéro de version. L’observation à une autre heure ne rend pas le document obsolète. La preuve est copiée dans `conditions_snapshot` lors de l’envoi et dans le journal de transition. Les PDF officiels conservent le même état dans leur source archivée ; aucune archive historique n’est réécrite. Une ancienne préparation sans preuve exige une régénération lorsqu’une décision applicable existe.

Aucune migration ni nouvelle dépendance. Les preuves documentaires historiques des fournisseurs restent des liens existants ; la matrice client–prestation–fournisseur et ses documents approuvés (N16), évaluations périodiques et commandes ouvertes (N17) restent les sous-lots suivants de WP275.

## Recette regroupée en fin de périmètre

- Homologation globale valide, traitement suspendu : refus ; achat matière non concerné : pas de blocage par le traitement.
- Validité du jour comprise ; achat le lendemain de l’expiration refusé.
- Achat mixte matière/traitement : chaque décision configurée vérifiée.
- Modifier le périmètre ou le justificatif après préparation : envoi refusé, régénération puis nouvel envoi possible si toutes les décisions sont valides.
- Décision manquante / ligne libre : avertissement explicite, aucune approbation déduite.
- Changement de fournisseur après envoi : la preuve figée de la commande reste identique.
- Accès non autorisé : 403 ; commande inexistante : 404 ; refus sans statut/audit métier partiellement accepté.

Les cas de régression sont ajoutés mais leur exécution et la recette métier sont différées jusqu’à la fin des modifications, sur instruction de Keenan. Compilation et préparation de publication restent exécutées avant le déploiement.
