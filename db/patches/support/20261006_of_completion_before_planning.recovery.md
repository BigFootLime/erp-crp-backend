# Récupération — complétude OF avant planning

Le patch remplace une fonction de garde et retire le déclencheur qui invalidait
le dossier après retrait d’un créneau. Il ne supprime aucune ligne métier et ne
réécrit aucun snapshot ni visa existant. Les règles v1 restent identifiées comme
v1 ; les nouvelles validations portent la version 2.

Avant application : conserver la sauvegarde vérifiée DB + GED, la définition de
la fonction actuelle, les six déclencheurs et les SHA des images en service.
Exécuter le preflight, le patch puis le verify dans cerp_test avant cerp_prod.

En cas d’incident : arrêter la promotion et revenir aux images précédentes.
Une restauration en production exige une décision humaine explicite et la
preuve de restauration dans une base neuve ; aucun rollback SQL improvisé.
La répétition isolée doit vérifier le changement de garde et la conservation de
la validation après une modification de créneau, sans démarrage réel.
