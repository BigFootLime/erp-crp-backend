# Plan applicable sur le poste tablette — #872 / interface #1152

Le poste utilisait le premier fichier historique de la pièce, sans preuve de rattachement à la révision figée. Il ignorait les plans GED qui constituent désormais le dossier applicable.

Le dossier et la file d’opérations utilisent la même sélection : rôle PLAN_CLIENT dans l’instantané de l’OF, identifiant exact de version GED, empreinte exacte du blob, lien vers la version de pièce figée, analyse antivirus propre et fichier libéré. Une ancienne version devenue OBSOLETE reste consultable pour l’OF qui l’a conservée ; aucune lecture de current_version_id ne remplace le plan.

Le téléchargement conserve le chemin GED authentifié existant et ses contrôles d’accès au parent, au fichier et à son empreinte. Aucun chemin disque ni URL publique n’est communiqué. Un ancien fichier sans version applicable explicite reste consultable dans les documents historiques mais n’est pas annoncé comme plan garanti.

Compilation backend et PREPARE/EXPLAIN des deux requêtes réelles au rôle cerp_app avant publication. Les tests de régression (version étrangère, fichier sans rattachement) sont préparés, leur exécution et la recette tablette sont différées à la fin du chantier suivant la demande de Keenan.

Recette finale : OF Test avec PLAN_CLIENT GED figé, évolution ultérieure du plan, ancien OF gardant les octets précédents, nouveau dossier utilisant la nouvelle version, refus de fichier en quarantaine ou d’accès insuffisant ; aucun démarrage de production nécessaire pour montrer le plan.
