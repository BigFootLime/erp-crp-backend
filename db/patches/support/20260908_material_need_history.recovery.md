# Récupération — historique de préparation matière

La contrainte d’identité est remplacée par une unicité identique limitée à la préparation courante. Aucune donnée ni référence historique n’est supprimée. Le déploiement doit suivre immédiatement avec le code utilisant cette unicité partielle : l’ancienne clause ON CONFLICT de préparation n’est plus compatible.

Sauvegarder avant migration, maintenir les actions matière indisponibles pendant la bascule et vérifier l’index sous cerp_app. Après une nouvelle préparation, ne pas rétablir l’ancienne contrainte globale : plusieurs préparations historiques sont légitimes. Corriger en avant, avec les actions de préparation désactivées en cas d’incident. Les écritures historiques et engagements restent conservés.
