# Synthèse des opérations et achats d’une pièce — #746

La création d’un nouvel indice interne conserve les anciennes gammes et les anciens achats. Ces lignes historiques ne doivent pas gonfler les totaux du résumé ou de la liste des pièces.

Ces deux lectures utilisent désormais le même périmètre : indice applicable en priorité, sinon dernière révision non obsolète ; une seule gamme, courante en priorité. Les achats portent sur cet indice. Les opérations sans gamme et les achats non versionnés restent un repli uniquement lorsqu’aucune définition versionnée correspondante n’existe pour la pièce. Une définition vide ne récupère pas silencieusement les achats d’une ancienne révision.

Les données, historiques, OF figés et écritures ne sont pas modifiés. Aucun correctif de données ni migration n’est nécessaire. La structure des liens d’assemblage n’est pas modifiée par cette correction des totaux.

Recette UI cerp_test : après publication du support en indice A interne 2, sa synthèse doit présenter 2 opérations et 8,60 € d’achats (1 ligne), au lieu de 4 opérations et 17,20 €. Le détail des anciens indices reste accessible. Vérifier également la liste et une pièce sans achat versionné. Contrat existant de liste : 41 tests ; TypeScript sans erreur. Vérification UI à consigner après déploiement.

Retour arrière : redéployer le serveur précédent ; aucun retour de données à effectuer.
