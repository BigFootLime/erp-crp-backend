# Liaison des achats aux opérations — complément 2.0.61

Le rattachement est réalisé dans une transaction commune : achat, phase, clé de gamme/opération et exigence de finition canonique. Les PS portent leur désignation courte de finition sur l’opération de sous-traitance, depuis chacun des chemins de confirmation. Les matières se rattachent uniquement à une opération de découpe ; le nom d’opération n’est pas modifié.

Une commande de rattachement sur une ligne existante ne recalcule pas ses valeurs commerciales. Elle vérifie le dossier, la pièce, le type d’opération et l’article ; le code client, les identifiants, quantités, prix et fournisseurs sont conservés. La capacité Méthodes d’écriture d’opération est requise pour cette commande, sur POST comme sur PATCH.

Le réemploi PS suit la résolution existante : un article émis de la même PT peut être appliqué à un autre dossier lorsque ses exigences de procédé sont identiques. Sa spécification et son empreinte originales restent immuables. La spécification de l’exigence de gamme reprend le dossier d’application. Le contrôle de correspondance ignore uniquement les identifiants de dossier et de révision de finition, comme le moteur existant ; une exigence différente ou une opération déjà liée à une autre ligne est refusée.

L’API de gamme expose les matières liées à chaque opération depuis la nomenclature, avec référence et désignation. Le patch `20261105_material_operation_links_1833.sql` adapte les gardes de scope et empêche de transformer un type d’opération en une nature incompatible avec ses achats liés. Aucun nouveau tarif ni nouvelle obligation de programmation n’est activé.

Le rapprochement des données déjà saisies est sauvegardé et audité. Seules les opérations modifiables sont concernées ; aucun instantané d’OF figé ni article émis n’est réécrit. Les rapprochements automatiques exigent une seule opération compatible et une seule ligne candidate pour le dossier ; les cas ambigus restent à choisir dans le popup. Aucune suite de tests n’est exécutée sur instruction utilisateur.
