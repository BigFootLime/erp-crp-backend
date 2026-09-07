# Exception d'approbation GED — #758

Décision explicite du propriétaire le 7 septembre 2026 : le superutilisateur doit pouvoir approuver ses propres dépôts.

L'exception exige `users.is_superadmin = true` et `users.status = Active`, relus dans la transaction de la base courante. Le libellé de rôle et le JWT ne suffisent pas. Le trigger PostgreSQL contrôle également ce droit et verrouille le compte pendant l'approbation. Les capacités GED, le contrôle antivirus, les transitions, le gel et l'identité réelle restent inchangés. Un commentaire d'approbation et l'événement APPROVE indiquent l'exception et la politique `ged-758`.

La révocation ultérieure du droit empêche une nouvelle auto-approbation ; elle ne réécrit pas une approbation historique et n'empêche pas la publication ou l'obsolescence d'une version déjà figée.

Déploiement : sauvegarder la définition exacte de la fonction et les états des triggers avec le preflight, appliquer le patch sur cerp_test puis cerp_prod, exécuter le verify. Celui-ci n'écrit que dans une table temporaire ; aucun document ni utilisateur métier n'est modifié. Après déploiement serveur, approuver et publier les plans de recette exclusivement par l'interface.

Récupération : restaurer la définition de fonction sauvegardée et le serveur précédent. Avant de revenir à l'ancienne règle stricte, examiner les auto-approbations créées depuis la bascule : elles restent des preuves historiques et ne doivent pas être supprimées. L'ancienne règle peut refuser leur publication ou obsolescence ; préférer conserver la politique historique et désactiver uniquement de nouvelles exceptions si une récupération opérationnelle l'exige.
